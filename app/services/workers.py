from __future__ import annotations

import asyncio
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Callable

from app.services.risk import RiskRejected, validate_risk_profile


WorkerHandler = Callable[[dict[str, Any]], dict[str, Any]]


def _analysis(context: dict[str, Any]) -> dict[str, Any]:
    value = context.get("market") or {}
    return value.get("analysis") or {}


def _higher(context: dict[str, Any]) -> dict[str, Any]:
    value = context.get("market") or {}
    return (value.get("higher_timeframe") or {}).get("analysis") or {}


def _quality(context: dict[str, Any]) -> dict[str, Any]:
    return (context.get("market") or {}).get("data_quality") or {}


def _candle_rows(context: dict[str, Any]) -> list[Any]:
    value = (context.get("market") or {}).get("candles")
    return value if isinstance(value, list) else []


def _market_feed(context: dict[str, Any]) -> dict[str, Any]:
    market = context.get("market") or {}
    quality = _quality(context)
    primary = quality.get("primary_integrity") or {}
    higher = quality.get("higher_timeframe_integrity") or {}
    contiguous = bool(quality.get("contiguous_closed_candles"))
    enough = bool(quality.get("sufficient_indicator_history"))
    if not market or market.get("status") != "live":
        return {"status": "blocked", "summary": "Live market data is unavailable.",
                "findings": ["No provider data was accepted for this run."]}
    if not contiguous:
        return {"status": "blocked", "summary": "Candle integrity gate failed; downstream trade readiness must remain blocked.",
                "findings": ["Primary and higher-timeframe candles must both be clean and contiguous."],
                "metrics": {"primary_integrity": primary, "higher_timeframe_integrity": higher}}
    return {"status": "complete", "summary": "Closed-candle market feed passed its integrity gate.",
            "findings": ["Only closed OHLCV candles are analyzed.", "No exchange order endpoint is called."],
            "metrics": {"provider": market.get("provider"), "symbol": market.get("symbol"),
                        "timeframe": market.get("timeframe"), "closed_candles": len(_candle_rows(context)),
                        "higher_timeframe": (market.get("higher_timeframe") or {}).get("timeframe"),
                        "sufficient_indicator_history": enough,
                        "last_closed_candle_timestamp_ms": market.get("last_closed_candle_timestamp_ms")}}


def _trend(context: dict[str, Any]) -> dict[str, Any]:
    current, higher = _analysis(context), _higher(context)
    regime = current.get("regime", "UNKNOWN")
    higher_regime = higher.get("regime", "UNKNOWN")
    slope = current.get("ema20_slope_pct")
    direction = "bullish" if regime == "UPTREND" else "bearish" if regime == "DOWNTREND" else "neutral / transition"
    return {"status": "complete" if regime != "INSUFFICIENT_DATA" else "blocked",
            "summary": f"Primary trend is {direction}; higher timeframe is {higher_regime}.",
            "findings": list(current.get("reasons") or [])[:5],
            "metrics": {"primary_regime": regime, "higher_regime": higher_regime,
                        "ema20_slope_pct": slope, "adx14": current.get("adx14")}}


def _momentum(context: dict[str, Any]) -> dict[str, Any]:
    current = _analysis(context)
    state = current.get("momentum_state")
    if not state:
        return {"status": "unavailable", "summary": "Momentum diagnostics are not present in the market payload.",
                "findings": ["Momentum Worker requires MACD and ROC diagnostics from the strategy analyzer."]}
    return {"status": "complete", "summary": f"Momentum state: {state.replace('_', ' ').lower()}.",
            "findings": list(current.get("momentum_reasons") or [])[:6],
            "metrics": {"momentum_score": current.get("momentum_score"),
                        "roc_5_pct": current.get("roc_5_pct"), "roc_10_pct": current.get("roc_10_pct"),
                        "roc_20_pct": current.get("roc_20_pct"), "macd_line": current.get("macd_line"),
                        "macd_signal": current.get("macd_signal"),
                        "macd_histogram": current.get("macd_histogram"),
                        "macd_histogram_slope": current.get("macd_histogram_slope")}}


def _volume(context: dict[str, Any]) -> dict[str, Any]:
    current = _analysis(context)
    ratio = current.get("volume_ratio_20")
    if ratio is None:
        return {"status": "unavailable", "summary": "A comparable closed-bar volume baseline is unavailable.",
                "findings": ["The Worker will not infer buy/sell pressure from missing volume data."]}
    try:
        numeric_ratio = float(ratio)
    except (TypeError, ValueError, OverflowError):
        return {"status": "blocked", "summary": "Volume ratio is invalid.", "findings": []}
    label = "elevated" if numeric_ratio >= 1.25 else "weak" if numeric_ratio < 0.65 else "near baseline"
    return {"status": "complete", "summary": f"Recent closed-bar volume is {label} versus its prior baseline.",
            "findings": ["Volume alone does not establish buyer or seller control."],
            "metrics": {"volume_ratio_20": numeric_ratio, "comparison": "recent 20 bars / preceding 20 bars"}}


