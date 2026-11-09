from __future__ import annotations

import asyncio
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Ensure the repository root is importable when this file is run as a script.
REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from app.services.market_data import MarketDataService
from app.settings import settings


MAX_TICKER_AGE_MS = 120_000
# Allow a small exchange/runner clock skew, but reject larger future timestamps.
# The raw negative age remains visible in the report for auditability.
MAX_FUTURE_CLOCK_SKEW_MS = 5_000


def ticker_age_ms(timestamp: Any, now_ms: float) -> float | None:
    try:
        value = float(timestamp)
    except (TypeError, ValueError, OverflowError):
        return None
    if not (value == value and abs(value) != float("inf")):
        return None
    return now_ms - value


def market_is_fresh(market: dict[str, Any], now_ms: float) -> bool:
    if market.get("status") != "live":
        return False
    age = ticker_age_ms(market.get("timestamp"), now_ms)
    return age is not None and -MAX_FUTURE_CLOCK_SKEW_MS <= age <= MAX_TICKER_AGE_MS


def safe_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if number == number and abs(number) != float("inf") else None


def compare_market_sources(
    market: dict[str, Any],
    analysis: dict[str, Any],
    default_ticker_provider: str | None = None,
) -> dict[str, Any]:
    """Require ticker and candle analysis to use the same provider and quote currency."""
    ticker_provider = str(
        market.get("market_data_provider") or default_ticker_provider or ""
    ).strip().lower()
    strategy_provider = str(
        analysis.get("provider") or analysis.get("market_data_provider") or ""
    ).strip().lower()
    ticker_quote = str(market.get("quote_currency") or "").strip().upper()
    strategy_quote = str(
        analysis.get("quote_currency") or analysis.get("strategy_quote_currency") or ""
    ).strip().upper()

    issues: list[str] = []
    if not ticker_provider:
        issues.append("ticker_provider_missing")
    if not strategy_provider:
        issues.append("strategy_provider_missing")
    if ticker_provider and strategy_provider and ticker_provider != strategy_provider:
        issues.append(f"provider_mismatch:ticker={ticker_provider},strategy={strategy_provider}")
    if not ticker_quote:
        issues.append("ticker_quote_currency_missing")
    if not strategy_quote:
        issues.append("strategy_quote_currency_missing")
    if ticker_quote and strategy_quote and ticker_quote != strategy_quote:
        issues.append(f"quote_currency_mismatch:ticker={ticker_quote},strategy={strategy_quote}")

    return {
        "matched": not issues,
        "ticker_provider": ticker_provider or None,
        "strategy_provider": strategy_provider or None,
        "ticker_quote_currency": ticker_quote or None,
        "strategy_quote_currency": strategy_quote or None,
        "issues": issues,
    }


