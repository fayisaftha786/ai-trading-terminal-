from __future__ import annotations

from pathlib import Path
from typing import Any

import asyncio
import csv
import io
import time
from contextlib import asynccontextmanager
from math import isfinite
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from app.schemas import (BacktestRequest, LoginRequest, PaperOrderRequest, RiskUpdate, ScanAutomationRequest,
                          SignalBacktestRequest, SignalWalkForwardRequest,
                          TestnetKillSwitchResetRequest, TestnetLimitOrderRequest, WalkForwardRequest)
from app.services.backtest import (run_ema_backtest, run_walk_forward, run_signal_backtest,
                                    run_signal_walk_forward)
from app.services.automation import AutoPaperEngine
from app.services.binance_account import BinanceAccountUnavailable, BinanceSpotReadOnly
from app.services.mode_gate import assess_demo_readiness
from app.services.market_data import MarketDataService
from app.services.paper import PaperBroker
from app.services.performance import build_performance_report
from app.services.risk import safe_cost_assumptions, validate_risk_profile
from app.services.testnet import (BinanceSpotTestnet, TestnetOrderRejected,
                                   TestnetOrderUncertain, TestnetUnavailable)
from app.services.strategy import analyze_candles, score_solana_token
from app.services.workers import WorkerManager
from app.settings import Settings, settings
from app.storage import Storage
from app.security import InvalidAccessToken, create_access_token, verify_access_token


STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


