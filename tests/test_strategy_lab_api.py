from __future__ import annotations

import time

from app.services.market_data import MarketDataService


HOUR_MS = 60 * 60 * 1000
FOUR_HOURS_MS = 4 * HOUR_MS


def _bars(count: int, interval_ms: int, start_ms: int):
    rows = []
    for index in range(count):
        close = 100.0
        rows.append([
            start_ms + index * interval_ms,
            close,
            close + 0.2,
            close - 0.2,
            close,
            1000.0,
        ])
    return rows


def test_market_analysis_endpoint_includes_research_only_strategy_lab(client, monkeypatch):
    now_ms = int(time.time() * 1000)
    aligned_now = now_ms - (now_ms % FOUR_HOURS_MS)
    primary = _bars(300, HOUR_MS, aligned_now - 300 * HOUR_MS)
    higher = _bars(150, FOUR_HOURS_MS, aligned_now - 600 * HOUR_MS)

    async def fake_strategy(symbol, timeframe="1h", limit=300):
        return {
            "status": "live",
            "symbol": symbol,
            "timeframe": timeframe,
            "analysis": {"signal": "HOLD", "score": 50, "regime": "RANGE_OR_TRANSITION"},
            "higher_timeframe": {
                "timeframe": "4h",
                "analysis": {"signal": "HOLD", "score": 50, "regime": "RANGE_OR_TRANSITION"},
                "candles": higher,
            },
            "timeframe_confluence": "ALIGNED",
            "candles": primary,
            "higher_timeframe_interval_ms": FOUR_HOURS_MS,
        }

    monkeypatch.setattr(client.app.state.market_data, "cex_strategy_data", fake_strategy)
    response = client.get("/api/strategies/multi/BTC%2FUSDT?timeframe=1h&limit=300")

    assert response.status_code == 200, response.text
    result = response.json()
    lab = result["strategy_research"]
    assert lab["status"] == "research_only"
    assert [item["strategy_id"] for item in lab["candidates"]] == [
        "trend_pullback", "volatility_breakout", "range_mean_reversion"
    ]
    assert lab["execution_authorized"] is False
    assert lab["paper_auto_entry_eligible"] is False
    assert lab["live_trading_enabled"] is False


def test_market_analysis_endpoint_validates_symbol_and_candle_limit(client):
    bad_symbol = client.get("/api/strategies/multi/%20?timeframe=1h&limit=300")
    bad_limit = client.get("/api/strategies/multi/BTC%2FUSDT?timeframe=1h&limit=100")
    assert bad_symbol.status_code == 422
    assert bad_limit.status_code == 422