def _timeframe(context: dict[str, Any]) -> dict[str, Any]:
    market = context.get("market") or {}
    confluence = market.get("timeframe_confluence", "UNKNOWN")
    higher = market.get("higher_timeframe") or {}
    primary_regime = _analysis(context).get("regime")
    higher_regime = (higher.get("analysis") or {}).get("regime")
    aligned = confluence == "ALIGNED" and primary_regime in {"UPTREND", "DOWNTREND"} and primary_regime == higher_regime
    return {"status": "complete", "summary": "Primary and confirmation timeframes agree." if aligned
            else "Timeframe agreement is mixed or unconfirmed.",
            "findings": ["Higher-timeframe confirmation is required by the existing paper-entry rules."],
            "metrics": {"confluence": confluence, "primary_regime": primary_regime,
                        "higher_timeframe": higher.get("timeframe"), "higher_regime": higher_regime,
                        "aligned": aligned}}


def _pattern(context: dict[str, Any]) -> dict[str, Any]:
    rows = _candle_rows(context)
    current = _analysis(context)
    if len(rows) < 21:
        return {"status": "blocked", "summary": "At least 21 closed candles are required for the 20-bar range check.",
                "findings": [], "metrics": {"closed_candles": len(rows)}}
    try:
        prior = rows[-21:-1]
        highs = [float(row[2]) for row in prior]
        lows = [float(row[3]) for row in prior]
        support, resistance = min(lows), max(highs)
    except (IndexError, TypeError, ValueError, OverflowError):
        return {"status": "blocked", "summary": "Candle rows could not be interpreted safely.", "findings": []}
    breakout = current.get("breakout_20", "UNKNOWN")
    description = {"ABOVE_20_BAR_HIGH": "Close is above the prior 20-bar high.",
                   "BELOW_20_BAR_LOW": "Close is below the prior 20-bar low.",
                   "INSIDE_RANGE": "Close remains inside the prior 20-bar range."}.get(breakout, "Breakout state is unknown.")
    return {"status": "complete", "summary": description,
            "findings": ["This is a range-break diagnostic, not a complete candlestick-pattern classifier."],
            "metrics": {"breakout_20": breakout, "prior_20_bar_support": support,
                        "prior_20_bar_resistance": resistance}}


def _volatility(context: dict[str, Any]) -> dict[str, Any]:
    current = _analysis(context)
    regime = current.get("regime", "UNKNOWN")
    atr_pct = current.get("atr_pct")
    realized = current.get("realized_volatility_pct_approx")
    high = regime == "HIGH_VOLATILITY"
    return {"status": "complete" if atr_pct is not None else "blocked",
            "summary": "High-volatility regime detected." if high else "Volatility diagnostics available; no high-volatility regime flag.",
            "findings": ["Volatility is a risk input, not a directional prediction."],
            "metrics": {"regime": regime, "atr_pct": atr_pct,
                        "realized_volatility_pct_approx": realized}}


def _news_sentiment(context: dict[str, Any]) -> dict[str, Any]:
    return {"status": "unavailable",
            "summary": "News and social-sentiment analysis is not connected.",
            "findings": ["No licensed news feed, social data source, or sentiment model is configured.",
                         "The system will not fabricate a sentiment score."]}


def _strategy(context: dict[str, Any]) -> dict[str, Any]:
    current = _analysis(context)
    signal = current.get("signal", "HOLD")
    reasons = list(current.get("reasons") or [])
    return {"status": "complete" if current else "blocked",
            "summary": f"Existing deterministic strategy result: {signal}.",
            "findings": reasons[:6] or [current.get("reason", "No strategy explanation available.")],
            "metrics": {"signal": signal, "entry_score": current.get("score"),
                        "regime": current.get("regime")}}


