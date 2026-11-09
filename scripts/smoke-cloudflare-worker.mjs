import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const port = 8787;
const base = "http://127.0.0.1:" + port;
const password = "SmokeTest-PaperOnly-2026!";
const secret = "smoke-test-session-secret-which-is-over-32-bytes";
const command = process.platform === "win32" ? "npx.cmd" : "npx";
const args = [
  "--yes", "wrangler@4", "dev", "--local", "--port", String(port),
  "--persist-to", ".wrangler/smoke-state",
  "--var", "ADMIN_PASSWORD:" + password,
  "--var", "SESSION_SECRET:" + secret
];

const child = spawn(command, args, {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  detached: process.platform !== "win32"
});

let output = "";
child.stdout.on("data", (chunk) => { output += chunk.toString(); });
child.stderr.on("data", (chunk) => { output += chunk.toString(); });

async function request(path, options = {}) {
  return fetch(base + path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    signal: AbortSignal.timeout(5000)
  });
}

async function loginFrom(ip, username, candidatePassword) {
  return request("/api/auth/login", {
    method: "POST",
    headers: { "cf-connecting-ip": ip },
    body: JSON.stringify({ username, password: candidatePassword })
  });
}

try {
  let ready = false;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Wrangler dev exited early: " + child.exitCode + " " + child.signalCode);
    try {
      const response = await request("/api/health");
      if (response.ok) { ready = true; break; }
      if (response.status >= 500) throw new Error("Local Worker health returned HTTP " + response.status + ": " + (await response.text()).slice(0, 1000));
    } catch {
      // The local workerd process may still be starting.
    }
    await delay(500);
  }
  assert.equal(ready, true, "Local Worker did not become ready within 90 seconds");

  const health = await request("/api/health").then((response) => response.json());
  assert.equal(health.status, "ok");
  assert.equal(health.mode, "paper_only");
  assert.equal(health.live_trading_enabled, false);
  assert.equal(health.binance_testnet_enabled, false);
  assert.equal(health.schedule_minutes, 1.5, "PAPER market/exit monitoring must use the 90-second cadence");
  assert.equal(health.schedule_seconds, 90, "health must expose the exact 90-second scan interval");
  assert.equal(health.market_data_status, "unavailable", "no current snapshots must not be reported as healthy");
  assert.ok(Object.hasOwn(health, "scheduler"), "public health must expose safe scheduler telemetry");
  assert.ok(Object.hasOwn(health, "scan_diagnostics"), "public health must expose safe scan diagnostics");
  assert.equal(health.scan_diagnostics.last_scan_status, "not_started");
  assert.equal(health.scan_diagnostics.last_scan_expected_market_count, 3);
  assert.equal(health.scan_diagnostics.last_scheduled_scan_healthy_market_count, 0);
  assert.equal(health.scan_diagnostics.last_scheduled_scan_expected_market_count, 3);
  assert.equal(health.scan_diagnostics.last_scheduled_scan_at_ms, null);
  assert.equal(health.scan_diagnostics.last_scheduled_scan_age_ms, null);
  assert.equal(health.scan_diagnostics.current_market_feed.status, "unavailable");
  assert.equal(health.scan_diagnostics.current_market_feed.healthy_market_count, 0);
  assert.equal(health.scan_diagnostics.current_market_feed.expected_market_count, 3);
  assert.deepEqual(health.scan_diagnostics.current_market_feed.issues, [
    { symbol: null, reason: "market_universe_incomplete" },
    { symbol: "BTC/USD", reason: "market_snapshot_missing" },
    { symbol: "ETH/USD", reason: "market_snapshot_missing" },
    { symbol: "SOL/USD", reason: "market_snapshot_missing" }
  ]);
  assert.deepEqual(health.scan_diagnostics.issues, []);
  assert.deepEqual(health.scan_diagnostics.provider_failures, []);
  assert.deepEqual(health.scan_diagnostics.market_data_providers, []);
  assert.equal(health.scheduler.status, "starting", "scheduler must be explicit before its first alarm");
  assert.equal(health.scheduler.last_alarm_age_ms, null, "alarm age must be null before the first alarm");
  assert.equal(health.scheduler.last_scheduled_scan_status, "not_run");
  assert.equal(health.scheduler.last_scheduled_scan_at_ms, null);
  assert.equal(health.scheduler.last_scheduled_scan_age_ms, null);
  assert.equal(health.scheduler.last_healthy_scan_age_ms, null);
  assert.ok(Object.hasOwn(health, "worker_version"), "health must expose deployment version metadata");
  assert.ok(
    health.worker_version === null ||
      (typeof health.worker_version.id === "string" &&
       (health.worker_version.tag === null || typeof health.worker_version.tag === "string")),
    "worker version metadata must be safely shaped or explicitly unavailable"
  );

  const anonymousDashboard = await request("/api/dashboard");
  assert.equal(anonymousDashboard.status, 401, "dashboard must require authentication");
  const anonymousResearch = await request("/api/research/history");
  assert.equal(anonymousResearch.status, 401, "research archive must require authentication");
  const anonymousTournament = await request("/api/research/tournament");
  assert.equal(anonymousTournament.status, 401, "strategy tournament must require authentication");

  const blockedIp = "192.0.2.10";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const failedLogin = await loginFrom(blockedIp, "admin", "wrong-password");
    assert.equal(failedLogin.status, 401, "the first eight failed attempts must be evaluated");
  }
  const blockedLogin = await loginFrom(blockedIp, "admin", "wrong-password");
  assert.equal(blockedLogin.status, 429, "the ninth login attempt inside ten minutes must be throttled");

  const successfulIp = "192.0.2.11";
  const loginResponse = await loginFrom(successfulIp, "admin", password);
  assert.equal(loginResponse.status, 200, "valid owner login must succeed from a separate source");
  const login = await loginResponse.json();
  assert.equal(login.token_type, "Bearer");
  assert.ok(login.access_token);

  // A successful login resets that source's failed-attempt history.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const failedLogin = await loginFrom(successfulIp, "admin", "wrong-password");
    assert.equal(failedLogin.status, 401, "a successful login must clear prior failed attempts");
  }
  const blockedAfterFailures = await loginFrom(successfulIp, "admin", "wrong-password");
  assert.equal(blockedAfterFailures.status, 429, "the source must be throttled after eight new failures");

  const auth = { authorization: "Bearer " + login.access_token };
  const dashboardResponse = await request("/api/dashboard", { headers: auth });
  assert.equal(dashboardResponse.status, 200, "owner dashboard must load");
  const dashboard = await dashboardResponse.json();
  assert.equal(dashboard.mode, "paper_only");
  assert.equal(dashboard.settings.auto_paper_enabled, false, "automatic PAPER entries must start OFF until the owner explicitly opts in");
  assert.equal(dashboard.settings.paper_initial_capital_usd, 10, "fresh paper profile must use ten dollars");
  assert.equal(dashboard.settings.risk.max_open_positions, 1, "only one sequential paper position is allowed");
  assert.equal(dashboard.settings.risk.max_position_notional_usd, 8, "position notional must leave a two-dollar reserve");
  assert.equal(dashboard.settings.risk.max_daily_loss_pct, 1, "daily hard loss guard must be one percent");
  assert.equal(dashboard.live_trading_enabled, false);
  assert.deepEqual(dashboard.research_history, [], "research archive starts empty before a successful live-data scan");
  const emptyChart = await request("/api/market/candles?symbol=BTC%2FUSD&timeframe=3600&limit=72", { headers: auth });
  assert.equal(emptyChart.status, 200);
  const emptyChartData = await emptyChart.json();
  assert.equal(emptyChartData.status, "insufficient_history");
  assert.equal(emptyChartData.source, "coinbase_exchange_closed_candle_archive");
  assert.deepEqual(emptyChartData.bars, []);
  const invalidChart = await request("/api/market/candles?symbol=UNKNOWN%2FUSD", { headers: auth });
  assert.equal(invalidChart.status, 400);



  const tradingModeResponse = await request("/api/trading/mode", { headers: auth });
  assert.equal(tradingModeResponse.status, 200, "owner trading-mode API must load");
  const initialTradingMode = await tradingModeResponse.json();
  assert.equal(initialTradingMode.mode, "demo", "DEMO must be the safe default");
  assert.equal(initialTradingMode.demo.data_source, "coinbase_public_market_data");
  assert.equal(initialTradingMode.demo.execution, "simulated_paper_ledger");
  assert.equal(initialTradingMode.real.order_submission_available, false);

  const selectRealMode = await request("/api/trading/mode", {
    method: "PUT", headers: auth, body: JSON.stringify({ mode: "real" })
  });
  assert.equal(selectRealMode.status, 200, "REAL account-connection mode can be selected without enabling execution");
  const realModeState = await selectRealMode.json();
  assert.equal(realModeState.mode, "real");
  assert.equal(realModeState.live_execution_enabled, false);
  assert.equal(realModeState.paper_auto_enabled, false);

  const blockedPaperInRealMode = await request("/api/automation/paper-trading", {
    method: "PUT", headers: auth, body: JSON.stringify({ enabled: true })
  });
  assert.equal(blockedPaperInRealMode.status, 409, "paper automation must not start in REAL mode");
  assert.equal((await blockedPaperInRealMode.json()).error, "select_demo_mode_before_enabling_paper_automation");

  const returnDemoMode = await request("/api/trading/mode", {
    method: "PUT", headers: auth, body: JSON.stringify({ mode: "demo" })
  });
  assert.equal(returnDemoMode.status, 200);
  assert.equal((await returnDemoMode.json()).paper_auto_enabled, false, "switching back to DEMO must not silently re-enable auto-entry");

  const liveStatusResponse = await request("/api/live/status", { headers: auth });
  assert.equal(liveStatusResponse.status, 200, "owner live-readiness API must load");
  const liveStatus = await liveStatusResponse.json();
  assert.equal(liveStatus.mode, "live_setup_locked");
  assert.equal(liveStatus.order_submission_available, false, "static status must never claim a fresh account preflight");
  assert.equal(liveStatus.order_submission_configured, false);
  assert.equal(liveStatus.live_trading_enabled, false);
  assert.equal(liveStatus.automatic_live_entries_enabled, false);
  assert.equal(liveStatus.credentials_configured, false, "local smoke must not rely on exchange credentials");

  const livePreflightResponse = await request("/api/live/preflight", {
    method: "POST", headers: auth, body: "{}"
  });
  assert.equal(livePreflightResponse.status, 200);
  const livePreflight = await livePreflightResponse.json();
  assert.equal(livePreflight.status, "not_configured");
  assert.equal(livePreflight.order_submission_available, false);

  const previewInDemo = await request("/api/live/order-preview", {
    method: "POST", headers: auth,
    body: JSON.stringify({ product_id: "BTC-USD", side: "BUY", quote_size: "5.00", limit_price: "90000.00" })
  });
  assert.equal(previewInDemo.status, 409, "preview must require explicit REAL mode");

  const liveFillLedgerResponse = await request("/api/live/fills", { headers: auth });
  assert.equal(liveFillLedgerResponse.status, 200);
  const liveFillLedger = await liveFillLedgerResponse.json();
  assert.equal(liveFillLedger.mode, "exchange_reported_fill_ledger");
  assert.equal(liveFillLedger.pnl_status, "not_calculated_fee_currency_and_fifo_accounting_not_yet_verified");

  const blockedLiveExecute = await request("/api/live/execute", {
    method: "POST", headers: auth,
    body: JSON.stringify({ confirm_real_order: true, client_order_id: "12345678-1234-1234-1234-123456789012", preview_token: "00000000-0000-4000-8000-000000000000", product_id: "BTC-USD", quote_size: "10" })
  });
  assert.equal(blockedLiveExecute.status, 409, "manual REAL execution must require REAL mode before all other checks");
  const blockedLiveBody = await blockedLiveExecute.json();
  assert.ok(blockedLiveBody.blockers.includes("real_mode_must_be_selected"));
  assert.equal(blockedLiveBody.live_trading_enabled, false);

  const initialScheduler = await request("/api/automation/status", { headers: auth });
  assert.equal(initialScheduler.status, 200, "owner scheduler watchdog API must load");
  const scheduler = await initialScheduler.json();
  assert.equal(scheduler.scanner_status, "starting", "scheduler watchdog must expose starting state before its first scheduled alarm");
  assert.equal(scheduler.continuous_monitoring, true);
  assert.equal(scheduler.automatic_watchdog_recovery, true);
  assert.equal(scheduler.daily_cycle_limit, 5);
  assert.equal(scheduler.daily_cycles_used, 0);
  assert.equal(scheduler.daily_cycles_remaining, 5);
  assert.equal(scheduler.live_trading_enabled, false);
  assert.equal(scheduler.last_scan_age_ms, null, "scan age must be null before the first completed scan");
  assert.equal(scheduler.last_scheduled_alarm_age_ms, null, "scheduled heartbeat age must be null before the first alarm");
  assert.equal(scheduler.last_scheduled_scan_status, "not_run", "scheduled scan state must be explicit before first alarm");
  assert.ok(Number.isFinite(scheduler.next_alarm_in_ms), "scheduler watchdog must expose the next durable alarm countdown");
  assert.ok(scheduler.next_alarm_in_ms >= 0 && scheduler.next_alarm_in_ms <= 30000, "first alarm must be scheduled within 30 seconds");
  const researchHistory = await request("/api/research/history", { headers: auth });
  assert.equal(researchHistory.status, 200, "owner research-history API must load");
  const researchPayload = await researchHistory.json();
  assert.equal(researchPayload.mode, "read_only");
  assert.deepEqual(researchPayload.history, []);

  const tournamentResponse = await request("/api/research/tournament", { headers: auth });
  assert.equal(tournamentResponse.status, 200, "owner strategy tournament API must load");
  const tournament = await tournamentResponse.json();
  assert.equal(tournament.mode, "offline_research_only");
  assert.equal(tournament.no_trading_side_effects, true);
  assert.equal(tournament.strategy_comparability.status, "not_equivalent");
  assert.equal(tournament.strategy_comparability.production_paper_strategy.version, "cloud-paper-v1");
  assert.ok(tournament.strategy_comparability.limitations.length >= 2);
  assert.equal(tournament.assets.length, 3);
  assert.ok(tournament.assets.every((asset) => asset.exploratory.ok === false));
  const settingsAfterResearch = await request("/api/automation/paper-trading", { headers: auth }).then((r) => r.json());
  assert.equal(settingsAfterResearch.enabled, false, "read-only research must not enable PAPER automation by itself");
  const analyticsBeforeTrades = await request("/api/analytics", { headers: auth }).then((r) => r.json());
  assert.equal(analyticsBeforeTrades.execution_audit.sample_count, 0);
  assert.equal(analyticsBeforeTrades.execution_audit.average_entry_spread_bps, null);

  const unnecessaryCapitalReview = await request("/api/automation/capital-review", {
    method: "POST", headers: auth,
    body: JSON.stringify({ action: "keep_existing_capital", confirmed: true })
  });
  assert.equal(unnecessaryCapitalReview.status, 409, "a fresh ledger must not accept a legacy capital review");
  assert.equal((await unnecessaryCapitalReview.json()).error, "capital_review_not_required");

  const enableWithoutFreshScan = await request("/api/automation/paper-trading", {
    method: "PUT", headers: auth, body: JSON.stringify({ enabled: true })
  });
  assert.equal(enableWithoutFreshScan.status, 409, "auto-entry must require a recent complete scheduled scan");
  assert.equal((await enableWithoutFreshScan.json()).error, "fresh_complete_scheduled_scan_required");

  const stop = await request("/api/automation/kill-switch", { method: "POST", headers: auth });
  assert.equal(stop.status, 200);
  assert.equal((await stop.json()).halted, true);

  const statusAfterStop = await request("/api/automation/status", { headers: auth }).then((r) => r.json());
  assert.equal(statusAfterStop.enabled, false);
  assert.equal(statusAfterStop.halted, true);

  const reset = await request("/api/automation/reset", { method: "POST", headers: auth });
  assert.equal(reset.status, 200);
  const statusAfterReset = await request("/api/automation/status", { headers: auth }).then((r) => r.json());
  assert.equal(statusAfterReset.enabled, false);
  assert.equal(statusAfterReset.halted, false);

  const staticPage = await request("/");
  assert.equal(staticPage.status, 200);
  const staticHtml = await staticPage.text();
  assert.match(staticHtml, /AI TRADING TERMINAL/);
  assert.match(staticHtml, /ENTRY GATE/);
  assert.match(staticHtml, /Per-market gate results are read-only diagnostics/);
  assert.match(staticHtml, /Research data archive/);
  assert.match(staticHtml, /schedulerLabels/);
  assert.match(staticHtml, /last_scan_error/);
  assert.match(staticHtml, /next_alarm_in_ms/);
  assert.match(staticHtml, /id="researchHistory"/);
  assert.match(staticHtml, /REAL MODE · Coinbase Advanced account connection/);
  assert.match(staticHtml, /id="demoModeBtn"/);
  assert.match(staticHtml, /id="realModeBtn"/);
  assert.match(staticHtml, /Live market monitor/);
  assert.match(staticHtml, /id="marketChart"/);
  assert.match(staticHtml, /display-only market prices/);
  assert.match(staticHtml, /api\/market\/candles/);
  assert.match(staticHtml, /Automatic PAPER entries start OFF/);
  assert.match(staticHtml, /id="capitalReview"/);
  assert.match(staticHtml, /manually confirmed SPOT LIMIT GTC post-only BUY\/SELL orders/);
  assert.match(staticHtml, /id="liveSide"/);
  assert.match(staticHtml, /id="liveBaseSize"/);
  assert.match(staticHtml, /Confirm &amp; submit REAL order/);
  assert.match(staticHtml, /crypto\.randomUUID\(\)/);
  assert.match(staticHtml, /REAL COINBASE ORDER CONFIRMATION/);
  assert.match(staticHtml, /withdrawals are never enabled/);
  assert.match(staticHtml, /id="liveReconcile"/);
  assert.match(staticHtml, /api\/live\/fills\?limit=100/);
  assert.match(staticHtml, /preview_token:preview\.preview_token/);
  assert.match(staticHtml, /bound server-side/);
  assert.match(staticHtml, /Strategy tournament/);
  assert.match(staticHtml, /NOT A BACKTEST OF THE PRODUCTION PAPER BOT/);
  assert.match(staticHtml, /cloud-paper-v1/);
  assert.match(staticHtml, /id="runTournament"/);
  assert.match(staticHtml, /Modeled execution audit/);
  assert.match(staticHtml, /MODELED PAPER EXECUTION/);
  assert.match(staticHtml, /Paper equity curve/);
  assert.match(staticHtml, /Actual stored portfolio snapshots/);
  assert.match(staticHtml, /renderEquityHistory\(x\.equity_history\|\|\[\]\)/);
  assert.match(staticHtml, /VERIFIED SAMPLES/);
  assert.match(staticHtml, /no synthetic points/);

  process.stdout.write("CLOUDFLARE_LOCAL_RUNTIME_SMOKE_OK\n");
} catch (error) {
  process.stderr.write(output.slice(-12000) + "\n");
  process.stderr.write(String(error?.stack || error) + "\n");
  process.exitCode = 1;
} finally {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch { /* The process may already have exited. */ }
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(4000)
  ]);
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
    else if (child.exitCode === null) child.kill("SIGKILL");
  } catch { /* The process group may already have exited. */ }
}