async def collect_scan() -> dict[str, Any]:
    service = MarketDataService(settings)
    now_ms = datetime.now(timezone.utc).timestamp() * 1000
    tickers = await service.cex_tickers()
    markets = tickers.get("markets", []) if isinstance(tickers, dict) else []
    by_symbol = {str(row.get("symbol")): row for row in markets if isinstance(row, dict)}
    symbols = list(settings.cex_symbols)
    analyses = await asyncio.gather(
        *(service.cex_strategy_data(symbol, timeframe="1h", limit=300) for symbol in symbols),
        return_exceptions=True,
    )
    rows: list[dict[str, Any]] = []
    for symbol, analysis_result in zip(symbols, analyses):
        market = by_symbol.get(symbol, {"symbol": symbol, "status": "missing"})
        fresh = market_is_fresh(market, now_ms)
        if isinstance(analysis_result, BaseException):
            analysis = {"status": "error", "error": str(analysis_result)[:200]}
        else:
            analysis = analysis_result
        detail = analysis.get("analysis", {}) if isinstance(analysis, dict) else {}
        higher_payload = analysis.get("higher_timeframe") or {} if isinstance(analysis, dict) else {}
        higher = higher_payload.get("analysis", {}) if isinstance(higher_payload, dict) else {}
        confirmation_timeframe = higher_payload.get("timeframe", "unknown") if isinstance(higher_payload, dict) else "unknown"
        quality = analysis.get("data_quality", {}) if isinstance(analysis, dict) else {}
        source_match = compare_market_sources(
            market, analysis, tickers.get("exchange") if isinstance(tickers, dict) else settings.cex_exchange
        )
        analysis_ready = (
            fresh
            and analysis.get("status") == "live"
            and bool(quality.get("contiguous_closed_candles", False))
            and source_match["matched"]
        )
        safe_signal = detail.get("signal", "HOLD")
        if not analysis_ready:
            safe_signal = "HOLD"
        signal_block_reasons = list(source_match["issues"])
        if not fresh:
            signal_block_reasons.append("ticker_stale_or_unavailable")
        if analysis.get("status") != "live":
            signal_block_reasons.append("strategy_data_unavailable")
        if not quality.get("contiguous_closed_candles", False):
            signal_block_reasons.append("candle_integrity_not_confirmed")
        bid = safe_float(market.get("bid"))
        ask = safe_float(market.get("ask"))
        mid = (bid + ask) / 2 if bid is not None and ask is not None and bid > 0 and ask >= bid else None
        spread_bps = ((ask - bid) / mid * 10_000) if mid else None
        rows.append({
            "symbol": symbol,
            "ticker_status": market.get("status"),
            "ticker_age_ms": ticker_age_ms(market.get("timestamp"), now_ms),
            "ticker_fresh": fresh,
            "last": safe_float(market.get("last")),
            "bid": bid,
            "ask": ask,
            "spread_bps": spread_bps,
            "quote_volume": safe_float(market.get("quote_volume")),
            "ticker_provider": source_match["ticker_provider"],
            "strategy_provider": source_match["strategy_provider"],
            "ticker_quote_currency": source_match["ticker_quote_currency"],
            "strategy_quote_currency": source_match["strategy_quote_currency"],
            "providers_match": source_match["matched"],
            "analysis_ready": analysis_ready,
            "signal_block_reasons": signal_block_reasons,
            "signal": safe_signal,
            "score": detail.get("score", 0),
            "regime_1h": detail.get("regime", "UNKNOWN"),
            "confirmation_timeframe": confirmation_timeframe,
            "regime_confirmation": higher.get("regime", "UNKNOWN"),
            "timeframe_confluence": analysis.get("timeframe_confluence", "UNKNOWN") if isinstance(analysis, dict) else "UNKNOWN",
            "data_quality": quality,
            "analysis_status": analysis.get("status", "error") if isinstance(analysis, dict) else "error",
            "error": analysis.get("error") if isinstance(analysis, dict) else str(analysis)[:200],
            "reason": detail.get("reason", ""),
        })

    live_count = sum(1 for row in rows if row["ticker_fresh"] and row["analysis_status"] == "live")
    analysis_ready_count = sum(1 for row in rows if row["analysis_ready"])
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "mode": "READ_ONLY_MARKET_SCAN",
        "exchange": settings.cex_exchange,
        "symbols": symbols,
        "live_symbol_count": live_count,
        "analysis_ready_count": analysis_ready_count,
        "ticker_provider_status": tickers.get("status", "error") if isinstance(tickers, dict) else "error",
        "results": rows,
        "safety": {
            "orders_sent": False,
            "paper_trades_created": False,
            "api_keys_required": False,
            "note": "This scheduled workflow only reads public market data and writes a report. It does not execute trades or persist a paper portfolio."
        },
    }


def render_markdown(report: dict[str, Any]) -> str:
    lines = [
        "# Scheduled crypto market scan",
        "",
        f"- Generated: {report['generated_at']}",
        f"- Exchange: {report['exchange']}",
        f"- Mode: `{report['mode']}`",
        f"- Fresh symbols with strategy data: {report['live_symbol_count']}/{len(report['results'])}",
        f"- Provider/quote-consistent analysis-ready symbols: {report['analysis_ready_count']}/{len(report['results'])}",
        "",
        "| Symbol | Fresh | Last | Primary signal | Score | Primary regime | Confirmation | Source match | Spread (bps) |",
        "|---|---:|---:|---|---:|---|---|---|---:|",
    ]
    for row in report["results"]:
        lines.append(
            f"| {row['symbol']} | {'yes' if row['ticker_fresh'] else 'no'} | "
            f"{row['last'] if row['last'] is not None else '—'} | {row['signal']} | "
            f"{row['score']} | {row['regime_1h']} | {row['confirmation_timeframe']} {row['regime_confirmation']} | "
            f"{'match' if row['providers_match'] else 'MISMATCH'} | "
            f"{round(row['spread_bps'], 2) if row['spread_bps'] is not None else '—'} |"
        )
        if row.get("error") or row.get("reason") or row.get("signal_block_reasons"):
            notes = [row.get("error"), row.get("reason"), *row.get("signal_block_reasons", [])]
            note = "; ".join(item for item in notes if item)
            lines.append(f"\n**{row['symbol']} note:** {note}\n")
    lines.extend([
        "",
        "## Safety",
        "",
        "- Read-only public market data; no exchange credentials.",
        "- No real orders and no paper positions are created by this scheduled scanner.",
        "- Stale ticker data, candle-integrity failures, provider mismatches or quote-currency mismatches are downgraded to HOLD.",
        "- A fallback provider may supply research candles, but its signals are blocked unless ticker and candle provider plus quote currency match.",
        "- GitHub scheduled runs are best-effort, not a continuous 24/7 trading server.",
        "",
    ])
    return "\n".join(lines)


async def main() -> int:
    report = await collect_scan()
    output_dir = Path(os.getenv("SCAN_OUTPUT_DIR", "artifacts"))
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "market-scan.json").write_text(json.dumps(report, indent=2, allow_nan=False), encoding="utf-8")
    (output_dir / "market-scan.md").write_text(render_markdown(report), encoding="utf-8")
    print(render_markdown(report))
    if report["live_symbol_count"] == 0:
        print("ERROR: no symbol produced both a fresh ticker and valid live strategy data.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
