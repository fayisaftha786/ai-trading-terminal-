from __future__ import annotations

import time


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



def test_strategy_lab_blocks_non_one_hour_primary_timeframes(client, monkeypatch):
    async def fake_strategy(symbol, timeframe="15m", limit=300):
        return {
            "status": "live",
            "symbol": symbol,
            "timeframe": timeframe,
            "analysis": {"signal": "HOLD", "score": 50, "regime": "RANGE_OR_TRANSITION"},
            "higher_timeframe": {
                "timeframe": "6h",
                "analysis": {"signal": "HOLD", "score": 50, "regime": "RANGE_OR_TRANSITION"},
                "candles": [],
            },
            "candles": [],
            "higher_timeframe_interval_ms": 6 * FOUR_HOURS_MS // 4,
        }

    monkeypatch.setattr(client.app.state.market_data, "cex_strategy_data", fake_strategy)
    response = client.get("/api/strategies/multi/BTC%2FUSDT?timeframe=15m&limit=300")

    assert response.status_code == 200
    lab = response.json()["strategy_research"]
    assert lab["status"] == "blocked"
    assert lab["reason"] == "strategy_research_lab_requires_1h_primary_candles"
    assert lab["execution_authorized"] is False



def test_backtest_and_walk_forward_api_preserve_six_hour_confirmation_interval(client, monkeypatch):
    import app.main as main_module

    received = {"backtest": None, "walk_forward": None}

    def fake_backtest(candles, higher, **kwargs):
        received["backtest"] = kwargs["higher_timeframe_ms"]
        return {"timeframe_assumptions": {"higher_interval_ms": kwargs["higher_timeframe_ms"]}}

    def fake_walk_forward(candles, higher, folds, **kwargs):
        received["walk_forward"] = kwargs["higher_timeframe_ms"]
        return {"timeframe_assumptions": {"higher_interval_ms": kwargs["higher_timeframe_ms"]}}

    monkeypatch.setattr(main_module, "run_signal_backtest", fake_backtest)
    monkeypatch.setattr(main_module, "run_signal_walk_forward", fake_walk_forward)

    payload = {
        "candles": [[index * HOUR_MS, 100, 101, 99, 100, 1000] for index in range(200)],
        "higher_timeframe_candles": [[index * FOUR_HOURS_MS, 100, 101, 99, 100, 4000] for index in range(150)],
        "higher_timeframe_interval_ms": 21_600_000,
        "timeframe": "1h",
    }
    backtest = client.post("/api/backtest/strategy", json=payload)
    walk_forward = client.post("/api/research/strategy-walk-forward", json={**payload, "folds": 2})

    assert backtest.status_code == 200, backtest.text
    assert walk_forward.status_code == 200, walk_forward.text
    assert received == {"backtest": 21_600_000, "walk_forward": 21_600_000}
    assert backtest.json()["timeframe_assumptions"]["higher_interval_ms"] == 21_600_000