def _risk_guard(context: dict[str, Any]) -> dict[str, Any]:
    current = _analysis(context)
    market = context.get("market") or {}
    quality = _quality(context)
    checks: dict[str, bool] = {
        "valid_risk_profile": False,
        "clean_closed_candles": bool(quality.get("contiguous_closed_candles")),
        "sufficient_indicator_history": bool(quality.get("sufficient_indicator_history")),
        "higher_timeframe_aligned": market.get("timeframe_confluence") == "ALIGNED",
        "existing_strategy_candidate": current.get("signal") == "BUY_CANDIDATE",
        "volatility_guard": current.get("regime") != "HIGH_VOLATILITY"
                             and (current.get("atr_pct") is None or float(current.get("atr_pct") or 0) < 8),
    }
    try:
        validate_risk_profile(context.get("risk") or {})
        checks["valid_risk_profile"] = True
        risk_message = "Saved risk profile passed validation."
    except (RiskRejected, TypeError, ValueError) as exc:
        risk_message = str(exc)[:180]
    passed = sum(1 for value in checks.values() if value)
    all_checks_passed = all(checks.values())
    return {"status": "complete" if all_checks_passed else "blocked",
            "summary": f"Read-only preflight: {passed}/{len(checks)} checks passed; this is not an execution approval.",
            "findings": [f"{name.replace('_', ' ')}: {'PASS' if ok else 'NOT PASSED'}" for name, ok in checks.items()]
                        + [risk_message],
            "metrics": {"checks": checks, "checks_passed": passed, "checks_total": len(checks),
                        "execution_authorized": False}}


def _research(context: dict[str, Any]) -> dict[str, Any]:
    market = context.get("market") or {}
    quality = _quality(context)
    primary_count = len(_candle_rows(context))
    higher_count = len(((market.get("higher_timeframe") or {}).get("candles") or []))
    integrity = bool(quality.get("contiguous_closed_candles"))
    sufficient = integrity and primary_count >= 200 and higher_count >= 150
    return {"status": "complete" if sufficient else "blocked",
            "summary": "Closed-candle history is sufficient for a separate strategy research run."
                       if sufficient else "Research readiness is limited by candle integrity or history depth.",
            "findings": ["This Worker checks research readiness only; it does not claim a backtest was run."],
            "metrics": {"primary_closed_candles": primary_count, "higher_closed_candles": higher_count,
                        "research_history_ready": sufficient, "integrity_passed": integrity}}


def _portfolio_monitor(context: dict[str, Any]) -> dict[str, Any]:
    portfolio = context.get("portfolio") or {}
    positions = context.get("open_positions") or []
    return {"status": "complete", "summary": f"Portfolio snapshot loaded with {len(positions)} open paper position(s).",
            "findings": ["This Worker reads the paper ledger only.",
                         "Stop/target execution monitoring remains owned by the existing automation scheduler."],
            "metrics": {"open_positions": len(positions),
                        "open_symbols": [str(row.get("symbol", "")) for row in positions[:10]],
                        "equity_usd": portfolio.get("equity_usd"),
                        "exposure_usd": portfolio.get("exposure_usd"),
                        "unmarked_positions": portfolio.get("unmarked_positions"),
                        "automatic_paper_enabled": bool(context.get("auto_paper_enabled")),
                        "live_trading_enabled": False}}


_WORKERS: tuple[tuple[str, str, str, WorkerHandler], ...] = (
    ("market_feed", "Market Data & Integrity", "Checks provider, closed-candle counts and candle integrity.", _market_feed),
    ("trend", "Trend Analyst", "Reads primary and higher-timeframe trend structure.", _trend),
    ("momentum", "Momentum Analyst", "Reads MACD, histogram slope and ROC diagnostics.", _momentum),
    ("volume", "Volume Analyst", "Compares recent closed-bar volume with its prior baseline.", _volume),
    ("timeframe", "Multi-Timeframe Analyst", "Checks primary and confirmation timeframe agreement.", _timeframe),
    ("pattern", "Breakout & Range Analyst", "Checks the prior 20-bar high/low range.", _pattern),
    ("volatility", "Volatility Analyst", "Reads ATR and realized-volatility diagnostics.", _volatility),
    ("news_sentiment", "News & Sentiment Analyst", "Would analyze connected news and sentiment sources.", _news_sentiment),
    ("strategy", "Strategy Reviewer", "Reports the existing deterministic strategy output.", _strategy),
    ("risk_guard", "Risk Guard", "Runs read-only risk and signal preflight checks.", _risk_guard),
    ("research", "Research Readiness", "Checks whether clean history is available for backtesting.", _research),
    ("portfolio_monitor", "Portfolio & Paper Monitor", "Reads open paper positions and portfolio exposure.", _portfolio_monitor),
)