def create_app(config: Settings | None = None, db_path: str | Path | None = None) -> FastAPI:
    cfg = config or settings
    auth_required = cfg.environment.lower() == "production"
    if auth_required:
        if len(cfg.auth_password) < 16:
            raise RuntimeError("Production mode requires APP_PASSWORD with at least 16 characters")
        if len(cfg.auth_secret.encode("utf-8")) < 32:
            raise RuntimeError("Production mode requires APP_AUTH_SECRET with at least 32 bytes")
        if not Path(cfg.database_path).is_absolute():
            raise RuntimeError("Production mode requires an absolute DATABASE_PATH on persistent storage")
        if not (15 <= cfg.auth_token_ttl_minutes <= 1440):
            raise RuntimeError("APP_TOKEN_TTL_MINUTES must be between 15 and 1440")
    db = Storage(db_path or cfg.database_path)
    db.initialize(cfg.initial_capital_usd)
    market_data = MarketDataService(cfg)
    broker = PaperBroker(db)
    auto_paper = AutoPaperEngine(db, broker)
    testnet = BinanceSpotTestnet(cfg)
    binance_readonly = BinanceSpotReadOnly(cfg)
    worker_manager = WorkerManager(concurrency=4, timeout_seconds=4.0, retries=1)
    worker_analysis_lock = asyncio.Lock()

    async def _perform_scan_unlocked() -> dict[str, Any]:
        cex, sol = await asyncio.gather(market_data.cex_tickers(), market_data.solana_recent_tokens())
        for token in sol.get("tokens", []):
            token["screening"] = score_solana_token(token)
        marks: dict[str, float] = {}
        now_ms = time.time() * 1000
        fresh_markets: list[dict[str, Any]] = []
        for market in cex.get("markets", []):
            stamp = market.get("timestamp")
            try:
                age = now_ms - float(stamp)
            except (TypeError, ValueError):
                age = float("inf")
            if market.get("status") == "live" and 0 <= age <= 120_000:
                # A long position is valued at the executable bid, not at the last trade.
                mark = market.get("bid") or market.get("last")
                try:
                    mark = float(mark)
                    if isfinite(mark) and mark > 0:
                        marks[market["symbol"]] = mark
                        fresh_markets.append(market)
                except (TypeError, ValueError):
                    pass

        research: list[dict[str, Any]] = []
        if app.state.auto_paper_enabled:
            async def research_market(market: dict[str, Any]) -> dict[str, Any] | None:
                data = await market_data.cex_strategy_data(market["symbol"], timeframe="1h", limit=300)
                if data.get("status") != "live":
                    return None
                return {"ticker": market, "analysis": data.get("analysis", {}),
                        "higher_timeframe": (data.get("higher_timeframe") or {}).get("analysis", {}),
                        "timeframe_confluence": data.get("timeframe_confluence"),
                        "last_closed_candle_timestamp_ms": data.get("last_closed_candle_timestamp_ms"),
                        "higher_timeframe_last_closed_candle_timestamp_ms": data.get("higher_timeframe_last_closed_candle_timestamp_ms"),
                        "higher_timeframe_interval_ms": data.get("higher_timeframe_interval_ms", 4 * 3_600_000)}
            researched = await asyncio.gather(*(research_market(m) for m in fresh_markets), return_exceptions=True)
            research = [x for x in researched if isinstance(x, dict)]

        # Jupiter /recent is discovery-only. It is never used as a Solana execution mark.
        auto_result = auto_paper.run(research, marks, bool(app.state.auto_paper_enabled))
        if auto_result.get("halt_automation"):
            app.state.auto_paper_enabled = False
            db.set_setting("auto_paper_enabled", False)
            db.log_event("auto_paper_halted", "Automatic paper trading halted by portfolio drawdown circuit breaker", {})
        app.state.latest_marks = marks
        app.state.latest_marks_at = time.time()
        snapshot_risk = db.get_risk()
        snapshot_fee, snapshot_slippage = safe_cost_assumptions(snapshot_risk)
        snapshot_summary = db.portfolio_summary(
            marks,
            fee_bps_per_side=snapshot_fee,
            slippage_bps=snapshot_slippage,
        )
        db.record_equity_snapshot(snapshot_summary)
        db.log_event("market_scan", "Market scan completed", {
            "cex_status": cex.get("status"), "solana_status": sol.get("status"),
            "cex_markets": len(cex.get("markets", [])), "solana_tokens": len(sol.get("tokens", [])),
            "paper_trigger_closes": auto_result.get("paper_exits", 0),
            "auto_paper_entries": len(auto_result.get("paper_entries", [])),
            "auto_paper_enabled": bool(app.state.auto_paper_enabled)})
        return {"cex": cex, "solana": sol, "scanned": True,
                "research": research, "auto_paper": auto_result,
                "paper_positions_auto_closed": auto_result.get("paper_exits", 0),
                "notice": "Automatic execution is paper-only. CEX entries require fresh quotes, closed-candle multi-timeframe alignment, volume and spread filters, and risk approval. Solana is discovery/screening only. No real orders are sent."}

    scan_lock = asyncio.Lock()

    async def perform_scan() -> dict[str, Any]:
        # Serialize UI-triggered and background scans. This prevents two scans from
        # racing stop/target closes or consuming the same entry opportunity.
        async with scan_lock:
            app.state.last_scan_error = None
            try:
                result = await _perform_scan_unlocked()
                app.state.last_scan_at = time.time()
                return result
            except Exception as exc:
                app.state.last_scan_error = str(exc)[:240]
                db.log_event("market_scan_error", "Market scan failed", {"error": str(exc)[:180]})
                raise

    async def auto_scan_loop() -> None:
        while True:
            if app.state.auto_scan_enabled or app.state.auto_paper_enabled:
                try:
                    await perform_scan()
                except Exception as exc:
                    db.log_event("auto_scan_error", "Background market scan failed", {"error": str(exc)[:180]})
            await asyncio.sleep(max(30, cfg.scan_interval_seconds))

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        application.state.auto_scan_task = asyncio.create_task(auto_scan_loop())
        try:
            yield
        finally:
            task = application.state.auto_scan_task
            if task:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

    app = FastAPI(
        title=cfg.app_name,
        version="0.5.0-cloud",
        description="Cloud-hosted private paper-trading dashboard with authenticated API access; production trading remains disabled",
        lifespan=lifespan,
        docs_url=None if auth_required else "/docs",
        redoc_url=None if auth_required else "/redoc",
        openapi_url=None if auth_required else "/openapi.json",
    )
    app.state.login_attempts = {}

    @app.middleware("http")
    async def private_api_guard(request: Request, call_next):
        path = request.url.path
        if auth_required and path.startswith("/api/") and path not in {"/api/auth/status", "/api/auth/login", "/api/health"}:
            header = request.headers.get("authorization", "")
            scheme, _, token = header.partition(" ")
            if scheme.lower() != "bearer" or not token:
                return JSONResponse(
                    {"detail": "Authentication required"}, status_code=401,
                    headers={"Cache-Control": "no-store, private", "Pragma": "no-cache"},
                )
            try:
                identity = verify_access_token(
                    token,
                    username=cfg.auth_username,
                    secret=cfg.auth_secret,
                    max_ttl_minutes=cfg.auth_token_ttl_minutes,
                )
                request.state.authenticated_user = identity["sub"]
            except InvalidAccessToken:
                return JSONResponse(
                    {"detail": "Session expired or invalid. Please sign in again."}, status_code=401,
                    headers={"Cache-Control": "no-store, private", "Pragma": "no-cache"},
                )
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        if path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-store, private")
            response.headers.setdefault("Pragma", "no-cache")
        if request.url.scheme == "https":
            response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        return response
    app.state.db = db
    app.state.market_data = market_data
    app.state.paper_broker = broker
    app.state.testnet = testnet
    app.state.binance_readonly = binance_readonly
    app.state.worker_manager = worker_manager
    app.state.worker_analysis_lock = worker_analysis_lock
    app.state.settings = cfg
    # On restart, resume only read-only CEX exit monitoring when persisted CEX
    # paper positions remain open. New automatic entries always require a new opt-in.
    cex_positions_open_at_startup = any(
        trade.get("engine") == "multi_crypto" for trade in db.open_trades()
    )
    # Paper automation is opt-in, then persisted across ordinary process restarts.
    # The emergency kill switch and drawdown circuit breaker persistently turn it OFF.
    app.state.auto_paper_enabled = bool(db.get_setting("auto_paper_enabled", False))
    app.state.auto_scan_enabled = cex_positions_open_at_startup or app.state.auto_paper_enabled
    app.state.startup_exit_recovery = cex_positions_open_at_startup
    app.state.latest_marks = {}
    app.state.latest_marks_at = 0.0
    app.state.last_scan_at = 0.0
    app.state.last_scan_error = None
    app.state.auto_scan_task = None
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    @app.get("/", include_in_schema=False)
    async def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html")

    @app.api_route("/manifest.webmanifest", methods=["GET", "HEAD"], include_in_schema=False)
    async def web_manifest() -> FileResponse:
        return FileResponse(STATIC_DIR / "manifest.webmanifest", media_type="application/manifest+json")

    @app.api_route("/sw.js", methods=["GET", "HEAD"], include_in_schema=False)
    async def service_worker() -> FileResponse:
        return FileResponse(STATIC_DIR / "sw.js", media_type="application/javascript",
                            headers={"Service-Worker-Allowed": "/", "Cache-Control": "no-cache"})

    @app.get("/offline.html", include_in_schema=False)
    async def offline_page() -> FileResponse:
        return FileResponse(STATIC_DIR / "offline.html")

    @app.get("/api/auth/status")
    async def auth_status() -> dict[str, Any]:
        return {"required": auth_required, "token_ttl_minutes": cfg.auth_token_ttl_minutes if auth_required else None}

    @app.post("/api/auth/login")
    async def auth_login(payload: LoginRequest, request: Request) -> dict[str, Any]:
        if not auth_required:
            raise HTTPException(status_code=404, detail="Authentication is not enabled in development mode")
        now = time.time()
        client_host = request.client.host if request.client else "unknown"
        attempts = app.state.login_attempts.setdefault(client_host, [])
        attempts[:] = [stamp for stamp in attempts if now - stamp < 600]
        if len(attempts) >= 5:
            raise HTTPException(status_code=429, detail="Too many sign-in attempts. Try again in 10 minutes.")
        username_ok = __import__("hmac").compare_digest(payload.username.encode(), cfg.auth_username.encode())
        password_ok = __import__("hmac").compare_digest(payload.password.encode(), cfg.auth_password.encode())
        if not (username_ok and password_ok):
            attempts.append(now)
            db.log_event("auth_login_failed", "Rejected dashboard sign-in", {"source": client_host})
            raise HTTPException(status_code=401, detail="Incorrect username or password")
        attempts.clear()
        token = create_access_token(cfg.auth_username, cfg.auth_secret, cfg.auth_token_ttl_minutes)
        db.log_event("auth_login", "Dashboard sign-in succeeded", {"source": client_host})
        return {"access_token": token, "token_type": "Bearer", "expires_in": cfg.auth_token_ttl_minutes * 60}

    @app.get("/api/binance/account/status")
    async def binance_account_status() -> dict[str, Any]:
        return binance_readonly.status()

    @app.post("/api/binance/account/connection-check")
    async def binance_account_connection_check() -> dict[str, Any]:
        try:
            result = await asyncio.to_thread(binance_readonly.check_account)
            db.log_event("binance_readonly_connection", "Binance production read-only account check succeeded", {
                "environment": "production_read_only",
                "asset_count": result.get("asset_count", 0),
                "live_trading_enabled": False,
            })
            return result
        except BinanceAccountUnavailable as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.get("/api/testnet/status")
    async def testnet_status() -> dict[str, Any]:
        return testnet.status(halted=bool(db.get_setting("testnet_order_halted", False)))

    @app.post("/api/testnet/connection-check")
    async def testnet_connection_check() -> dict[str, Any]:
        try:
            result = await asyncio.to_thread(testnet.check_account)
            db.log_event("testnet_connection", "Binance Spot Testnet account check succeeded", {
                "environment": "testnet_only", "usdt_free": result.get("usdt_free", 0.0)})
            return result
        except TestnetUnavailable as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.get("/api/testnet/orders")
    async def testnet_orders(limit: int = 50) -> dict[str, Any]:
        return {"orders": db.list_testnet_orders(limit), "environment": "testnet_only",
                "live_trading_enabled": False}

    @app.post("/api/testnet/orders")
    async def testnet_create_order(payload: TestnetLimitOrderRequest) -> dict[str, Any]:
        try:
            result = await asyncio.to_thread(testnet.create_limit_order, payload.model_dump(), db)
            if not result.get("replayed"):
                order = result.get("order") or {}
                db.log_event("testnet_limit_order", "Bounded Binance Spot Testnet limit order submitted", {
                    "environment": "testnet_only", "symbol": order.get("symbol"),
                    "side": order.get("side"), "status": order.get("status"),
                    "notional_usdt": order.get("notional_usdt"),
                    "client_order_id": order.get("client_order_id")})
            return result
        except TestnetUnavailable as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except TestnetOrderRejected as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except TestnetOrderUncertain as exc:
            db.log_event("testnet_order_uncertain", "Testnet order requires reconciliation; resubmission blocked", {})
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    @app.post("/api/testnet/orders/{client_order_id}/refresh")
    async def testnet_refresh_order(client_order_id: str) -> dict[str, Any]:
        try:
            result = await asyncio.to_thread(testnet.refresh_order, client_order_id, db)
            db.log_event("testnet_order_refresh", "Testnet order status refresh attempted", {
                "client_order_id": client_order_id, "reconciled": result.get("reconciled", True),
                "status": (result.get("order") or {}).get("status")})
            return result
        except TestnetUnavailable as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/api/testnet/orders/{client_order_id}/cancel")
    async def testnet_cancel_order(client_order_id: str) -> dict[str, Any]:
        try:
            result = await asyncio.to_thread(testnet.cancel_order, client_order_id, db)
            db.log_event("testnet_order_cancel", "Binance Spot Testnet cancellation requested", {
                "client_order_id": client_order_id, "status": (result.get("order") or {}).get("status")})
            return result
        except TestnetUnavailable as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/api/testnet/kill-switch")
    async def testnet_kill_switch() -> dict[str, Any]:
        result = await asyncio.to_thread(testnet.emergency_stop, db)
        db.log_event("testnet_kill_switch", "Persistent Testnet order lock activated", {
            "canceled_count": len(result["canceled_client_order_ids"]),
            "unresolved_count": len(result["unresolved_client_order_ids"])})
        return result

    @app.post("/api/testnet/kill-switch/reset")
    async def reset_testnet_kill_switch(payload: TestnetKillSwitchResetRequest) -> dict[str, Any]:
        unresolved = db.count_open_testnet_orders()
        if unresolved:
            raise HTTPException(status_code=409, detail=(
                f"Cannot reset: {unresolved} open or unresolved Testnet order(s) remain. "
                "Reconcile or cancel them first."
            ))
        db.set_setting("testnet_order_halted", False)
        db.log_event("testnet_kill_switch_reset", "Testnet order lock reset after ledger reconciliation", {})
        return {"halted": False, "order_execution_enabled": testnet.status(halted=False)["order_execution_enabled"],
                "live_trading_enabled": False}

    @app.get("/api/health")
    async def health() -> dict[str, Any]:
        # Keep the public platform health probe deliberately low-information.
        # Trading state, logs, exchange configuration and Testnet status remain private.
        if auth_required:
            return {"status": "ok", "mode": "paper_only", "live_trading_enabled": False,
                    "version": app.version}
        return {"status": "ok", "mode": "paper_only", "automatic_strategy_mode": "paper_only",
                "testnet_manual_orders_enabled": testnet.status(
                    halted=bool(db.get_setting("testnet_order_halted", False)))["order_execution_enabled"],
                "live_trading_enabled": False,
                "automatic_paper_trading_enabled": bool(app.state.auto_paper_enabled),
                "automatic_scan_enabled": bool(app.state.auto_scan_enabled),
                "last_scan_at": app.state.last_scan_at or None,
                "last_scan_error": app.state.last_scan_error,
                "database": "connected", "version": app.version,
                "client": "local_development_dashboard",
                "testnet": testnet.status(halted=bool(db.get_setting("testnet_order_halted", False)))}

    @app.get("/api/config")
    async def get_config() -> dict[str, Any]:
        return {"mode": "paper_only", "live_trading_enabled": False,
                "cex_exchange": cfg.cex_exchange, "cex_symbols": list(cfg.cex_symbols),
                "jupiter_provider": "Jupiter Tokens API v2",
                "analysis_model": "deterministic EMA/RSI + heuristic screening; no trained ML model or LLM",
                "initial_capital_usd": cfg.initial_capital_usd,
                "risk": db.get_risk(), "testnet": testnet.status(halted=bool(db.get_setting("testnet_order_halted", False)))}

    @app.get("/api/dashboard")
    async def dashboard() -> dict[str, Any]:
        risk = db.get_risk()
        fresh_marks = app.state.latest_marks if time.time() - float(app.state.latest_marks_at) <= 120 else {}
        fee_bps, slippage_bps = safe_cost_assumptions(risk)
        portfolio = db.portfolio_summary(
            fresh_marks,
            fee_bps_per_side=fee_bps,
            slippage_bps=slippage_bps,
        )
        return {"mode": "paper_only", "live_trading_enabled": False,
                "automatic_paper_trading_enabled": bool(app.state.auto_paper_enabled),
                "portfolio": portfolio, "risk": risk,
                "recent_trades": db.list_trades(8), "recent_events": db.list_events(8)}

    @app.post("/api/scan")
    async def scan() -> dict[str, Any]:
        return await perform_scan()

    @app.get("/api/automation/scan")
    async def scan_automation_status() -> dict[str, Any]:
        return {"enabled": bool(app.state.auto_scan_enabled),
                "interval_seconds": max(30, cfg.scan_interval_seconds),
                "startup_exit_recovery": bool(app.state.startup_exit_recovery),
                "scope": "scheduled market discovery and CEX paper stop/target monitoring; automatic entries are controlled separately"}

    @app.put("/api/automation/scan")
    async def set_scan_automation(payload: ScanAutomationRequest) -> dict[str, Any]:
        cex_positions_open = any(t.get("engine") == "multi_crypto" for t in db.open_trades())
        # Exit monitoring is mandatory while CEX paper positions remain open, and
        # scans are also mandatory while auto-entry is enabled. A user toggle cannot
        # silently strand an open paper position without stop/target observation.
        required_for_positions = cex_positions_open
        required_for_auto_entries = bool(app.state.auto_paper_enabled)
        app.state.auto_scan_enabled = bool(
            payload.enabled or required_for_positions or required_for_auto_entries
        )
        db.log_event("scan_automation", "Background market scanning updated", {
            "requested_enabled": payload.enabled, "enabled": app.state.auto_scan_enabled,
            "exit_monitoring_required": required_for_positions,
            "auto_entry_scanning_required": required_for_auto_entries})
        result = await scan_automation_status()
        result["exit_monitoring_required"] = required_for_positions
        result["requested_enabled"] = payload.enabled
        return result

    @app.get("/api/automation/paper-trading")
    async def paper_trading_automation_status() -> dict[str, Any]:
        return {
            "enabled": bool(app.state.auto_paper_enabled),
            "mode": "paper_only",
            "live_trading_enabled": False,
            "scope": "CEX spot long-only paper entries/exits; Solana discovery only",
            "limits": {"max_entries_per_day": AutoPaperEngine.MAX_ENTRIES_PER_DAY,
                       "max_one_entry_per_scan": True,
                       "max_spread_bps": AutoPaperEngine.MAX_SPREAD_BPS,
                       "minimum_quote_volume_usd": AutoPaperEngine.MIN_QUOTE_VOLUME_USD,
                       "minimum_top10_orderbook_depth_quote": AutoPaperEngine.MIN_TOP10_DEPTH_QUOTE,
                       "orderbook_max_age_seconds": AutoPaperEngine.MAX_ORDERBOOK_AGE_MS // 1000,
                       "feed_max_age_seconds": AutoPaperEngine.MAX_FEED_AGE_MS // 1000,
                       "symbol_cooldown_hours": AutoPaperEngine.SYMBOL_COOLDOWN.total_seconds() / 3600},
        }

    @app.put("/api/automation/paper-trading")
    async def set_paper_trading_automation(payload: ScanAutomationRequest) -> dict[str, Any]:
        app.state.auto_paper_enabled = bool(payload.enabled)
        db.set_setting("auto_paper_enabled", app.state.auto_paper_enabled)
        cex_positions_open = any(t.get("engine") == "multi_crypto" for t in db.open_trades())
        if payload.enabled or cex_positions_open:
            # Auto-entry requires the scheduler even when no positions exist yet.
            # Open positions also require read-only exit monitoring after entries are disabled.
            app.state.auto_scan_enabled = True
        # Explicit user opt-in persists across restarts; explicit OFF remains OFF.
        # When disabling entries, read-only exit monitoring stays enabled as needed.
        db.log_event("auto_paper_trading", "Automatic paper trading switched", {
            "enabled": bool(payload.enabled), "exit_monitoring_kept_on": bool(app.state.auto_scan_enabled),
            "live_trading_enabled": False})
        result = await paper_trading_automation_status()
        result["automatic_scan_enabled"] = bool(app.state.auto_scan_enabled)
        result["exit_monitoring_required"] = cex_positions_open and not payload.enabled
        return result

    @app.get("/api/trading/modes")
    async def trading_modes() -> dict[str, Any]:
        # Use the same realized, fee-aware 30-day report shown by the dashboard.
        from datetime import datetime, timedelta, timezone
        risk = db.get_risk()
        fee_bps, slippage_bps = safe_cost_assumptions(risk)
        base = db.portfolio_summary(
            {},
            fee_bps_per_side=fee_bps,
            slippage_bps=slippage_bps,
        )
        cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
        report = build_performance_report(
            db.closed_trades_for_performance(),
            float(base["initial_capital_usd"]),
            30,
            equity_snapshots=db.list_equity_snapshots(cutoff),
        )
        return assess_demo_readiness(
            report,
            auto_demo_enabled=bool(app.state.auto_paper_enabled),
            open_positions=len(db.open_trades()),
            production_executor_enabled=False,
        )

    @app.post("/api/automation/kill-switch")
    async def kill_switch() -> dict[str, Any]:
        app.state.auto_paper_enabled = False
        db.set_setting("auto_paper_enabled", False)
        # Keep read-only scanning alive when positions remain open so stop/target
        # exits continue to be monitored; no new automatic entries can be opened.
        cex_positions_open = any(t.get("engine") == "multi_crypto" for t in db.open_trades())
        app.state.auto_scan_enabled = bool(cex_positions_open)
        db.log_event("kill_switch", "Emergency new-entry stop activated", {
            "exit_monitoring_kept_on": bool(app.state.auto_scan_enabled)})
        return {"stopped": True, "automatic_paper_trading_enabled": False,
                "automatic_scan_enabled": bool(app.state.auto_scan_enabled),
                "exit_monitoring_kept_on": bool(app.state.auto_scan_enabled),
                "live_trading_enabled": False}

    @app.post("/api/paper/orders")
    async def paper_order(payload: PaperOrderRequest) -> dict[str, Any]:
        try:
            request = payload.model_dump()
            # Reuse only a recent full scan's executable-side marks when adding manual
            # paper exposure; never silently carry an old mark into risk sizing.
            if time.time() - float(app.state.latest_marks_at) <= 120:
                request["_portfolio_marks"] = dict(app.state.latest_marks)
            trade = broker.open_long(request)
            return {"trade": trade, "mode": "paper", "message": "Simulated paper position opened; no funds moved."}
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/api/paper/close/{trade_id}")
    async def close_paper(trade_id: int, price_usd: float) -> dict[str, Any]:
        try:
            return {"trade": broker.close(trade_id, price_usd), "mode": "paper"}
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/performance")
    async def performance(days: int = 30) -> dict[str, Any]:
        period_days = max(1, min(int(days), 365))
        risk = db.get_risk()
        fee_bps, slippage_bps = safe_cost_assumptions(risk)
        base = db.portfolio_summary(
            {},
            fee_bps_per_side=fee_bps,
            slippage_bps=slippage_bps,
        )
        from datetime import datetime, timedelta, timezone
        cutoff = (datetime.now(timezone.utc) - timedelta(days=period_days)).isoformat()
        return build_performance_report(
            db.closed_trades_for_performance(),
            float(base["initial_capital_usd"]),
            period_days,
            equity_snapshots=db.list_equity_snapshots(cutoff),
        )

    @app.get("/api/performance.csv")
    async def performance_csv() -> Response:
        rows = db.closed_trades_for_performance()
        output = io.StringIO(newline="")
        writer = csv.writer(output)
        writer.writerow(["trade_id", "closed_at_utc", "engine", "symbol", "entry_price",
                         "exit_price", "quantity", "notional_usd", "fees_usd", "net_pnl_usd",
                         "return_pct", "close_reason"])
        def safe_csv_text(value: Any) -> Any:
            if isinstance(value, str) and value[:1] in {"=", "+", "-", "@", "\t", "\r"}:
                return "'" + value
            return value

        for trade in rows:
            pnl = float(trade["pnl_usd"] or 0.0)
            notional = float(trade["notional_usd"] or 0.0)
            metadata = trade.get("metadata") or {}
            reason = metadata.get("close_reason") or metadata.get("reason") or ""
            writer.writerow([trade["id"], trade.get("closed_at"), safe_csv_text(trade.get("engine")),
                             safe_csv_text(trade.get("symbol")), trade.get("entry_price"), trade.get("exit_price"),
                             trade.get("quantity"), notional, trade.get("fees_usd"), pnl,
                             (pnl / notional * 100) if notional > 0 else "", safe_csv_text(reason)])
        return Response(
            content=output.getvalue(), media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": 'attachment; filename="ai-trading-terminal-paper-trades.csv"'},
        )

    @app.get("/api/trades")
    async def trades(limit: int = 100) -> dict[str, Any]:
        return {"trades": db.list_trades(limit), "open_positions": db.open_trades()}

    @app.get("/api/events")
    async def events(limit: int = 50) -> dict[str, Any]:
        return {"events": db.list_events(limit)}

    @app.put("/api/risk")
    async def update_risk(payload: RiskUpdate) -> dict[str, Any]:
        risk = payload.model_dump()
        db.set_risk(risk)
        db.log_event("risk_updated", "Paper risk settings updated", risk)
        return {"risk": risk, "mode": "paper_only"}

    @app.post("/api/backtest")
    async def backtest(payload: BacktestRequest) -> dict[str, Any]:
        try:
            return run_ema_backtest(payload.candles, payload.fee_bps, payload.slippage_bps)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.post("/api/research/walk-forward")
    async def walk_forward(payload: WalkForwardRequest) -> dict[str, Any]:
        try:
            return run_walk_forward(payload.candles, payload.folds, payload.fee_bps, payload.slippage_bps)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.post("/api/backtest/strategy")
    async def strategy_backtest(payload: SignalBacktestRequest) -> dict[str, Any]:
        try:
            # Historical research now uses the same saved server-side costs and
            # portfolio risk settings as the paper broker, not browser defaults.
            risk = validate_risk_profile(db.get_risk())
            result = run_signal_backtest(
                payload.candles, payload.higher_timeframe_candles,
                fee_bps=float(risk["fee_bps_per_side"]),
                slippage_bps=float(risk["slippage_bps"]),
                risk_per_trade_pct=float(risk["risk_per_trade_pct"]),
                max_exposure_pct=float(risk["max_total_exposure_pct"]),
                stop_loss_pct=float(risk["stop_loss_pct"]),
                take_profit_pct=float(risk["take_profit_pct"]),
            )
            result["configuration_source"] = "current_saved_server_risk_profile"
            return result
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.post("/api/research/strategy-walk-forward")
    async def strategy_walk_forward(payload: SignalWalkForwardRequest) -> dict[str, Any]:
        try:
            risk = validate_risk_profile(db.get_risk())
            result = run_signal_walk_forward(
                payload.candles, payload.higher_timeframe_candles, payload.folds,
                fee_bps=float(risk["fee_bps_per_side"]),
                slippage_bps=float(risk["slippage_bps"]),
                risk_per_trade_pct=float(risk["risk_per_trade_pct"]),
                max_exposure_pct=float(risk["max_total_exposure_pct"]),
                stop_loss_pct=float(risk["stop_loss_pct"]),
                take_profit_pct=float(risk["take_profit_pct"]),
            )
            result["configuration_source"] = "current_saved_server_risk_profile"
            return result
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.post("/api/live/execute")
    async def live_execute() -> None:
        raise HTTPException(status_code=423, detail=(
            "Production/live execution is intentionally disabled. This route never calls a production order endpoint. "
            "The separately gated Binance Spot Testnet routes are sandbox-only and do not enable live trading."
        ))

    @app.get("/api/strategies/multi/{symbol:path}")
    async def analyze_market(symbol: str, timeframe: str = "1h", limit: int = 300) -> dict[str, Any]:
        result = await market_data.cex_strategy_data(symbol, timeframe=timeframe, limit=limit)
        if result.get("status") != "live":
            raise HTTPException(status_code=502, detail=result.get("error") or "Market analysis unavailable")
        return result

    @app.get("/api/workers")
    async def list_workers() -> dict[str, Any]:
        """Return the fixed, read-only specialist worker registry and capabilities."""
        return worker_manager.registry()

    @app.get("/api/workers/analyze/{symbol:path}")
    async def analyze_with_workers(symbol: str, timeframe: str = "1h", limit: int = 300) -> dict[str, Any]:
        """Run bounded specialist diagnostics for one CEX market; this endpoint never trades."""
        supported_timeframes = {"1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d"}
        if timeframe not in supported_timeframes:
            raise HTTPException(status_code=422, detail="Unsupported timeframe")
        if not symbol.strip() or len(symbol) > 40:
            raise HTTPException(status_code=422, detail="A valid exchange market symbol is required")
        if limit < 60 or limit > 1000:
            raise HTTPException(status_code=422, detail="Candle limit must be between 60 and 1000")

        if worker_analysis_lock.locked():
            raise HTTPException(status_code=429, detail="A specialist analysis is already running. Retry after it completes.")
        async with worker_analysis_lock:
            market = await market_data.cex_strategy_data(symbol.strip(), timeframe=timeframe, limit=limit)
            if market.get("status") != "live":
                raise HTTPException(status_code=502, detail=market.get("error") or "Market analysis unavailable")

            risk = db.get_risk()
            fee_bps, slippage_bps = safe_cost_assumptions(risk)
            fresh_marks = app.state.latest_marks if time.time() - float(app.state.latest_marks_at) <= 120 else None
            portfolio = db.portfolio_summary(
                fresh_marks,
                fee_bps_per_side=fee_bps,
                slippage_bps=slippage_bps,
            )
            context = {
                "market": market,
                "risk": risk,
                "portfolio": portfolio,
                "open_positions": db.open_trades(),
                "auto_paper_enabled": bool(app.state.auto_paper_enabled),
            }
            return await worker_manager.analyze(context)

    return app


app = create_app()
