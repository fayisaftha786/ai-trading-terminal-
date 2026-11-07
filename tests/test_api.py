
def test_health_is_paper_only(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["mode"] == "paper_only"
    assert response.json()["live_trading_enabled"] is False
    assert response.json()["automatic_strategy_mode"] == "paper_only"
    assert response.json()["testnet_manual_orders_enabled"] is False


def test_live_executor_is_locked(client):
    response = client.post("/api/live/execute")
    assert response.status_code == 423
    assert "disabled" in response.json()["detail"].lower()


def test_paper_order_endpoint(client):
    response = client.post("/api/paper/orders", json={
        "engine": "multi_crypto", "symbol": "BTC/USDT", "name": "Bitcoin",
        "price_usd": 50000, "requested_notional_usd": 15
    })
    assert response.status_code == 200
    trade = response.json()["trade"]
    assert trade["status"] == "OPEN"
    assert response.json()["mode"] == "paper"


def test_risk_update_is_validated(client):
    payload = {
        "risk_per_trade_pct": 0.25, "max_daily_loss_pct": 1.5, "max_weekly_loss_pct": 4,
        "max_total_exposure_pct": 20, "max_open_positions": 3, "stop_loss_pct": 1,
        "take_profit_pct": 2, "fee_bps_per_side": 10, "slippage_bps": 10
    }
    response = client.put("/api/risk", json=payload)
    assert response.status_code == 200
    assert response.json()["risk"]["max_open_positions"] == 3


def test_root_returns_dashboard(client):
    response = client.get("/")
    assert response.status_code == 200
    assert "AI Trading Terminal" in response.text


def test_ui_discloses_solana_discovery_and_backtest_scope(client):
    page = client.get("/")
    script = client.get("/static/app.js")
    assert "Solana Discovery" in page.text
    assert "Solana Sniper" not in page.text
    assert "not the automatic-entry strategy" in page.text
    assert "separate EMA20/50 crossover baseline" in script.text
    assert "not the live automatic-paper entry rules" in script.text


def test_background_scan_toggle(client):
    before = client.get("/api/automation/scan").json()
    assert before["enabled"] is False
    enabled = client.put("/api/automation/scan", json={"enabled": True})
    assert enabled.status_code == 200
    assert enabled.json()["enabled"] is True
    disabled = client.put("/api/automation/scan", json={"enabled": False})
    assert disabled.json()["enabled"] is False


def test_walk_forward_endpoint_requires_enough_data(client):
    response = client.post("/api/research/walk-forward", json={
        "candles": [[i, 1, 2, 0.5, 1, 100] for i in range(100)], "folds": 3
    })
    assert response.status_code == 422


def test_auto_paper_trading_opt_in_and_emergency_kill_switch(client):
    before = client.get("/api/automation/paper-trading").json()
    assert before["enabled"] is False
    assert before["live_trading_enabled"] is False
    enabled = client.put("/api/automation/paper-trading", json={"enabled": True})
    assert enabled.status_code == 200
    assert enabled.json()["enabled"] is True
    stopped = client.post("/api/automation/kill-switch")
    assert stopped.status_code == 200
    assert stopped.json()["stopped"] is True
    assert client.get("/api/automation/paper-trading").json()["enabled"] is False


def test_scan_can_open_a_paper_entry_only_when_auto_mode_is_enabled(client):
    import time

    async def fake_tickers():
        return {
            "status": "live", "exchange": "test",
            "markets": [{
                "symbol": "BTC/USDT", "status": "live", "last": 100.0,
                "bid": 99.99, "ask": 100.01, "quote_volume": 5_000_000,
                "timestamp": time.time() * 1000,
                "bid_depth_quote": 250_000, "ask_depth_quote": 250_000,
                "orderbook_retrieved_at_ms": time.time() * 1000,
            }],
        }

    async def fake_tokens():
        return {"status": "live", "tokens": []}

    async def fake_strategy(symbol, timeframe="1h", limit=300):
        return {
            "status": "live", "symbol": symbol,
            "analysis": {"signal": "BUY_CANDIDATE", "score": 82, "regime": "UPTREND", "atr_pct": 1.1, "rsi14": 55,
                         "adx14": 25, "plus_di14": 30, "minus_di14": 20},
            "higher_timeframe": {"timeframe": "4h", "analysis": {"regime": "UPTREND"}},
            "timeframe_confluence": "ALIGNED", "candles": [],
            "last_closed_candle_timestamp_ms": time.time() * 1000 - 3_605_000,
            "higher_timeframe_last_closed_candle_timestamp_ms": time.time() * 1000 - 4 * 3_600_000 - 5_000,
        }

    market = client.app.state.market_data
    market.cex_tickers = fake_tickers
    market.solana_recent_tokens = fake_tokens
    market.cex_strategy_data = fake_strategy

    off = client.post("/api/scan")
    assert off.status_code == 200
    assert off.json()["auto_paper"]["paper_entries"] == []

    enabled = client.put("/api/automation/paper-trading", json={"enabled": True})
    assert enabled.json()["enabled"] is True
    scanned = client.post("/api/scan")
    assert scanned.status_code == 200
    data = scanned.json()
    assert len(data["auto_paper"]["paper_entries"]) == 1
    assert data["auto_paper"]["paper_entries"][0]["symbol"] == "BTC/USDT"
    assert data["auto_paper"]["paper_entries"][0]["metadata"]["automation"] is True
    performance = client.get("/api/performance?days=30").json()
    assert performance["equity_snapshot_count"] >= 1
    assert performance["equity_snapshots"][-1]["open_positions"] == 1


def test_pwa_manifest_and_service_worker_are_served(client):
    manifest = client.get("/manifest.webmanifest")
    assert manifest.status_code == 200
    assert manifest.json()["display"] == "standalone"
    sw = client.get("/sw.js")
    assert sw.status_code == 200
    assert "Service-Worker-Allowed" in sw.headers
    assert "ai-trading-terminal-shell-v0.5.0-cloud-workers-1" in sw.text
    assert client.head("/sw.js").status_code == 200
    assert "/api/" in sw.text
    offline = client.get("/offline.html")
    assert offline.status_code == 200
    assert "Backend is not reachable" in offline.text


def test_health_reports_local_pwa_and_scan_status(client):
    result = client.get("/api/health").json()
    assert result["client"] == "local_development_dashboard"
    assert result["last_scan_error"] is None


def test_performance_endpoint_and_csv_export(client):
    opened = client.post("/api/paper/orders", json={
        "engine": "multi_crypto", "symbol": "BTC/USDT", "name": "Bitcoin",
        "price_usd": 100, "requested_notional_usd": 10,
    })
    assert opened.status_code == 200
    trade_id = opened.json()["trade"]["id"]
    closed = client.post(f"/api/paper/close/{trade_id}?price_usd=103")
    assert closed.status_code == 200

    report = client.get("/api/performance?days=30")
    assert report.status_code == 200
    result = report.json()
    assert result["live_trading_enabled"] is False
    assert result["metrics"]["closed_trades"] == 1
    assert result["metrics"]["net_pnl_usd"] > 0
    assert result["sample_status"] == "insufficient_sample"

    export = client.get("/api/performance.csv")
    assert export.status_code == 200
    assert "text/csv" in export.headers["content-type"]
    assert "trade_id,closed_at_utc,engine,symbol" in export.text
    assert "BTC/USDT" in export.text


def test_dashboard_performance_ui_is_wired(client):
    page = client.get("/")
    assert page.status_code == 200
    assert 'id="performance"' in page.text
    assert 'id="performanceDays"' in page.text


def test_csv_export_preserves_close_reason_and_neutralizes_formula_symbols(client):
    opened = client.post("/api/paper/orders", json={
        "engine": "multi_crypto", "symbol": "=FORMULA/USDT", "name": "Test",
        "price_usd": 10, "requested_notional_usd": 5,
    })
    assert opened.status_code == 200
    trade_id = opened.json()["trade"]["id"]
    closed = client.post(f"/api/paper/close/{trade_id}?price_usd=9")
    assert closed.status_code == 200
    export = client.get("/api/performance.csv")
    assert "'=FORMULA/USDT" in export.text
    assert "manual" in export.text


def test_restart_resumes_cex_exit_monitoring_but_keeps_new_entries_off(tmp_path):
    from dataclasses import replace
    from app.services.paper import PaperBroker
    from app.settings import settings
    from app.storage import Storage
    from app.main import create_app
    from fastapi.testclient import TestClient

    database_path = tmp_path / "restart.db"
    seed_db = Storage(database_path)
    seed_db.initialize(100.0)
    PaperBroker(seed_db).open_long({
        "engine": "multi_crypto", "symbol": "BTC/USDT", "price_usd": 100.0,
        "requested_notional_usd": 5.0,
    })

    config = replace(settings, database_path=database_path, initial_capital_usd=100.0)
    restarted = create_app(config=config, db_path=database_path)
    assert restarted.state.auto_scan_enabled is True
    assert restarted.state.startup_exit_recovery is True
    assert restarted.state.auto_paper_enabled is False

    async def fake_tickers():
        import time
        return {"status": "live", "exchange": "test", "markets": [{
            "symbol": "BTC/USDT", "status": "live", "last": 100.0,
            "bid": 100.0, "ask": 100.01, "timestamp": time.time() * 1000,
        }]}

    async def fake_tokens():
        return {"status": "live", "tokens": []}

    restarted.state.market_data.cex_tickers = fake_tickers
    restarted.state.market_data.solana_recent_tokens = fake_tokens
    with TestClient(restarted) as restarted_client:
        scan_status = restarted_client.get("/api/automation/scan").json()
        paper_status = restarted_client.get("/api/automation/paper-trading").json()
        assert scan_status["enabled"] is True
        assert scan_status["startup_exit_recovery"] is True
        assert paper_status["enabled"] is False

    solana_db_path = tmp_path / "solana-only.db"
    solana_db = Storage(solana_db_path)
    solana_db.initialize(100.0)
    PaperBroker(solana_db).open_long({
        "engine": "solana", "symbol": "So11111111111111111111111111111111111111112",
        "price_usd": 1.0, "requested_notional_usd": 5.0,
    })
    solana_app = create_app(config=replace(settings, database_path=solana_db_path), db_path=solana_db_path)
    assert solana_app.state.auto_scan_enabled is False
    assert solana_app.state.auto_paper_enabled is False



def test_testnet_auto_entries_require_fresh_opt_in_after_restart_and_reconciliation_continues(tmp_path):
    from dataclasses import replace
    from app.settings import settings
    from app.main import create_app
    from app.storage import Storage

    database_path = tmp_path / "testnet-restart-safety.db"
    seed = Storage(database_path)
    seed.initialize(100.0)
    seed.set_setting("testnet_auto_trading_enabled", True)
    seed.create_testnet_auto_order({
        "idempotency_key": "restart-fee-retry",
        "list_client_order_id": "restart-fee-retry-client",
        "symbol": "BTC/USDT",
        "quantity": 0.001,
        "exit_quantity": 0.001,
        "entry_price": 10000,
        "stop_price": 9900,
        "target_price": 10200,
        "notional_usdt": 10,
        "signal_score": 90,
        "status": "CLOSED",
    })
    seed.update_testnet_auto_order("restart-fee-retry-client", {
        "status": "CLOSED",
        "working_order_id": "501",
        "above_order_id": "502",
        "accounting_status": "FEES_UNRESOLVED",
        "closed_at": "2026-11-07T00:00:00Z",
    })

    config = replace(settings, database_path=database_path, initial_capital_usd=100.0)
    restarted = create_app(config=config, db_path=database_path)
    assert restarted.state.auto_testnet_enabled is False
    assert restarted.state.auto_scan_enabled is True
    assert restarted.state.db.get_setting("testnet_auto_trading_enabled") is False
    assert restarted.state.db.testnet_auto_unaccounted_closed_count() == 1
    assert restarted.state.db.count_open_testnet_auto_orders() == 0


def test_testnet_status_is_separate_from_live_trading(client):
    response = client.get("/api/testnet/status")
    assert response.status_code == 200
    payload = response.json()
    assert payload["environment"] == "testnet_only"
    assert payload["enabled"] is False
    assert payload["live_trading_enabled"] is False
    assert payload["production_endpoint_used"] is False


def test_testnet_connection_check_fails_closed_without_local_setup(client):
    response = client.post("/api/testnet/connection-check")
    assert response.status_code == 409
    assert "disabled" in response.json()["detail"].lower()


def test_testnet_limit_order_controls_are_present_in_dashboard(client):
    page = client.get("/")
    script = client.get("/static/app.js")
    assert 'id="testnetOrderForm"' in page.text
    assert 'id="testnetStopBtn"' in page.text
    assert 'id="testnetResetBtn"' in page.text
    assert "refreshTestnetOrder" in script.text
    assert "cancelTestnetOrder" in script.text
    assert "RESET TESTNET ORDER LOCK" in script.text


def test_risk_update_rejects_target_that_cannot_cover_execution_costs(client):
    payload = {
        "risk_per_trade_pct": 0.25, "max_daily_loss_pct": 1.5, "max_weekly_loss_pct": 4,
        "max_total_exposure_pct": 20, "max_open_positions": 3, "stop_loss_pct": 1,
        "take_profit_pct": 1.5, "fee_bps_per_side": 10, "slippage_bps": 10,
    }
    response = client.put("/api/risk", json=payload)
    assert response.status_code == 422
    assert "net reward/risk" in response.text.lower()


def test_strategy_research_uses_saved_server_risk_profile(client, monkeypatch):
    from app.storage import DEFAULT_RISK
    observed = {}
    risk = dict(DEFAULT_RISK)
    risk.update({"risk_per_trade_pct": 0.4, "max_total_exposure_pct": 15,
                 "stop_loss_pct": 0.8, "take_profit_pct": 2.0,
                 "fee_bps_per_side": 15, "slippage_bps": 12})
    client.app.state.db.set_risk(risk)

    def fake_backtest(primary, higher, **kwargs):
        observed.update(kwargs)
        return {"ok": True, "risk_assumptions": kwargs}

    monkeypatch.setattr("app.main.run_signal_backtest", fake_backtest)
    candles = [[float(i), 1.0, 1.1, 0.9, 1.0, 10.0] for i in range(200)]
    higher = [[float(i), 1.0, 1.1, 0.9, 1.0, 10.0] for i in range(150)]
    response = client.post("/api/backtest/strategy", json={
        "candles": candles, "higher_timeframe_candles": higher, "timeframe": "1h"
    })
    assert response.status_code == 200
    assert observed["risk_per_trade_pct"] == 0.4
    assert observed["max_exposure_pct"] == 15.0
    assert observed["stop_loss_pct"] == 0.8
    assert observed["take_profit_pct"] == 2.0
    assert observed["fee_bps"] == 15.0
    assert observed["slippage_bps"] == 12.0


def test_strategy_research_rejects_browser_supplied_risk_override(client):
    candles = [[float(i), 1.0, 1.1, 0.9, 1.0, 10.0] for i in range(200)]
    higher = [[float(i), 1.0, 1.1, 0.9, 1.0, 10.0] for i in range(150)]
    response = client.post("/api/backtest/strategy", json={
        "candles": candles, "higher_timeframe_candles": higher, "risk_per_trade_pct": 1.0
    })
    assert response.status_code == 422


def test_strategy_walk_forward_uses_persisted_risk_profile(client, monkeypatch):
    from app.storage import DEFAULT_RISK
    observed = {}
    risk = dict(DEFAULT_RISK)
    risk.update({"risk_per_trade_pct": 0.35, "max_total_exposure_pct": 12,
                 "stop_loss_pct": 0.75, "take_profit_pct": 2.0,
                 "fee_bps_per_side": 12, "slippage_bps": 15})
    client.app.state.db.set_risk(risk)

    def fake_walk(primary, higher, folds, fee_bps, slippage_bps, **kwargs):
        observed.update({"folds": folds, "fee_bps": fee_bps, "slippage_bps": slippage_bps, **kwargs})
        return {"ok": True}

    monkeypatch.setattr("app.main.run_signal_walk_forward", fake_walk)
    candles = [[float(i), 1.0, 1.1, 0.9, 1.0, 10.0] for i in range(240)]
    higher = [[float(i), 1.0, 1.1, 0.9, 1.0, 10.0] for i in range(150)]
    response = client.post("/api/research/strategy-walk-forward", json={
        "candles": candles, "higher_timeframe_candles": higher, "timeframe": "1h", "folds": 3
    })
    assert response.status_code == 200
    assert observed["risk_per_trade_pct"] == 0.35
    assert observed["max_exposure_pct"] == 12.0
    assert observed["stop_loss_pct"] == 0.75
    assert observed["take_profit_pct"] == 2.0
    assert observed["fee_bps"] == 12.0
    assert observed["slippage_bps"] == 15.0


def test_scan_toggle_cannot_disable_exit_monitoring_with_open_cex_paper_position(client):
    opened = client.post("/api/paper/orders", json={
        "engine": "multi_crypto", "symbol": "BTC/USDT", "name": "Bitcoin",
        "price_usd": 100.0, "requested_notional_usd": 5.0,
    })
    assert opened.status_code == 200

    scan_off = client.put("/api/automation/scan", json={"enabled": False})
    assert scan_off.status_code == 200
    assert scan_off.json()["enabled"] is True
    assert scan_off.json()["exit_monitoring_required"] is True

    paper_off = client.put("/api/automation/paper-trading", json={"enabled": False})
    assert paper_off.status_code == 200
    assert paper_off.json()["enabled"] is False
    assert paper_off.json()["automatic_scan_enabled"] is True
    assert paper_off.json()["exit_monitoring_required"] is True


def test_auto_paper_opt_in_persists_across_process_restart_and_kill_switch_clears_it(tmp_path):
    from dataclasses import replace
    from app.settings import settings
    from app.main import create_app
    from fastapi.testclient import TestClient

    database_path = tmp_path / "persistent-auto-paper.db"
    config = replace(settings, database_path=database_path, initial_capital_usd=100.0)
    first = create_app(config=config, db_path=database_path)
    with TestClient(first) as first_client:
        assert first_client.get("/api/automation/paper-trading").json()["enabled"] is False
        enabled = first_client.put("/api/automation/paper-trading", json={"enabled": True})
        assert enabled.status_code == 200
        assert enabled.json()["enabled"] is True
        assert first_client.get("/api/automation/scan").json()["enabled"] is True

    restarted = create_app(config=config, db_path=database_path)
    assert restarted.state.auto_paper_enabled is True
    assert restarted.state.auto_scan_enabled is True

    async def no_markets():
        return {"status": "live", "markets": []}

    async def no_tokens():
        return {"status": "live", "tokens": []}

    restarted.state.market_data.cex_tickers = no_markets
    restarted.state.market_data.solana_recent_tokens = no_tokens
    with TestClient(restarted) as restarted_client:
        assert restarted_client.get("/api/automation/paper-trading").json()["enabled"] is True
        stopped = restarted_client.post("/api/automation/kill-switch")
        assert stopped.status_code == 200
        assert stopped.json()["automatic_paper_trading_enabled"] is False

    after_kill = create_app(config=config, db_path=database_path)
    assert after_kill.state.auto_paper_enabled is False


def test_binance_production_account_status_is_read_only_and_disabled_by_default(client):
    response = client.get("/api/binance/account/status")
    assert response.status_code == 200
    body = response.json()
    assert body["environment"] == "production_read_only"
    assert body["enabled"] is False
    assert body["ready_for_connection_check"] is False
    assert body["order_execution_available"] is False
    assert body["live_trading_enabled"] is False


def test_binance_production_connection_check_fails_closed_by_default(client):
    response = client.post("/api/binance/account/connection-check")
    assert response.status_code == 409
    assert "disabled" in response.json()["detail"].lower()



def test_testnet_enable_cannot_race_global_kill_switch_and_reset_stays_off(tmp_path):
    import asyncio
    import threading
    from dataclasses import replace

    from fastapi import HTTPException
    from app.main import create_app
    from app.schemas import ScanAutomationRequest, TestnetKillSwitchResetRequest
    from app.settings import settings

    database_path = tmp_path / "testnet-control-race.db"
    config = replace(
        settings,
        database_path=database_path,
        initial_capital_usd=100.0,
        binance_testnet_enabled=True,
        binance_testnet_api_key="TEST_KEY",
        binance_testnet_api_secret="TEST_SECRET",
        binance_testnet_order_enabled=True,
    )
    application = create_app(config=config, db_path=database_path)
    routes = {
        (route.path, method): route.endpoint
        for route in application.routes
        if hasattr(route, "path")
        for method in (route.methods or set())
    }
    kill_switch = routes[("/api/automation/kill-switch", "POST")]
    enable_testnet = routes[("/api/automation/testnet-trading", "PUT")]
    reset_kill_switch = routes[("/api/testnet/kill-switch/reset", "POST")]

    stop_started = threading.Event()
    allow_stop_to_finish = threading.Event()
    original_stop = application.state.testnet_auto.emergency_stop

    def delayed_stop():
        stop_started.set()
        if not allow_stop_to_finish.wait(timeout=5):
            raise TimeoutError("test did not release the delayed emergency stop")
        return original_stop()

    application.state.testnet_auto.emergency_stop = delayed_stop

    async def exercise_race():
        stop_task = asyncio.create_task(kill_switch())
        assert await asyncio.to_thread(stop_started.wait, 2), "kill switch did not enter its stop phase"

        enable_task = asyncio.create_task(enable_testnet(ScanAutomationRequest(enabled=True)))
        await asyncio.sleep(0.05)
        assert not enable_task.done(), "automation toggle bypassed the emergency-stop serialization lock"

        allow_stop_to_finish.set()
        stopped = await stop_task
        assert stopped["stopped"] is True
        with pytest.raises(HTTPException) as rejected:
            await enable_task
        assert rejected.value.status_code == 409

        assert application.state.auto_testnet_enabled is False
        assert application.state.db.get_setting("testnet_auto_trading_enabled") is False
        assert application.state.db.get_setting("testnet_order_halted") is True

        # A reset only clears the order latch; it must not silently re-enable strategy entries.
        application.state.auto_testnet_enabled = True
        application.state.db.set_setting("testnet_auto_trading_enabled", True)
        reset = await reset_kill_switch(
            TestnetKillSwitchResetRequest(confirmation="RESET TESTNET ORDER LOCK")
        )
        assert reset["halted"] is False
        assert reset["automatic_testnet_trading_enabled"] is False
        assert application.state.auto_testnet_enabled is False
        assert application.state.db.get_setting("testnet_auto_trading_enabled") is False

    try:
        asyncio.run(exercise_race())
    finally:
        allow_stop_to_finish.set()