class WorkerManager:
    """Bounded, read-only specialist analysis fan-out; never submits orders."""

    def __init__(self, concurrency: int = 4, timeout_seconds: float = 4.0, retries: int = 1):
        self.concurrency = max(1, min(int(concurrency), len(_WORKERS)))
        self.timeout_seconds = max(0.25, min(float(timeout_seconds), 15.0))
        self.retries = max(0, min(int(retries), 2))
        self._thread_slots = threading.BoundedSemaphore(self.concurrency)
        self._state_lock = threading.Lock()
        self._active_runs = 0
        self._last_run_at: str | None = None
        self._last_run_status: str | None = None
        self._last_results: dict[str, dict[str, Any]] = {}

    def registry(self) -> dict[str, Any]:
        with self._state_lock:
            active_runs = self._active_runs
            last_run_at = self._last_run_at
            last_run_status = self._last_run_status
            last_results = dict(self._last_results)
        workers = []
        for worker_id, name, description, _handler in _WORKERS:
            availability = "unavailable" if worker_id == "news_sentiment" else "ready"
            last = last_results.get(worker_id) or {}
            workers.append({"id": worker_id, "name": name, "description": description,
                            "availability": availability,
                            "health_status": "unavailable" if availability == "unavailable"
                                             else ("active" if active_runs else (last.get("status") or "idle")),
                            "last_status": last.get("status"),
                            "last_duration_ms": last.get("duration_ms"),
                            "last_summary": (last.get("result") or {}).get("summary"),
                            "execution_mode": "read_only"})
        return {"worker_count": len(workers), "ready_count": sum(x["availability"] == "ready" for x in workers),
                "unavailable_count": sum(x["availability"] == "unavailable" for x in workers),
                "max_concurrency": self.concurrency, "active_runs": active_runs,
                "last_run_at": last_run_at, "last_run_status": last_run_status,
                "workers": workers, "live_trading_enabled": False}

    def _execute_handler(self, handler: WorkerHandler, context: dict[str, Any]) -> dict[str, Any]:
        with self._thread_slots:
            return handler(context)

    async def _run_one(self, spec: tuple[str, str, str, WorkerHandler],
                       context: dict[str, Any], semaphore: asyncio.Semaphore) -> dict[str, Any]:
        worker_id, name, description, handler = spec
        started = time.perf_counter()
        attempts = 0
        async with semaphore:
            while attempts <= self.retries:
                attempts += 1
                try:
                    result = await asyncio.wait_for(
                        asyncio.to_thread(self._execute_handler, handler, context), timeout=self.timeout_seconds
                    )
                    status = str(result.get("status", "complete"))
                    if status not in {"complete", "blocked", "unavailable", "error"}:
                        status = "error"
                        result = {"summary": "Worker returned an unknown status."}
                    return {"id": worker_id, "name": name, "description": description,
                            "status": status, "attempts": attempts,
                            "duration_ms": round((time.perf_counter() - started) * 1000, 2),
                            "result": result}
                except asyncio.TimeoutError:
                    error = f"Worker exceeded {self.timeout_seconds:.2f}s timeout."
                except Exception as exc:  # isolate a faulty specialist from the rest of the team
                    error = f"{type(exc).__name__}: {str(exc)[:160]}"
                if attempts <= self.retries:
                    await asyncio.sleep(0.05 * attempts)
            return {"id": worker_id, "name": name, "description": description,
                    "status": "error", "attempts": attempts,
                    "duration_ms": round((time.perf_counter() - started) * 1000, 2),
                    "result": {"summary": "Worker failed after bounded retries.", "findings": [error]}}

    async def analyze(self, context: dict[str, Any]) -> dict[str, Any]:
        started_at = datetime.now(timezone.utc).isoformat()
        started = time.perf_counter()
        run_id = str(uuid.uuid4())
        with self._state_lock:
            self._active_runs += 1
        try:
            semaphore = asyncio.Semaphore(self.concurrency)
            results = await asyncio.gather(*(self._run_one(spec, context, semaphore) for spec in _WORKERS))
        finally:
            with self._state_lock:
                self._active_runs = max(0, self._active_runs - 1)
        counts = {status: sum(1 for item in results if item["status"] == status)
                  for status in ("complete", "blocked", "unavailable", "error")}
        if counts["error"] == len(results):
            overall = "failed"
        elif counts["error"] or counts["blocked"] or counts["unavailable"]:
            overall = "partial"
        else:
            overall = "complete"
        duration_ms = round((time.perf_counter() - started) * 1000, 2)
        with self._state_lock:
            self._last_run_at = datetime.now(timezone.utc).isoformat()
            self._last_run_status = overall
            self._last_results = {item["id"]: item for item in results}
        return {"run_id": run_id, "started_at": started_at,
                "duration_ms": duration_ms, "status": overall, "worker_count": len(results),
                "max_concurrency": self.concurrency, "counts": counts,
                "workers": results, "mode": "read_only_market_analysis",
                "live_trading_enabled": False, "execution_authorized": False,
                "supervisor_note": "Workers provide independent diagnostics. No worker can authorize or submit an exchange order."}
