import asyncio
import threading
import time

from app.storage import DEFAULT_RISK
from app.services import workers as worker_service
from app.services.workers import WorkerManager


def _context():
    candles = [
        [index * 3_600_000, 100.0, 101.0, 99.0, 100.5, 1000.0]
        for index in range(220)
    ]
    higher = [
        [index * 14_400_000, 100.0, 101.0, 99.0, 100.5, 4000.0]
        for index in range(180)
    ]
    analysis = {
        "signal": "HOLD", "score": 50, "regime": "RANGE_OR_TRANSITION",
        "reasons": ["Trend alignment is mixed"],
        "momentum_state": "MIXED_OR_NEUTRAL", "momentum_score": 50,
        "momentum_reasons": ["Price momentum is mixed"],
        "roc_5_pct": 0.1, "roc_10_pct": 0.0, "roc_20_pct": -0.1,
        "macd_line": 0.01, "macd_signal": 0.02, "macd_histogram": -0.01,
        "macd_histogram_slope": 0.001, "volume_ratio_20": 1.0,
        "breakout_20": "INSIDE_RANGE", "ema20_slope_pct": 0.01,
        "adx14": 12.0, "atr_pct": 1.0,
        "realized_volatility_pct_approx": 0.5,
    }
    return {
        "market": {
            "status": "live", "symbol": "BTC/USDT", "timeframe": "1h",
            "provider": "test", "analysis": analysis,
            "higher_timeframe": {"timeframe": "4h", "analysis": dict(analysis), "candles": higher},
            "timeframe_confluence": "MIXED_OR_UNCONFIRMED", "candles": candles,
            "last_closed_candle_timestamp_ms": candles[-1][0],
            "data_quality": {
                "contiguous_closed_candles": True,
                "sufficient_indicator_history": True,
                "primary_integrity": {"is_clean": True, "valid_unique_candles": len(candles)},
                "higher_timeframe_integrity": {"is_clean": True, "valid_unique_candles": len(higher)},
            },
        },
        "risk": dict(DEFAULT_RISK),
        "portfolio": {"equity_usd": 100.0, "exposure_usd": 10.0, "unmarked_positions": 0},
        "open_positions": [{"symbol": "ETH/USDT"}],
        "auto_paper_enabled": False,
    }


def test_worker_registry_has_twelve_specialists_and_is_honest_about_news():
    registry = WorkerManager().registry()
    assert registry["worker_count"] == 12
    assert registry["ready_count"] == 11
    assert registry["unavailable_count"] == 1
    news = next(worker for worker in registry["workers"] if worker["id"] == "news_sentiment")
    assert news["availability"] == "unavailable"
    assert all(worker["execution_mode"] == "read_only" for worker in registry["workers"])


def test_worker_manager_runs_isolated_diagnostics_without_execution_permission():
    result = asyncio.run(WorkerManager().analyze(_context()))
    assert result["worker_count"] == 12
    assert result["status"] == "partial"  # News/sentiment is not configured.
    assert result["counts"]["complete"] >= 10
    assert result["counts"]["unavailable"] == 1
    assert result["live_trading_enabled"] is False
    assert result["execution_authorized"] is False
    assert len({worker["id"] for worker in result["workers"]}) == 12
    risk = next(worker for worker in result["workers"] if worker["id"] == "risk_guard")
    assert risk["result"]["metrics"]["execution_authorized"] is False
    assert risk["result"]["metrics"]["checks"]["existing_strategy_candidate"] is False


def test_market_integrity_worker_blocks_when_closed_candles_are_not_contiguous():
    context = _context()
    context["market"]["data_quality"]["contiguous_closed_candles"] = False
    result = asyncio.run(WorkerManager().analyze(context))
    feed = next(worker for worker in result["workers"] if worker["id"] == "market_feed")
    assert feed["status"] == "blocked"
    risk = next(worker for worker in result["workers"] if worker["id"] == "risk_guard")
    assert risk["result"]["metrics"]["checks"]["clean_closed_candles"] is False


