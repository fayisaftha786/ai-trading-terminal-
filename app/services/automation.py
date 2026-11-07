from __future__ import annotations

from datetime import datetime, timedelta, timezone
from math import isfinite
from typing import Any

from app.services.paper import PaperBroker
from app.services.risk import RiskRejected, validate_risk_profile
from app.storage import Storage


class AutoPaperEngine:
    """Conservative, CEX-only automatic paper execution. Never places live orders."""

    MAX_SPREAD_BPS = 25.0
    MIN_QUOTE_VOLUME_USD = 1_000_000.0
    MIN_TOP10_DEPTH_QUOTE = 5_000.0
    MAX_ORDERBOOK_AGE_MS = 15_000
    MAX_FEED_AGE_MS = 120_000
    MAX_PRIMARY_CANDLE_AGE_MS = 90 * 60_000
    MAX_CONFIRM_CANDLE_AGE_MS = 5 * 60 * 60_000
    MAX_ENTRIES_PER_DAY = 3
    SYMBOL_COOLDOWN = timedelta(hours=4)

    def __init__(self, db: Storage, broker: PaperBroker):
        self.db = db
        self.broker = broker

    @staticmethod
    def _finite_number(value: Any) -> float | None:
        try:
            number = float(value)
        except (TypeError, ValueError, OverflowError):
            return None
        return number if isfinite(number) else None

    @classmethod
    def _valid_price(cls, value: Any) -> bool:
        number = cls._finite_number(value)
        return number is not None and number > 0

    @classmethod
    def _score(cls, candidate: dict[str, Any]) -> int:
        value = cls._finite_number((candidate.get("analysis") or {}).get("score"))
        return max(0, min(100, int(value))) if value is not None else 0

    def _eligible(
        self, item: dict[str, Any], now_ms: float, risk_profile: dict[str, Any]
    ) -> tuple[bool, str, float]:
        ticker = item.get("ticker") or {}
        primary = item.get("analysis") or {}
        symbol = str(ticker.get("symbol") or item.get("symbol") or "")
        quote_asset = symbol.split("/")[-1].split(":")[0].upper() if "/" in symbol else ""
        if quote_asset not in {"USD", "USDT", "USDC", "FDUSD"}:
            return False, "unsupported_non_usd_quote_asset", 0.0
        higher = item.get("higher_timeframe") or {}
        stamp = ticker.get("timestamp")
        if ticker.get("status") != "live":
            return False, "ticker_not_live", 0.0
        if not self._valid_price(ticker.get("last")) or not self._valid_price(ticker.get("bid")) or not self._valid_price(ticker.get("ask")):
            return False, "missing_bid_ask_or_last", 0.0
        stamp_value = self._finite_number(stamp)
        if stamp_value is None:
            return False, "missing_exchange_timestamp", 0.0
        age = now_ms - stamp_value
        if age < -5_000 or age > self.MAX_FEED_AGE_MS:
            return False, "stale_or_future_ticker", 0.0
        bid = self._finite_number(ticker.get("bid"))
        ask = self._finite_number(ticker.get("ask"))
        if bid is None or ask is None:
            return False, "invalid_bid_or_ask", 0.0
        if ask < bid:
            return False, "crossed_market_quote", 0.0
        mid = (bid + ask) / 2
        spread_bps = ((ask - bid) / mid) * 10_000 if mid > 0 else float("inf")
        if spread_bps > self.MAX_SPREAD_BPS:
            return False, "spread_too_wide", spread_bps
        retrieved_stamp = self._finite_number(ticker.get("orderbook_retrieved_at_ms"))
        exchange_book_stamp_raw = ticker.get("orderbook_timestamp_ms")
        if exchange_book_stamp_raw is not None:
            book_stamp = self._finite_number(exchange_book_stamp_raw)
        else:
            # Some exchanges omit the order-book timestamp in CCXT. In that case
            # use only the local response-received time and label the weaker provenance.
            book_stamp = retrieved_stamp
        bid_depth = self._finite_number(ticker.get("bid_depth_quote"))
        ask_depth = self._finite_number(ticker.get("ask_depth_quote"))
        if retrieved_stamp is None or book_stamp is None or bid_depth is None or ask_depth is None:
            return False, "orderbook_depth_unavailable", spread_bps
        if bid_depth < 0 or ask_depth < 0:
            return False, "invalid_orderbook_depth", spread_bps
        book_age = now_ms - book_stamp
        if book_age < -1_000 or book_age > self.MAX_ORDERBOOK_AGE_MS:
            return False, "orderbook_snapshot_stale", spread_bps
        if min(bid_depth, ask_depth) < self.MIN_TOP10_DEPTH_QUOTE:
            return False, "orderbook_depth_below_minimum", spread_bps
        quote_volume = self._finite_number(ticker.get("quote_volume"))
        if quote_volume is None or quote_volume < self.MIN_QUOTE_VOLUME_USD:
            return False, "quote_volume_below_minimum", spread_bps
        primary_candle = item.get("last_closed_candle_timestamp_ms")
        confirm_candle = item.get("higher_timeframe_last_closed_candle_timestamp_ms")
        primary_stamp = self._finite_number(primary_candle)
        confirm_stamp = self._finite_number(confirm_candle)
        if primary_stamp is None or confirm_stamp is None:
            return False, "closed_candle_timestamp_missing", spread_bps
        primary_age = now_ms - (primary_stamp + 3_600_000)
        confirm_interval_ms = self._finite_number(item.get("higher_timeframe_interval_ms"))
        if confirm_interval_ms is None or confirm_interval_ms <= 0:
            confirm_interval_ms = 4 * 3_600_000
        confirm_max_age_ms = max(self.MAX_CONFIRM_CANDLE_AGE_MS, confirm_interval_ms + 3_600_000)
        confirm_age = now_ms - (confirm_stamp + confirm_interval_ms)
        if primary_age < -1_000 or primary_age > self.MAX_PRIMARY_CANDLE_AGE_MS:
            return False, "primary_closed_candle_stale", spread_bps
        if confirm_age < -1_000 or confirm_age > confirm_max_age_ms:
            return False, "higher_timeframe_closed_candle_stale", spread_bps
        score = self._finite_number(primary.get("score"))
        if primary.get("signal") != "BUY_CANDIDATE" or score is None or score < 75 or score > 100:
            return False, "no_primary_buy_candidate", spread_bps
        if primary.get("regime") != "UPTREND" or higher.get("regime") != "UPTREND":
            return False, "higher_timeframe_not_uptrend", spread_bps
        if item.get("timeframe_confluence") != "ALIGNED":
            return False, "timeframes_not_aligned", spread_bps
        atr_pct = self._finite_number(primary.get("atr_pct"))
        rsi = self._finite_number(primary.get("rsi14"))
        adx = self._finite_number(primary.get("adx14"))
        plus_di = self._finite_number(primary.get("plus_di14"))
        minus_di = self._finite_number(primary.get("minus_di14"))
        if (atr_pct is None or rsi is None or adx is None or plus_di is None or minus_di is None
                or atr_pct < 0 or not 0 <= rsi <= 100 or not 0 <= adx <= 100
                or not 0 <= plus_di <= 100 or not 0 <= minus_di <= 100):
            return False, "missing_or_invalid_volatility_or_momentum_metrics", spread_bps
        if atr_pct >= 5.0 or rsi >= 68.0 or adx < 18.0 or plus_di <= minus_di:
            return False, "volatility_extension_or_trend_strength_guard", spread_bps
        round_trip_cost_bps = 2.0 * (
            float(risk_profile["fee_bps_per_side"])
            + float(risk_profile["slippage_bps"])
        ) + spread_bps
        expected_range_bps = atr_pct * 100.0
        if round_trip_cost_bps <= 0 or expected_range_bps < round_trip_cost_bps * 2.5:
            return False, "expected_range_too_small_vs_estimated_round_trip_cost", spread_bps
        return True, "eligible", spread_bps

    def run(self, candidates: list[dict[str, Any]], marks: dict[str, float], enabled: bool) -> dict[str, Any]:
        raw_risk = self.db.get_risk()
        closed = self.broker.mark_and_close_triggers(marks)
        result: dict[str, Any] = {
            "enabled": enabled,
            "paper_exits": len(closed),
            "paper_entries": [],
            "rejected": [],
            "mode": "paper_only",
        }
        if not enabled:
            result["status"] = "disabled"
            return result
        try:
            risk = validate_risk_profile(raw_risk)
        except RiskRejected as exc:
            result["status"] = "blocked_invalid_risk_profile"
            result["rejected"].append({"reason": str(exc)})
            result["halt_automation"] = True
            return result

        summary = self.db.portfolio_summary(
            marks,
            fee_bps_per_side=float(risk["fee_bps_per_side"]),
            slippage_bps=float(risk["slippage_bps"]),
        )
        if int(summary["unmarked_positions"]) > 0:
            result["status"] = "blocked_unmarked_open_positions"
            result["rejected"].append({"reason": "open_positions_without_fresh_marks"})
            return result
        if float(summary["drawdown_pct_from_peak"]) >= float(risk["max_total_drawdown_pct"]):
            # With fresh marks for every open position, flatten the paper book and request
            # the controller to disable auto-entry until a person re-enables it.
            emergency_closes = []
            for trade in self.db.open_trades():
                mark = marks.get(trade["symbol"])
                if mark is not None:
                    emergency_closes.append(self.broker.close(
                        int(trade["id"]), float(mark), "portfolio_drawdown_circuit_breaker"
                    ))
            result["paper_exits"] += len(emergency_closes)
            result["status"] = "portfolio_drawdown_limit"
            result["halt_automation"] = True
            result["rejected"].append({"reason": "total_portfolio_drawdown_limit_reached"})
            return result

        now = datetime.now(timezone.utc)
        day_start = now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
        entries_today = self.db.count_entries_since(day_start, engine="multi_crypto")
        if entries_today >= self.MAX_ENTRIES_PER_DAY:
            result["status"] = "daily_entry_cap"
            result["rejected"].append({"reason": "daily_automatic_entry_cap_reached"})
            return result

        ordered = sorted(candidates, key=self._score, reverse=True)
        for item in ordered:
            ticker = item.get("ticker") or {}
            symbol = str(ticker.get("symbol") or item.get("symbol") or "")
            eligible, reason, spread_bps = self._eligible(item, now.timestamp() * 1000, risk)
            if not eligible:
                result["rejected"].append({"symbol": symbol, "reason": reason, "spread_bps": round(spread_bps, 2)})
                continue
            if not symbol or self.db.has_open_trade("multi_crypto", symbol):
                result["rejected"].append({"symbol": symbol, "reason": "already_open_or_invalid_symbol"})
                continue
            last_trade = self.db.last_trade_timestamp("multi_crypto", symbol)
            if last_trade:
                try:
                    last_dt = datetime.fromisoformat(last_trade.replace("Z", "+00:00"))
                    if now - last_dt < self.SYMBOL_COOLDOWN:
                        result["rejected"].append({"symbol": symbol, "reason": "symbol_cooldown"})
                        continue
                except ValueError:
                    result["rejected"].append({"symbol": symbol, "reason": "invalid_previous_trade_timestamp"})
                    continue
            if self.db.count_entries_since(day_start, engine="multi_crypto") >= self.MAX_ENTRIES_PER_DAY:
                result["rejected"].append({"symbol": symbol, "reason": "daily_automatic_entry_cap_reached"})
                break
            ask = float(ticker["ask"])
            try:
                trade = self.broker.open_long({
                    "engine": "multi_crypto",
                    "symbol": symbol,
                    "name": symbol,
                    "price_usd": ask,
                    "requested_notional_usd": None,
                    "_portfolio_marks": marks,
                    "_entry_spread_bps": spread_bps,
                    "automation": True,
                    "signal_metadata": {
                        "score": self._score(item),
                        "regime": item["analysis"].get("regime"),
                        "higher_timeframe_regime": item["higher_timeframe"].get("regime"),
                        "spread_bps": round(spread_bps, 2),
                        "quote_volume_usd_24h": ticker.get("quote_volume"),
                        "exchange_timestamp_ms": ticker.get("timestamp"),
                        "orderbook_timestamp_ms": ticker.get("orderbook_timestamp_ms"),
                        "orderbook_timestamp_source": ticker.get("orderbook_timestamp_source", "retrieval_fallback"),
                    },
                })
            except ValueError as exc:
                result["rejected"].append({"symbol": symbol, "reason": str(exc)[:180]})
                continue
            result["paper_entries"].append(trade)
            # One entry per scan makes the execution path simple to audit and rate-limit.
            break

        result["status"] = "completed" if result["paper_entries"] or not result["rejected"] else "no_eligible_entry"
        return result
