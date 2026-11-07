from __future__ import annotations

import asyncio
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.services.market_data import MarketDataService
from app.settings import settings


MAX_TICKER_AGE_MS = 120_000


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
    return age is not None and -5_000 <= age <= MAX_TICKER_AGE_MS


def safe_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if number == number and abs(number) != float("inf") else None


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
        higher = (analysis.get("higher_timeframe") or {}).get("analysis", {}) if isinstance(analysis, dict) else {}
        quality = analysis.get("data_quality", {}) if isinstance(analysis, dict) else {}
        safe_signal = detail.get("signal", "HOLD")
        if not fresh or analysis.get("status") != "live" or not quality.get("contiguous_closed_candles", False):
            safe_signal = "HOLD"
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
            "signal": safe_signal,
            "score": detail.get("score", 0),
            "regime_1h": detail.get("regime", "UNKNOWN"),
            "regime_4h": higher.get("regime", "UNKNOWN"),
            "timeframe_confluence": analysis.get("timeframe_confluence", "UNKNOWN") if isinstance(analysis, dict) else "UNKNOWN",
            "data_quality": quality,
            "analysis_status": analysis.get("status", "error") if isinstance(analysis, dict) else "error",
            "error": analysis.get("error") if isinstance(analysis, dict) else str(analysis)[:200],
            "reason": detail.get("reason", ""),
        })

    live_count = sum(1 for row in rows if row["ticker_fresh"] and row["analysis_status"] == "live")
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "mode": "READ_ONLY_MARKET_SCAN",
        "exchange": settings.cex_exchange,
        "symbols": symbols,
        "live_symbol_count": live_count,
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
        "",
        "| Symbol | Fresh | Last | 1h signal | Score | 1h regime | 4h regime | Spread (bps) |",
        "|---|---:|---:|---|---:|---|---|---:|",
    ]
    for row in report["results"]:
        lines.append(
            f"| {row['symbol']} | {'yes' if row['ticker_fresh'] else 'no'} | "
            f"{row['last'] if row['last'] is not None else '—'} | {row['signal']} | "
            f"{row['score']} | {row['regime_1h']} | {row['regime_4h']} | "
            f"{round(row['spread_bps'], 2) if row['spread_bps'] is not None else '—'} |"
        )
        if row.get("error") or row.get("reason"):
            lines.append(f"\n**{row['symbol']} note:** {row.get('error') or row.get('reason')}\n")
    lines.extend([
        "",
        "## Safety",
        "",
        "- Read-only public market data; no exchange credentials.",
        "- No real orders and no paper positions are created by this scheduled scanner.",
        "- Stale ticker data or candle-integrity failures are downgraded to HOLD.",
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