def test_worker_route_exposes_registry_and_read_only_market_analysis(client):
    registry = client.get("/api/workers")
    assert registry.status_code == 200
    assert registry.json()["worker_count"] == 12

    candles = [[i * 3_600_000, 100, 101, 99, 100.5, 1000] for i in range(220)]
    higher = [[i * 14_400_000, 100, 101, 99, 100.5, 4000] for i in range(180)]
    analysis = {
        "signal": "HOLD", "score": 50, "regime": "RANGE_OR_TRANSITION",
        "reasons": ["Mixed trend"], "momentum_state": "MIXED_OR_NEUTRAL",
        "momentum_score": 50, "momentum_reasons": [], "roc_5_pct": 0,
        "roc_10_pct": 0, "roc_20_pct": 0, "macd_line": 0,
        "macd_signal": 0, "macd_histogram": 0, "macd_histogram_slope": 0,
        "volume_ratio_20": 1, "breakout_20": "INSIDE_RANGE",
        "ema20_slope_pct": 0, "adx14": 10, "atr_pct": 1,
        "realized_volatility_pct_approx": 0.5,
    }

    async def fake_strategy(symbol, timeframe="1h", limit=300):
        return {
            "status": "live", "symbol": symbol, "timeframe": timeframe, "provider": "test",
            "analysis": analysis,
            "higher_timeframe": {"timeframe": "4h", "analysis": analysis, "candles": higher},
            "timeframe_confluence": "MIXED_OR_UNCONFIRMED", "candles": candles,
            "last_closed_candle_timestamp_ms": candles[-1][0],
            "data_quality": {"contiguous_closed_candles": True, "sufficient_indicator_history": True,
                             "primary_integrity": {"is_clean": True},
                             "higher_timeframe_integrity": {"is_clean": True}},
        }

    client.app.state.market_data.cex_strategy_data = fake_strategy
    response = client.get("/api/workers/analyze/BTC%2FUSDT")
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["worker_count"] == 12
    assert result["mode"] == "read_only_market_analysis"
    assert result["execution_authorized"] is False


def test_worker_analysis_rejects_invalid_timeframe_and_candle_limit(client):
    timeframe = client.get("/api/workers/analyze/BTC%2FUSDT?timeframe=2w")
    assert timeframe.status_code == 422
    limit = client.get("/api/workers/analyze/BTC%2FUSDT?limit=5001")
    assert limit.status_code == 422



def test_worker_registry_remembers_last_health_after_analysis():
    manager = WorkerManager()
    asyncio.run(manager.analyze(_context()))
    registry = manager.registry()
    momentum = next(worker for worker in registry["workers"] if worker["id"] == "momentum")
    news = next(worker for worker in registry["workers"] if worker["id"] == "news_sentiment")
    assert registry["last_run_status"] == "partial"
    assert momentum["last_status"] == "complete"
    assert momentum["health_status"] == "complete"
    assert news["health_status"] == "unavailable"


def test_worker_manager_isolates_errors_and_retries_only_the_failed_worker(monkeypatch):
    calls = {"faulty": 0}

    def faulty(context):
        calls["faulty"] += 1
        raise RuntimeError("simulated specialist failure")

    def healthy(context):
        return {"status": "complete", "summary": "Healthy worker completed."}

    monkeypatch.setattr(worker_service, "_WORKERS", (
        ("faulty", "Faulty", "Test-only failure", faulty),
        ("healthy", "Healthy", "Test-only worker", healthy),
    ))
    result = asyncio.run(WorkerManager(concurrency=2, retries=1).analyze({}))
    workers = {worker["id"]: worker for worker in result["workers"]}
    assert result["status"] == "partial"
    assert workers["faulty"]["status"] == "error"
    assert workers["faulty"]["attempts"] == 2
    assert workers["healthy"]["status"] == "complete"
    assert calls["faulty"] == 2


def test_worker_manager_enforces_global_bounded_concurrency(monkeypatch):
    state = {"active": 0, "maximum": 0}
    lock = threading.Lock()

    def slow_worker(context):
        with lock:
            state["active"] += 1
            state["maximum"] = max(state["maximum"], state["active"])
        time.sleep(0.025)
        with lock:
            state["active"] -= 1
        return {"status": "complete", "summary": "bounded"}

    specs = tuple((f"worker_{index}", f"Worker {index}", "Concurrency test", slow_worker)
                  for index in range(8))
    monkeypatch.setattr(worker_service, "_WORKERS", specs)
    result = asyncio.run(WorkerManager(concurrency=3, retries=0).analyze({}))
    assert result["counts"]["complete"] == 8
    assert state["maximum"] <= 3
    assert state["maximum"] >= 2


def test_worker_panel_is_present_and_discloses_deterministic_read_only_scope(client):
    page = client.get("/")
    assert page.status_code == 200
    assert 'id="workers"' in page.text
    assert "12-worker market intelligence" in page.text
    assert "not 12 separately trained AI models" in page.text
    assert 'id="runWorkersBtn"' in page.text



def test_worker_analysis_route_rejects_overlapping_request(client):
    lock = client.app.state.worker_analysis_lock
    assert lock.locked() is False

    async def hold_lock():
        await lock.acquire()

    asyncio.run(hold_lock())
    try:
        response = client.get("/api/workers/analyze/BTC%2FUSDT")
        assert response.status_code == 429
        assert "already running" in response.json()["detail"]
    finally:
        lock.release()
