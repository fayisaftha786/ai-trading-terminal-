import { DurableObject } from "cloudflare:workers";
import { PRODUCTS, createCoinbaseRequestState, fetchBitstampOrderBook, fetchCoinbaseOrderBook, fetchProductSnapshot } from "./coinbase.js";
import { evaluateMicroScalpResearch } from "./micro-scalp.js";
import {
  coinbaseAdvancedErrorStatus,
  coinbaseAdvancedStatus,
  preflightCoinbaseAdvanced,
  previewCoinbaseAdvancedLimitBuy,
  submitCoinbaseAdvancedLimitBuy,
  reconcileCoinbaseAdvancedOrder,
  cancelCoinbaseAdvancedOrder,
  listCoinbaseAdvancedFills
} from "./coinbase-advanced.js";
import { analyzeTimeframe, assessCandidate, assessCrossMarketContext, buildFreshBidMarks, evaluateResearchCandidates, isFreshBidQuote, resolveRiskBaseline } from "./strategy.js";
import { assessMarketUniverse, hasRecentHealthyScheduledScan, advanceUnhealthyScanStreak, assessAdaptiveRisk, assessLossCooldown, buildMarketDataProviderDiagnostics, classifyMarketFeedFreshness, deriveSchedulerStatus, normalizeProviderFailureRows, normalizeScanIssueRows, mergeScanRuntimeState, runAfterActiveScan, shouldHaltPaperAutomation, shouldRunScheduledMarketScan, summarizeCurrentProviderFailures, updateTrailingStop } from "./automation-guards.js";
import { buildResearchHistorySummary, countMissingArchiveBars, selectNewClosedCandles } from "./research.js";
import { runRecursiveWarmupAnalysis, runStrategyTournament, runWalkForwardResearch } from "./strategy-tournament.js";
import { PAPER_AUTOMATION_PROFILE, PAPER_AUTOMATION_RISK, calculateDynamicTakeProfit, getDailyCycleAllowance, countCompletedPaperCyclesInWindow, migratePaperAutomationSettings, shouldAutoResumeWatchdog, shouldResumePaperAutomationAfterWatchdog, reviewLegacyPaperCapital } from "./paper-automation-profile.js";
import { normalizeTradingMode, selectTradingMode } from "./trading-mode.js";
import { summarizePaperExecution } from "./execution-audit.js";
import { createServerLivePreview, consumeServerLivePreview } from "./live-order-authorization.js";

const SCAN_INTERVAL_MS = 90 * 1000; // Strategy/candle scan cadence.
const BOOK_REFRESH_INTERVAL_MS = 10 * 1000;
const DASHBOARD_ANALYTICS_SAMPLE_LIMIT = 250; // Independent L2-only refresh cadence.
const MAX_QUOTE_AGE_MS = 120000;
const MAX_ORDER_BOOK_AGE_MS = 15000;
const DEFAULT_RISK = { ...PAPER_AUTOMATION_RISK };

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store, private" }
  });
}


async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const lanes = Math.max(1, Math.min(items.length, Math.trunc(concurrency) || 1));
  await Promise.all(Array.from({ length: lanes }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

export class TradingEngine extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.sql = ctx.storage.sql;
    this.scanPromise = null;
    const schemaStatements = [
      "CREATE TABLE IF NOT EXISTS app_state(key TEXT PRIMARY KEY,value_json TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS market_snapshots(symbol TEXT PRIMARY KEY,status TEXT NOT NULL,observed_at_ms INTEGER NOT NULL,data_json TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS trades(id INTEGER PRIMARY KEY AUTOINCREMENT,symbol TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('OPEN','CLOSED')),entry_price REAL NOT NULL,quantity REAL NOT NULL,notional_usd REAL NOT NULL,stop_loss REAL NOT NULL,take_profit REAL NOT NULL,fees_usd REAL NOT NULL DEFAULT 0,pnl_usd REAL,opened_at_ms INTEGER NOT NULL,closed_at_ms INTEGER,exit_price REAL,metadata_json TEXT NOT NULL DEFAULT '{}')",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_trade_per_symbol ON trades(symbol) WHERE status='OPEN'",
      "CREATE INDEX IF NOT EXISTS idx_trades_opened_at ON trades(opened_at_ms)",
      "CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,event_type TEXT NOT NULL,message TEXT NOT NULL,created_at_ms INTEGER NOT NULL,metadata_json TEXT NOT NULL DEFAULT '{}')",
      "CREATE TABLE IF NOT EXISTS auth_login_attempts(id INTEGER PRIMARY KEY AUTOINCREMENT,ip_hash TEXT NOT NULL,attempted_at_ms INTEGER NOT NULL)",
      "CREATE INDEX IF NOT EXISTS idx_auth_login_attempts_ip_time ON auth_login_attempts(ip_hash,attempted_at_ms)",
      "CREATE TABLE IF NOT EXISTS scan_cycles(cycle_key TEXT PRIMARY KEY,started_at_ms INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS equity_snapshots(id INTEGER PRIMARY KEY AUTOINCREMENT,at_ms INTEGER NOT NULL,equity_usd REAL NOT NULL,realized_pnl_usd REAL NOT NULL,unrealized_pnl_usd REAL NOT NULL,open_positions INTEGER NOT NULL,drawdown_pct REAL NOT NULL)",
      "CREATE TABLE IF NOT EXISTS research_candles(exchange TEXT NOT NULL,product TEXT NOT NULL,timeframe_seconds INTEGER NOT NULL,candle_open_ms INTEGER NOT NULL,open REAL NOT NULL,high REAL NOT NULL,low REAL NOT NULL,close REAL NOT NULL,volume REAL NOT NULL,received_at_ms INTEGER NOT NULL,schema_version INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(exchange,product,timeframe_seconds,candle_open_ms))",
      "CREATE INDEX IF NOT EXISTS idx_research_candles_product_time ON research_candles(product,timeframe_seconds,candle_open_ms)",
      "CREATE TABLE IF NOT EXISTS research_history_state(product TEXT NOT NULL,timeframe_seconds INTEGER NOT NULL,bars_count INTEGER NOT NULL DEFAULT 0,first_candle_ms INTEGER,last_candle_ms INTEGER,cumulative_missing_intervals INTEGER NOT NULL DEFAULT 0,last_quality_check_at_ms INTEGER,last_ingested_at_ms INTEGER,last_quality_status TEXT NOT NULL DEFAULT 'not_started',PRIMARY KEY(product,timeframe_seconds))",
      "CREATE TABLE IF NOT EXISTS live_fills(entry_id TEXT PRIMARY KEY,trade_id TEXT,order_id TEXT NOT NULL,client_order_id TEXT NOT NULL,product_id TEXT NOT NULL,side TEXT NOT NULL,trade_type TEXT NOT NULL,trade_time TEXT NOT NULL,sequence_timestamp TEXT,price TEXT NOT NULL,size TEXT NOT NULL,commission TEXT NOT NULL,liquidity_indicator TEXT,size_in_quote INTEGER NOT NULL DEFAULT 0,imported_at_ms INTEGER NOT NULL,raw_json TEXT NOT NULL DEFAULT '{}')",
      "CREATE INDEX IF NOT EXISTS idx_live_fills_order_time ON live_fills(order_id,trade_time)",
      "CREATE INDEX IF NOT EXISTS idx_live_fills_client_time ON live_fills(client_order_id,trade_time)"
    ];
    // Durable Object SQL exec expects a single statement per call.
    for (const statement of schemaStatements) this.sql.exec(statement);
    this.sql.exec(
      "INSERT OR IGNORE INTO app_state(key,value_json) VALUES(?,?)",
      "settings",
      JSON.stringify({ initial_capital_usd: 10, trading_mode: "demo", risk: DEFAULT_RISK, auto_paper_enabled: false, halted: false, halt_reason: null, peak_equity_usd: 10, paper_automation_profile_version: PAPER_AUTOMATION_PROFILE.version, capital_setup_required: false })
    );
    const currentSettings = this.getState("settings");
    // The profile migration only needs to know whether any historical trade exists.
    // Avoid a full-ledger COUNT scan every time the Durable Object is instantiated.
    let migratedSettings = currentSettings;
    if (Number(currentSettings?.paper_automation_profile_version || 0) < PAPER_AUTOMATION_PROFILE.version) {
      const hasHistoricalTrades = this.sql.exec(
        "SELECT 1 AS has_trades FROM trades LIMIT 1"
      ).toArray().length > 0;
      migratedSettings = migratePaperAutomationSettings(currentSettings, hasHistoricalTrades ? 1 : 0);
    }
    if (JSON.stringify(currentSettings) !== JSON.stringify(migratedSettings)) {
      this.setState("settings", migratedSettings);
    }
    this.sql.exec(
      "INSERT OR IGNORE INTO app_state(key,value_json) VALUES(?,?)",
      "runtime",
      JSON.stringify({ last_scan_at_ms: null, last_scan_status: "not_started", last_scan_error: null, healthy_scheduled_scan_streak: 0 })
    );
  }

  getState(key) {
    const rows = this.sql.exec("SELECT value_json FROM app_state WHERE key=?", key).toArray();
    if (!rows.length) return null;
    try { return JSON.parse(rows[0].value_json); } catch { return null; }
  }

  setState(key, value) {
    this.sql.exec(
      "INSERT INTO app_state(key,value_json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
      key, JSON.stringify(value)
    );
  }

  logEvent(type, message, metadata = {}) {
    this.sql.exec(
      "INSERT INTO events(event_type,message,created_at_ms,metadata_json) VALUES(?,?,?,?)",
      String(type).slice(0, 80), String(message).slice(0, 240), Date.now(), JSON.stringify(metadata)
    );
    this.sql.exec("DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 500)");
  }

  loadResearchCandleCache(product, timeframeSeconds, exchange = "coinbase_exchange") {
    return this.sql.exec(
      "SELECT candle_open_ms AS time,open,high,low,close,volume FROM research_candles " +
      "WHERE exchange=? AND product=? AND timeframe_seconds=? " +
      "ORDER BY candle_open_ms DESC LIMIT 150",
      exchange, product, timeframeSeconds
    ).toArray().reverse().map((row) => ({
      time: Number(row.time),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume)
    }));
  }

  async ensureAlarm() {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null) {
      const dueAt = Date.now() + BOOK_REFRESH_INTERVAL_MS;
      const runtime = this.getState("runtime") || {};
      runtime.next_alarm_at_ms = dueAt;
      this.setState("runtime", runtime);
      await this.ctx.storage.setAlarm(dueAt);
    }
  }


  async fetch(request) {
    const url = new URL(request.url);
    try {
      // Alarm setup is best-effort for interactive API requests. Keep health and
      // owner diagnostics reachable if the scheduler alarm/storage path is degraded.
      try {
        await this.ensureAlarm();
      } catch (error) {
        console.error("Trading engine alarm initialization failed", {
          name: typeof error?.name === "string" ? error.name : "Error",
          message: String(error?.message || error).slice(0, 180)
        });
      }

      if (request.method === "GET" && url.pathname === "/api/health") {
        // Expose only non-sensitive scheduler telemetry publicly so an external
        // watchdog can distinguish a live Worker from a stalled Durable Object alarm.
        const runtime = this.getState("runtime") || {};
        const nowMs = Date.now();
        const lastAlarmValue = Number(runtime.last_scheduled_alarm_at_ms);
        const lastAlarmAtMs = Number.isFinite(lastAlarmValue) && lastAlarmValue > 0 && lastAlarmValue <= nowMs + 5000
          ? lastAlarmValue : null;
        const scheduler = deriveSchedulerStatus({
          lastScheduledAlarmAtMs: lastAlarmAtMs,
          lastScheduledScanStatus: runtime.last_scheduled_scan_status,
          nowMs,
          staleAfterMs: SCAN_INTERVAL_MS * 3
        });
        const lastHealthyValue = Number(runtime.last_healthy_scheduled_scan_at_ms);
        const lastHealthyAtMs = Number.isFinite(lastHealthyValue) && lastHealthyValue > 0 && lastHealthyValue <= nowMs + 5000
          ? lastHealthyValue : null;
        const nextAlarmValue = Number(runtime.next_alarm_at_ms);
        const nextAlarmAtMs = Number.isFinite(nextAlarmValue) && nextAlarmValue > 0
          ? nextAlarmValue : null;
        const allowedScanStatuses = new Set(["running", "completed", "partial", "unavailable", "error"]);
        const scanStatus = allowedScanStatuses.has(runtime.last_scheduled_scan_status)
          ? runtime.last_scheduled_scan_status : "not_run";
        const currentMarkets = this.getMarkets().slice(0, PRODUCTS.length);
        const currentMarketFeed = assessMarketUniverse(
          currentMarkets, PRODUCTS.map((product) => product.symbol), nowMs,
          MAX_QUOTE_AGE_MS, MAX_ORDER_BOOK_AGE_MS
        );
        const currentMarketStatus = currentMarketFeed.healthy ? "healthy"
          : currentMarketFeed.healthy_market_count > 0 ? "partial" : "unavailable";
        const lastScheduledScanAgeMs = Number.isFinite(Number(runtime.last_scheduled_scan_at_ms)) &&
          Number(runtime.last_scheduled_scan_at_ms) > 0
          ? Math.max(0, nowMs - Number(runtime.last_scheduled_scan_at_ms)) : null;
        const marketFeedFreshness = classifyMarketFeedFreshness({
          currentFeedHealthy: currentMarketFeed.healthy,
          lastScheduledScanStatus: scanStatus,
          lastScheduledHealthyMarketCount: runtime.last_scheduled_scan_healthy_market_count,
          lastScheduledExpectedMarketCount: runtime.last_scheduled_scan_expected_market_count || PRODUCTS.length,
          lastScheduledScanAgeMs,
          staleAfterMs: SCAN_INTERVAL_MS * 3
        });
        const diagnosticIssues = normalizeScanIssueRows(runtime);
        const diagnosticProviderFailures = normalizeProviderFailureRows(runtime, diagnosticIssues);
        const currentProviderFailures = summarizeCurrentProviderFailures(currentMarkets);
        const marketDataProviders = buildMarketDataProviderDiagnostics(currentMarkets, nowMs, PRODUCTS.length);
        const diagnostics = {
          last_scan_status: runtime.last_scan_status || "not_started",
          last_scan_age_ms: Number.isFinite(Number(runtime.last_scan_at_ms)) && Number(runtime.last_scan_at_ms) > 0
            ? Math.max(0, nowMs - Number(runtime.last_scan_at_ms)) : null,
          last_scan_error: runtime.last_scan_error ? String(runtime.last_scan_error).slice(0, 160) : null,
          last_scheduled_scan_error: runtime.last_scheduled_scan_error
            ? String(runtime.last_scheduled_scan_error).slice(0, 160) : null,
          last_scheduled_scan_at_ms: Number.isFinite(Number(runtime.last_scheduled_scan_at_ms)) &&
            Number(runtime.last_scheduled_scan_at_ms) > 0
            ? Number(runtime.last_scheduled_scan_at_ms) : null,
          last_scheduled_scan_age_ms: Number.isFinite(Number(runtime.last_scheduled_scan_at_ms)) &&
            Number(runtime.last_scheduled_scan_at_ms) > 0
            ? nowMs - Number(runtime.last_scheduled_scan_at_ms) : null,
          last_scheduled_scan_healthy_market_count:
            Number(runtime.last_scheduled_scan_healthy_market_count) || 0,
          last_scheduled_scan_expected_market_count:
            Number(runtime.last_scheduled_scan_expected_market_count) || PRODUCTS.length,
          last_scheduled_scan_issues: (Array.isArray(runtime.last_scheduled_scan_issues)
            ? runtime.last_scheduled_scan_issues : []).slice(0, 9).map((issue) => ({
              symbol: typeof issue?.symbol === "string" ? issue.symbol.slice(0, 24) : null,
              reason: typeof issue?.reason === "string" ? issue.reason.slice(0, 160) : "unknown"
            })),
          // These counts describe the last completed scan, not the live age of
          // the persisted quotes. Current snapshot health is reported separately below.
          last_scan_healthy_market_count: Number(runtime.healthy_market_count) || 0,
          last_scan_expected_market_count: Number(runtime.expected_market_count) || PRODUCTS.length,
          last_book_refresh_at_ms: Number(runtime.last_book_refresh_at_ms) > 0
            ? Number(runtime.last_book_refresh_at_ms) : null,
          last_book_refresh_age_ms: Number(runtime.last_book_refresh_at_ms) > 0
            ? Math.max(0, nowMs - Number(runtime.last_book_refresh_at_ms)) : null,
          last_book_refresh_status: runtime.last_book_refresh_status || "not_started",
          last_book_refresh_success_count: Number(runtime.last_book_refresh_success_count) || 0,
          last_book_refresh_failed_count: Number(runtime.last_book_refresh_failed_count) || 0,
          last_book_refresh_skipped_count: Number(runtime.last_book_refresh_skipped_count) || 0,
          last_book_refresh_healthy_market_count: Number(runtime.last_book_refresh_healthy_market_count) || 0,
          last_book_refresh_expected_market_count: Number(runtime.last_book_refresh_expected_market_count) || PRODUCTS.length,
          last_book_refresh_issues: (Array.isArray(runtime.last_book_refresh_issues)
            ? runtime.last_book_refresh_issues : []).slice(0, PRODUCTS.length).map((issue) => ({
              symbol: typeof issue?.symbol === "string" ? issue.symbol.slice(0, 24) : null,
              reason: typeof issue?.reason === "string" ? issue.reason.slice(0, 120) : "unknown"
            })),
          current_market_feed: {
            status: currentMarketStatus,
            freshness_state: marketFeedFreshness.state,
            freshness_reason: marketFeedFreshness.reason,
            healthy: currentMarketFeed.healthy,
            healthy_market_count: currentMarketFeed.healthy_market_count,
            expected_market_count: currentMarketFeed.expected_market_count,
            issues: currentMarketFeed.issues.slice(0, 9).map((issue) => ({
              symbol: typeof issue?.symbol === "string" ? issue.symbol.slice(0, 24) : null,
              reason: typeof issue?.reason === "string" ? issue.reason.slice(0, 160) : "unknown"
            })),
            checked_at_ms: nowMs
          },
          consecutive_unhealthy_scheduled_scans: Number(runtime.consecutive_unhealthy_scheduled_scans) || 0,
          issues: diagnosticIssues
            .slice(0, 6)
            .map((issue) => ({
              symbol: typeof issue?.symbol === "string" ? issue.symbol.slice(0, 24) : null,
              reason: typeof issue?.reason === "string" ? issue.reason.slice(0, 120) : "unknown"
            })),
          provider_failures: [
            ...currentProviderFailures,
            ...diagnosticProviderFailures
          ]
            .filter((failure, index, rows) =>
              rows.findIndex((item) => item.symbol === failure.symbol && item.reason === failure.reason) === index
            )
            .slice(0, 6)
            .map((failure) => ({
              symbol: typeof failure?.symbol === "string" ? failure.symbol.slice(0, 24) : null,
              reason: typeof failure?.reason === "string" ? failure.reason.slice(0, 120) : "unknown",
              primary_error_code: typeof failure?.primary_error_code === "string"
                ? failure.primary_error_code.slice(0, 80) : null,
              backup_error_code: typeof failure?.backup_error_code === "string"
                ? failure.backup_error_code.slice(0, 80) : null,
              inferred_from_scan_summary: failure?.inferred_from_scan_summary === true
            })),
          market_data_providers: marketDataProviders
        };
        return jsonResponse({
          status: "ok", mode: "paper_only", engine: "cloudflare_durable_object_sqlite",
          schedule_minutes: SCAN_INTERVAL_MS / 60000,
          schedule_seconds: SCAN_INTERVAL_MS / 1000,
          book_refresh_seconds: BOOK_REFRESH_INTERVAL_MS / 1000,
          live_trading_enabled: false,
          market_data_status: currentMarketStatus,
          market_freshness_policy: {
            scheduler_interval_ms: BOOK_REFRESH_INTERVAL_MS,
            strategy_scan_interval_ms: SCAN_INTERVAL_MS,
            book_refresh_interval_ms: BOOK_REFRESH_INTERVAL_MS,
            quote_max_age_ms: MAX_QUOTE_AGE_MS,
            order_book_max_age_ms: MAX_ORDER_BOOK_AGE_MS,
            theoretical_book_fresh_window_ms: MAX_ORDER_BOOK_AGE_MS,
            theoretical_stale_gap_between_book_refreshes_ms: Math.max(0, BOOK_REFRESH_INTERVAL_MS - MAX_ORDER_BOOK_AGE_MS),
            note: "Strategy/candle scans run every 90 seconds; a separate L2-only refresh targets every 10 seconds. Order books still expire after the strict 15-second gate. Missed or failed refreshes make the feed unavailable and block new entries."
          },
          scheduler: {
            status: scheduler.status,
            last_alarm_at_ms: lastAlarmAtMs,
            last_alarm_age_ms: scheduler.ageMs,
            last_scheduled_scan_status: scanStatus,
            last_scheduled_scan_error: diagnostics.last_scheduled_scan_error,
            last_scheduled_scan_at_ms: diagnostics.last_scheduled_scan_at_ms,
            last_scheduled_scan_age_ms: diagnostics.last_scheduled_scan_age_ms,
            last_healthy_scan_at_ms: lastHealthyAtMs,
            last_healthy_scan_age_ms: lastHealthyAtMs === null ? null : Math.max(0, nowMs - lastHealthyAtMs),
            next_alarm_at_ms: nextAlarmAtMs
          },
          scan_diagnostics: diagnostics
        });
      }
      // Manual REAL execution is separate from automatic PAPER entries.
      // Submission requires a fresh server-bound preview and explicit owner confirmation.
      if (request.method === "POST" && url.pathname === "/api/live/execute") {
        const settings = this.getState("settings") || {};
        if (normalizeTradingMode(settings.trading_mode) !== "real") {
          return jsonResponse({
            status: "blocked",
            blockers: ["real_mode_must_be_selected"],
            order_submission_available: false,
            live_trading_enabled: false,
            automatic_live_entries_enabled: false
          }, 409);
        }
        const executionStatus = coinbaseAdvancedStatus(this.env);
        if (!executionStatus.order_submission_configured) {
          return jsonResponse({
            status: "blocked",
            blockers: [...executionStatus.blockers, "guarded_live_execution_switch_or_credentials_or_limits_not_configured"],
            order_submission_available: false,
            live_trading_enabled: false,
            automatic_live_entries_enabled: false
          }, 423);
        }
        let rawBody;
        try { rawBody = await request.text(); } catch {
          return jsonResponse({ status: "blocked", blockers: ["invalid_request_body"] }, 400);
        }
        if (new TextEncoder().encode(rawBody).byteLength > 2048) {
          return jsonResponse({ status: "blocked", blockers: ["request_too_large"] }, 413);
        }
        let body;
        try { body = JSON.parse(rawBody); } catch {
          return jsonResponse({ status: "blocked", blockers: ["invalid_json"] }, 400);
        }
        const clientOrderId = body?.client_order_id;
        const previewToken = body?.preview_token;
        if (body?.confirm_real_order !== true ||
            typeof clientOrderId !== "string" ||
            !/^[A-Za-z0-9-]{16,64}$/.test(clientOrderId) ||
            typeof previewToken !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(previewToken)) {
          return jsonResponse({ status: "blocked", blockers: ["explicit_confirmation_client_order_id_and_server_preview_token_required"] }, 400);
        }
        const records = this.getState("coinbase_live_orders") || [];
        const prior = records.find((item) => item.client_order_id === clientOrderId);
        if (prior) return jsonResponse({ status: "duplicate_or_existing_order", order: prior }, 409);
        const active = records.filter((item) => ["SUBMITTING", "UNKNOWN", "PENDING", "OPEN", "QUEUED", "PARTIALLY_FILLED", "CANCEL_QUEUED"].includes(item.status));
        const status = coinbaseAdvancedStatus(this.env);
        const utcDayStart = new Date();
        utcDayStart.setUTCHours(0, 0, 0, 0);
        const ordersToday = records.filter((item) => Number(item.created_at_ms) >= utcDayStart.getTime()).length;
        if (active.length >= status.max_open_orders ||
            !status.max_daily_orders || ordersToday >= status.max_daily_orders) {
          return jsonResponse({
            status: "blocked",
            blockers: [
              ...(active.length >= (status.max_open_orders || 1) ? ["maximum_open_orders_reached"] : []),
              ...(!status.max_daily_orders || ordersToday >= status.max_daily_orders ? ["maximum_daily_order_count_reached"] : [])
            ],
            order_submission_available: false,
            live_trading_enabled: false,
            automatic_live_entries_enabled: false
          }, 423);
        }
        const previews = this.getState("coinbase_live_previews") || [];
        const consume = consumeServerLivePreview(previews, previewToken, Date.now());
        if (!consume.ok) {
          this.setState("coinbase_live_previews", consume.previews.slice(0, 25));
          const statusCode = consume.reason === "server_preview_expired_refresh_required" ? 410
            : consume.reason === "preview_not_authorized_for_manual_live_submission" ? 423 : 409;
          return jsonResponse({ status: "blocked", blockers: [consume.reason], order_submission_available: false }, statusCode);
        }
        const preview = consume.preview;
        // Consume synchronously before the first external await. A second
        // request cannot reuse this preview, including after an ambiguous
        // network outcome; ambiguous outcomes must be reconciled, never retried.
        this.setState("coinbase_live_previews", consume.previews.slice(0, 25));
        const nowMs = Date.now();
        const record = {
          client_order_id: clientOrderId,
          product_id: preview.product_id,
          side: preview.side,
          quote_size: preview.quote_size || null,
          base_size: preview.base_size || null,
          limit_price: preview.limit_price,
          commission_preview: preview.commission_total,
          status: "SUBMITTING",
          created_at_ms: nowMs,
          updated_at_ms: nowMs,
          exchange_order_id: null,
          preview_token: previewToken
        };
        records.unshift(record);
        this.setState("coinbase_live_orders", records.slice(0, 100));
        try {
          const result = await submitCoinbaseAdvancedLimitBuy(this.env, {
            productId: preview.product_id,
            side: preview.side,
            quoteSize: preview.quote_size,
            baseSize: preview.base_size,
            limitPrice: preview.limit_price,
            commissionTotal: preview.commission_total,
            previewId: preview.provider_preview_id,
            clientOrderId
          });
          Object.assign(record, result, { updated_at_ms: Date.now() });
          const current = this.getState("coinbase_live_orders") || [];
          this.setState("coinbase_live_orders", current.map((item) => item.client_order_id === clientOrderId ? record : item).slice(0, 100));
          this.logEvent("coinbase_live_order_submit", "Coinbase live LIMIT order submission result", {
            client_order_id: clientOrderId, status: record.status, product_id: record.product_id,
            exchange_order_id: record.exchange_order_id || null
          });
          return jsonResponse({ ...result, client_order_id: clientOrderId }, result.status === "blocked" ? 423 : 200);
        } catch (error) {
          record.status = error?.ambiguousSubmission === true ? "UNKNOWN" : "REJECTED";
          record.error_code = typeof error?.code === "string" ? error.code : "coinbase_live_order_submission_failed";
          record.updated_at_ms = Date.now();
          const current = this.getState("coinbase_live_orders") || [];
          this.setState("coinbase_live_orders", current.map((item) => item.client_order_id === clientOrderId ? record : item).slice(0, 100));
          this.logEvent("coinbase_live_order_submit_error", "Coinbase live order submission failed or became ambiguous", {
            client_order_id: clientOrderId, status: record.status, error_code: record.error_code
          });
          return jsonResponse({ status: record.status, decision: "RECONCILE_BEFORE_RETRY", client_order_id: clientOrderId, error_code: record.error_code }, 502);
        }
      }
      if (request.method === "GET" && url.pathname === "/api/live/orders") {
        const records = this.getState("coinbase_live_orders") || [];
        return jsonResponse({ orders: records.slice(0, 100), count: records.length });
      }
      if (request.method === "POST" && url.pathname === "/api/live/reconcile") {
        let body;
        try { body = await request.json(); } catch { return jsonResponse({ status: "blocked", blockers: ["invalid_json"] }, 400); }
        const records = this.getState("coinbase_live_orders") || [];
        const record = records.find((item) => item.client_order_id === body?.client_order_id);
        if (!record) return jsonResponse({ status: "blocked", blockers: ["local_order_not_found"] }, 404);
        try {
          return jsonResponse(await this.reconcileAndSyncLiveOrder(record));
        } catch (error) {
          return jsonResponse({ status: "UNKNOWN", found: false, blockers: [typeof error?.code === "string" ? error.code : "order_reconciliation_failed"] }, 502);
        }
      }
      if (request.method === "GET" && url.pathname === "/api/live/fills") {
        const clientOrderId = String(url.searchParams.get("client_order_id") || "").trim();
        const limit = Math.max(1, Math.min(200, Number.parseInt(url.searchParams.get("limit") || "100", 10) || 100));
        const rows = clientOrderId
          ? this.sql.exec(
              "SELECT entry_id,trade_id,order_id,client_order_id,product_id,side,trade_type,trade_time,sequence_timestamp,price,size,commission,liquidity_indicator,size_in_quote,imported_at_ms,raw_json " +
              "FROM live_fills WHERE client_order_id=? ORDER BY trade_time DESC,entry_id LIMIT ?",
              clientOrderId, limit
            ).toArray()
          : this.sql.exec(
              "SELECT entry_id,trade_id,order_id,client_order_id,product_id,side,trade_type,trade_time,sequence_timestamp,price,size,commission,liquidity_indicator,size_in_quote,imported_at_ms,raw_json " +
              "FROM live_fills ORDER BY trade_time DESC,entry_id LIMIT ?",
              limit
            ).toArray();
        const count = clientOrderId
          ? Number(this.sql.exec("SELECT COUNT(*) AS count FROM live_fills WHERE client_order_id=?", clientOrderId).toArray()[0]?.count || 0)
          : Number(this.sql.exec("SELECT COUNT(*) AS count FROM live_fills").toArray()[0]?.count || 0);
        return jsonResponse({
          fills: rows.map((row) => {
            let audit = {};
            try { audit = JSON.parse(row.raw_json || "{}"); } catch { audit = {}; }
            return {
              ...row,
              size_in_quote: Number(row.size_in_quote) === 1,
              commission_currency: audit.commission_currency ?? null,
              commission_currency_source: audit.commission_currency_source || "not_exposed_by_fill_schema",
              commission_detail_total: audit.commission_detail_total ?? null,
              fill_source: audit.fill_source ?? null,
              order_data_source: audit.order_data_source ?? null
            };
          }),
          count,
          limit,
          has_more: count > limit,
          mode: "exchange_reported_fill_ledger",
          pnl_status: "not_calculated_fee_currency_and_fifo_accounting_not_yet_verified"
        });
      }
      if (request.method === "POST" && url.pathname === "/api/live/cancel") {
        let body;
        try { body = await request.json(); } catch { return jsonResponse({ status: "blocked", blockers: ["invalid_json"] }, 400); }
        const records = this.getState("coinbase_live_orders") || [];
        const record = records.find((item) => item.client_order_id === body?.client_order_id);
        if (!record || !record.exchange_order_id) return jsonResponse({ status: "blocked", blockers: ["known_exchange_order_id_required"] }, 409);
        if (!["PENDING", "OPEN", "QUEUED", "PARTIALLY_FILLED", "CANCEL_QUEUED"].includes(String(record.status || "").toUpperCase())) {
          return jsonResponse({ status: "blocked", blockers: ["only_open_or_pending_exchange_orders_can_be_cancelled"] }, 409);
        }
        const result = await cancelCoinbaseAdvancedOrder(this.env, { exchangeOrderId: record.exchange_order_id });
        // A successful batch-cancel response means queued, not terminal.
        // Verify the actual exchange state and pull any fills that raced with cancel.
        if (result.status === "CANCEL_QUEUED" || result.status === "UNKNOWN") {
          record.status = "CANCEL_QUEUED";
          record.cancel_requested_at_ms = Date.now();
          record.updated_at_ms = Date.now();
          const latest = this.getState("coinbase_live_orders") || [];
          this.setState("coinbase_live_orders", latest.map((item) =>
            item.client_order_id === record.client_order_id ? record : item
          ).slice(0, 100));
          try {
            const reconciled = await this.reconcileAndSyncLiveOrder(record);
            return jsonResponse({ cancel_request: result, reconciliation: reconciled, status: reconciled.status });
          } catch (error) {
            record.status = "UNKNOWN";
            record.last_reconcile_error = typeof error?.code === "string" ? error.code : "order_reconciliation_failed";
            record.updated_at_ms = Date.now();
            const latest = this.getState("coinbase_live_orders") || [];
            this.setState("coinbase_live_orders", latest.map((item) =>
              item.client_order_id === record.client_order_id ? record : item
            ).slice(0, 100));
            return jsonResponse({ cancel_request: result, status: "UNKNOWN", blockers: [record.last_reconcile_error] }, 502);
          }
        }
        record.status = "UNKNOWN";
        record.updated_at_ms = Date.now();
        this.setState("coinbase_live_orders", records.slice(0, 100));
        return jsonResponse({ ...result, status: "UNKNOWN", warning: "Cancellation was not confirmed by the exchange. Reconcile before retrying." }, 502);
      }
      if (request.method === "GET" && url.pathname === "/api/trading/mode") {
        const settings = this.getState("settings") || {};
        const mode = normalizeTradingMode(settings.trading_mode);
        const live = coinbaseAdvancedStatus(this.env);
        return jsonResponse({
          mode,
          demo: {
            data_source: "coinbase_public_market_data",
            execution: "simulated_paper_ledger",
            automation_enabled: settings.auto_paper_enabled === true
          },
          real: {
            provider: "coinbase_advanced_trade",
            connection_status: live.credentials_configured ? "credentials_configured_preflight_required" : "not_configured",
            account_preflight_available: live.account_preflight_available,
            order_preview_available: live.order_preview_available,
            order_submission_available: live.order_submission_available,
            live_trading_enabled: false,
            automatic_live_entries_enabled: false,
            withdrawal_permission_required: false,
            blockers: live.blockers
          }
        });
      }
      if (request.method === "PUT" && url.pathname === "/api/trading/mode") {
        let body;
        try { body = await request.json(); } catch {
          return jsonResponse({ error: "invalid_json" }, 400);
        }
        const settings = this.getState("settings") || {};
        const liveOrders = this.getState("coinbase_live_orders") || [];
        const selected = selectTradingMode(settings, body?.mode, {
          openPaperPositions: this.getOpenTrades().length,
          liveOrders
        });
        if (!selected.ok) return jsonResponse({ error: selected.reason }, 409);
        this.setState("settings", selected.settings);
        if (selected.changed) {
          this.logEvent(
            "trading_mode_changed",
            selected.settings.trading_mode === "real"
              ? "Owner selected REAL account connection mode; paper auto-entry disabled"
              : "Owner selected DEMO mode; paper auto-entry remains OFF until explicitly enabled",
            { mode: selected.settings.trading_mode }
          );
        }
        const live = coinbaseAdvancedStatus(this.env);
        return jsonResponse({
          mode: selected.settings.trading_mode,
          changed: selected.changed,
          paper_auto_enabled: selected.settings.auto_paper_enabled === true,
          live_execution_enabled: false,
          real_connection_status: live.credentials_configured ? "credentials_configured_preflight_required" : "not_configured"
        });
      }
      if (request.method === "GET" && url.pathname === "/api/live/status") {
        return jsonResponse({
          ...coinbaseAdvancedStatus(this.env),
          background_reconciliation: this.coinbaseBackgroundReconciliationStatus()
        });
      }
      if (request.method === "POST" && url.pathname === "/api/live/preflight") {
        const result = await preflightCoinbaseAdvanced(this.env);
        return jsonResponse({
          ...result,
          background_reconciliation: this.coinbaseBackgroundReconciliationStatus()
        });
      }
      if (request.method === "POST" && url.pathname === "/api/live/order-preview") {
        let rawBody;
        try { rawBody = await request.text(); } catch {
          return jsonResponse({ status: "blocked", decision: "NO_ORDER", blockers: ["invalid_request_body"], order_submission_available: false }, 400);
        }
        if (new TextEncoder().encode(rawBody).byteLength > 4096) {
          return jsonResponse({ status: "blocked", decision: "NO_ORDER", blockers: ["request_too_large"], order_submission_available: false }, 413);
        }
        let body;
        try { body = JSON.parse(rawBody); } catch {
          return jsonResponse({ status: "blocked", decision: "NO_ORDER", blockers: ["invalid_json"], order_submission_available: false }, 400);
        }
        const settings = this.getState("settings") || {};
        if (normalizeTradingMode(settings.trading_mode) !== "real") {
          return jsonResponse({
            status: "blocked", decision: "NO_ORDER",
            blockers: ["real_mode_must_be_selected_before_order_preview"],
            order_submission_available: false,
            live_trading_enabled: false,
            automatic_live_entries_enabled: false
          }, 409);
        }
        try {
          const result = await previewCoinbaseAdvancedLimitBuy(this.env, {
            productId: body.product_id,
            side: body.side || "BUY",
            quoteSize: body.quote_size,
            baseSize: body.base_size,
            limitPrice: body.limit_price
          });
          if (result.status !== "preview_ready") return jsonResponse(result);
          const nowMs = Date.now();
          const previewToken = crypto.randomUUID();
          const previewRecord = createServerLivePreview(result, previewToken, nowMs);
          if (!previewRecord) {
            return jsonResponse({ status: "blocked", decision: "NO_ORDER", blockers: ["server_preview_record_invalid"], order_submission_available: false }, 502);
          }
          const previews = (this.getState("coinbase_live_previews") || [])
            .filter((item) => item && item.status === "READY" && Number(item.expires_at_ms) > nowMs)
            .slice(0, 24);
          previews.unshift(previewRecord);
          this.setState("coinbase_live_previews", previews.slice(0, 25));
          return jsonResponse({
            ...result,
            preview_token: previewToken,
            preview_expires_at_ms: previewRecord.expires_at_ms,
            warning: "Server-bound preview. It expires in 60 seconds and can authorize at most one manually confirmed order."
          });
        } catch (error) {
          const code = typeof error?.code === "string" ? error.code : "coinbase_advanced_preview_failed";
          this.logEvent("coinbase_advanced_preview_error", "Coinbase Advanced order preview failed", { code });
          return jsonResponse({
            status: "blocked", decision: "NO_ORDER", blockers: [code],
            order_submission_available: false, live_trading_enabled: false
          }, coinbaseAdvancedErrorStatus(error));
        }
      }
      if (request.method === "GET" && url.pathname === "/api/market/candles") {
        const symbol = String(url.searchParams.get("symbol") || "BTC/USD").toUpperCase();
        const selected = PRODUCTS.find((item) => item.symbol === symbol);
        const timeframeSeconds = Number(url.searchParams.get("timeframe") || 3600);
        const limit = Math.max(24, Math.min(200, Number.parseInt(url.searchParams.get("limit") || "72", 10) || 72));
        if (!selected) return jsonResponse({ error: "configured_market_symbol_required" }, 400);
        if (![60, 300, 3600, 21600].includes(timeframeSeconds)) {
          return jsonResponse({ error: "unsupported_candle_timeframe" }, 400);
        }
        const rows = this.sql.exec(
          "SELECT candle_open_ms,open,high,low,close,volume,received_at_ms FROM research_candles " +
          "WHERE exchange='coinbase_exchange' AND product=? AND timeframe_seconds=? " +
          "ORDER BY candle_open_ms DESC LIMIT ?",
          selected.product, timeframeSeconds, limit
        ).toArray().reverse().map((row) => ({
          time: Number(row.candle_open_ms),
          open: Number(row.open),
          high: Number(row.high),
          low: Number(row.low),
          close: Number(row.close),
          volume: Number(row.volume),
          received_at_ms: Number(row.received_at_ms)
        }));
        const latest = rows.at(-1) || null;
        const nowMs = Date.now();
        return jsonResponse({
          status: rows.length >= 24 ? "ready" : "insufficient_history",
          mode: "read_only",
          source: "coinbase_exchange_closed_candle_archive",
          symbol,
          product: selected.product,
          timeframe_seconds: timeframeSeconds,
          bars: rows,
          count: rows.length,
          latest_closed_at_ms: latest ? latest.time + timeframeSeconds * 1000 : null,
          latest_age_ms: latest ? Math.max(0, nowMs - (latest.time + timeframeSeconds * 1000)) : null,
          retrieved_at_ms: nowMs
        });
      }
      if (request.method === "GET" && url.pathname === "/api/dashboard") return jsonResponse(this.dashboard());
      if (request.method === "GET" && url.pathname === "/api/markets") return jsonResponse({ markets: this.getMarkets() });
      if (request.method === "GET" && url.pathname === "/api/trades") {
        const limit = Math.max(1, Math.min(100, Number.parseInt(url.searchParams.get("limit") || "50", 10) || 50));
        const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") || "0", 10) || 0);
        const total = Number(this.sql.exec("SELECT COUNT(*) AS count FROM trades").toArray()[0]?.count || 0);
        return jsonResponse({
          trades: this.getTrades(limit, offset), total, limit, offset,
          has_more: offset + limit < total, open_positions: this.getOpenTrades()
        });
      }
      if (request.method === "GET" && url.pathname === "/api/analytics") {
        return jsonResponse(this.tradeAnalytics());
      }
      if (request.method === "GET" && url.pathname === "/api/research/history") {
        return jsonResponse({ mode: "read_only", history: this.researchHistorySummary() });
      }
      if (request.method === "GET" && url.pathname === "/api/research/tournament") {
        return jsonResponse(this.researchTournament());
      }
      if (request.method === "GET" && url.pathname === "/api/events") {
        return jsonResponse({ events: this.sql.exec("SELECT * FROM events ORDER BY id DESC LIMIT 100").toArray() });
      }
      if (request.method === "GET" && url.pathname === "/api/automation/paper-trading") {
        const state = this.getState("settings");
        return jsonResponse({ enabled: !!state.auto_paper_enabled, halted: !!state.halted, mode: "paper_only", trading_mode: normalizeTradingMode(state.trading_mode) });
      }
      if (request.method === "PUT" && url.pathname === "/api/automation/paper-trading") {
        const body = await request.json();
        if (typeof body.enabled !== "boolean") return jsonResponse({ error: "enabled_boolean_required" }, 400);
        const state = this.getState("settings");
        if (body.enabled && normalizeTradingMode(state.trading_mode) !== "demo") return jsonResponse({ error: "select_demo_mode_before_enabling_paper_automation" }, 409);
        if (body.enabled && state.capital_setup_required) return jsonResponse({ error: "paper_capital_setup_review_required" }, 409);
        if (body.enabled && state.halted) return jsonResponse({ error: "paper_automation_halted_reset_required" }, 409);
        if (body.enabled) {
          const nowMs = Date.now();
          const runtime = this.getState("runtime") || {};
          const scheduledScanAtMs = Number(runtime.last_scheduled_scan_at_ms);
          const scheduledScanAgeMs = Number.isFinite(scheduledScanAtMs)
            ? nowMs - scheduledScanAtMs : Number.POSITIVE_INFINITY;
          const healthyMarketCount = Number(runtime.last_scheduled_scan_healthy_market_count) || 0;
          const expectedMarketCount = Number(runtime.last_scheduled_scan_expected_market_count) || PRODUCTS.length;
          const recentHealthyScheduledScan = hasRecentHealthyScheduledScan({
            status: runtime.last_scheduled_scan_status,
            scanAtMs: scheduledScanAtMs,
            healthyMarketCount,
            expectedMarketCount,
            nowMs,
            maxAgeMs: SCAN_INTERVAL_MS * 3
          });
          // Do not require the persisted L2 snapshot to remain younger than 15s
          // while an owner clicks Enable. Each actual scheduled entry cycle
          // fetches a new book and re-runs the strict market-universe gate.
          if (!recentHealthyScheduledScan) {
            return jsonResponse({
              error: "fresh_complete_scheduled_scan_required",
              scheduled_scan_status: runtime.last_scheduled_scan_status || "not_run",
              scheduled_scan_age_ms: Number.isFinite(scheduledScanAgeMs) ? Math.max(0, scheduledScanAgeMs) : null,
              healthy_market_count: healthyMarketCount,
              expected_market_count: expectedMarketCount,
              issues: Array.isArray(runtime.last_scheduled_scan_issues) ? runtime.last_scheduled_scan_issues : []
            }, 409);
          }
        }
        state.auto_paper_enabled = body.enabled;
        state.auto_paper_resume_after_watchdog = body.enabled;
        this.setState("settings", state);
        this.logEvent("paper_automation_setting", body.enabled ? "Automatic paper entries enabled by owner" : "Automatic paper entries disabled by owner");
        return jsonResponse({ enabled: state.auto_paper_enabled, halted: state.halted, mode: "paper_only" });
      }
      if (request.method === "POST" && url.pathname === "/api/automation/capital-review") {
        let body;
        try { body = await request.json(); } catch { return jsonResponse({ error: "invalid_json" }, 400); }
        const settings = this.getState("settings") || {};
        const tradeCount = Number(this.sql.exec("SELECT COUNT(*) AS count FROM trades").toArray()[0]?.count);
        const openPositions = this.getOpenTrades().length;
        const review = reviewLegacyPaperCapital(settings, {
          action: body?.action,
          confirmed: body?.confirmed,
          tradeCount,
          openPositions
        });
        if (!review.ok) {
          const status = review.reason === "capital_review_action_invalid" ? 400 : 409;
          return jsonResponse({ error: review.reason }, status);
        }
        this.setState("settings", review.settings);
        this.logEvent(
          "paper_capital_review",
          "Existing virtual starting capital accepted; historical trades preserved and auto-entry remains OFF",
          {
            initial_capital_usd: review.settings.initial_capital_usd,
            historical_trade_count: tradeCount,
            paper_automation_profile_version: PAPER_AUTOMATION_PROFILE.version
          }
        );
        return jsonResponse({
          status: "reviewed",
          initial_capital_usd: review.settings.initial_capital_usd,
          historical_trades_preserved: true,
          auto_paper_enabled: false,
          halted: !!review.settings.halted
        });
      }
      if (request.method === "POST" && url.pathname === "/api/automation/kill-switch") {
        const state = this.getState("settings");
        state.auto_paper_enabled = false;
        state.auto_paper_resume_after_watchdog = false;
        state.halted = true;
        state.halt_reason = "owner_emergency_stop";
        this.setState("settings", state);
        this.logEvent("emergency_stop", "Paper auto-entry halted; scheduled monitoring continues");
        return jsonResponse({ stopped: true, auto_paper_enabled: false, halted: true, exit_monitoring_continues: true });
      }
      if (request.method === "POST" && url.pathname === "/api/automation/reset") {
        if (this.getOpenTrades().length > 0) return jsonResponse({ error: "open_paper_positions_must_be_closed_before_reset" }, 409);
        const state = this.getState("settings");
        state.halted = false;
        state.halt_reason = null;
        state.auto_paper_enabled = false;
        state.auto_paper_resume_after_watchdog = false;
        this.setState("settings", state);
        this.logEvent("emergency_stop_reset", "Paper entry halt reset; auto-entry remains OFF");
        return jsonResponse({ halted: false, auto_paper_enabled: false });
      }
      if (request.method === "POST" && url.pathname.startsWith("/api/paper/close/")) {
        const tradeId = Number(url.pathname.split("/").pop());
        if (!Number.isSafeInteger(tradeId) || tradeId < 1) return jsonResponse({ error: "invalid_trade_id" }, 400);
        const trade = this.getOpenTrades().find((item) => item.id === tradeId);
        if (!trade) return jsonResponse({ error: "open_paper_trade_not_found" }, 404);
        const market = this.getMarkets().find((item) => item.symbol === trade.symbol && item.status === "live");
        if (!isFreshBidQuote(market, Date.now(), MAX_QUOTE_AGE_MS)) {
          return jsonResponse({ error: "fresh_bid_required_run_market_scan_first" }, 409);
        }
        const entryProvider = typeof trade.metadata?.market_data_provider === "string"
          ? trade.metadata.market_data_provider : "coinbase_exchange";
        if (market.market_data_provider !== entryProvider) {
          return jsonResponse({
            error: "same_entry_provider_quote_required",
            entry_provider: entryProvider,
            current_provider: market.market_data_provider || null
          }, 409);
        }
        const risk = { ...DEFAULT_RISK, ...(this.getState("settings")?.risk || {}) };
        const closed = this.closeTradeAt(
          trade, market.bid, risk, Date.now(), "manual_owner_close", market.market_data_provider
        );
        return jsonResponse({ trade: closed, mode: "paper_only" });
      }
      if (request.method === "POST" && url.pathname === "/api/scan") return jsonResponse(await this.runCycle("manual"));
      if (request.method === "GET" && url.pathname === "/api/automation/status") return jsonResponse(this.automationStatus());
      return jsonResponse({ error: "not_found" }, 404);
    } catch (error) {
      this.logEvent("request_error", "Backend request failed", { path: url.pathname, error: String(error?.message || error).slice(0, 160) });
      return jsonResponse({ error: "request_failed", detail: String(error?.message || error).slice(0, 200) }, 500);
    }
  }

  async reconcileAndSyncLiveOrder(record) {
    const result = await reconcileCoinbaseAdvancedOrder(this.env, {
      productId: record.product_id,
      clientOrderId: record.client_order_id,
      exchangeOrderId: record.exchange_order_id || undefined,
      createdAtMs: record.created_at_ms
    });
    const reconciledOrder = result.found ? result.order : null;
    Object.assign(record, reconciledOrder || {}, {
      exchange_order_id: record.exchange_order_id || reconciledOrder?.order_id || null,
      status: result.status,
      last_reconciled_at_ms: Date.now(),
      updated_at_ms: Date.now(),
      last_reconcile_error: null
    });
    let fillSync = { status: "not_available", count: 0, pagination_complete: true };
    if (record.exchange_order_id) {
      try {
        const fillResult = await listCoinbaseAdvancedFills(this.env, {
          orderId: record.exchange_order_id, limit: 100, maxPages: 5
        });
        let processed = 0;
        for (const fill of fillResult.fills) {
          this.sql.exec(
            "INSERT INTO live_fills(entry_id,trade_id,order_id,client_order_id,product_id,side,trade_type,trade_time,sequence_timestamp,price,size,commission,liquidity_indicator,size_in_quote,imported_at_ms,raw_json) " +
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(entry_id) DO UPDATE SET " +
            "trade_id=excluded.trade_id,order_id=excluded.order_id,client_order_id=excluded.client_order_id," +
            "product_id=excluded.product_id,side=excluded.side,trade_type=excluded.trade_type,trade_time=excluded.trade_time," +
            "sequence_timestamp=excluded.sequence_timestamp,price=excluded.price,size=excluded.size,commission=excluded.commission," +
            "liquidity_indicator=excluded.liquidity_indicator,size_in_quote=excluded.size_in_quote," +
            "imported_at_ms=excluded.imported_at_ms,raw_json=excluded.raw_json",
            fill.entry_id, fill.trade_id, fill.order_id, record.client_order_id, fill.product_id,
            fill.side, fill.trade_type, fill.trade_time, fill.sequence_timestamp,
            fill.price, fill.size, fill.commission, fill.liquidity_indicator,
            fill.size_in_quote ? 1 : 0, Date.now(), JSON.stringify(fill)
          );
          processed += 1;
        }
        fillSync = {
          status: fillResult.proof_token_required ? "proof_required"
            : fillResult.pagination_complete ? "complete" : "partial",
          count: fillResult.count,
          processed,
          pages: fillResult.pages,
          pagination_complete: fillResult.pagination_complete,
          proof_token_required: fillResult.proof_token_required === true,
          synced_at_ms: Date.now()
        };
      } catch (error) {
        fillSync = {
          status: "error",
          count: 0,
          pagination_complete: false,
          error_code: typeof error?.code === "string" ? error.code : "coinbase_fill_sync_failed",
          synced_at_ms: Date.now()
        };
      }
    }
    record.fill_sync = fillSync;
    const latest = this.getState("coinbase_live_orders") || [];
    this.setState("coinbase_live_orders", latest.map((item) =>
      item.client_order_id === record.client_order_id ? record : item
    ).slice(0, 100));
    return { ...result, client_order_id: record.client_order_id, fill_sync: fillSync };
  }

  coinbaseBackgroundReconciliationStatus() {
    const configured = coinbaseAdvancedStatus(this.env).credentials_configured === true;
    const runtime = this.getState("runtime") || {};
    const lastRunAt = Number(runtime.last_live_reconcile_at_ms);
    const checked = Math.max(0, Number(runtime.last_live_reconcile_checked) || 0);
    const failed = Math.max(0, Number(runtime.last_live_reconcile_failed) || 0);
    const candidateCount = Math.max(0, Number(runtime.last_live_reconcile_candidate_count) || 0);
    const ageMs = Number.isFinite(lastRunAt) && lastRunAt > 0
      ? Math.max(0, Date.now() - lastRunAt) : null;
    const status = !configured ? "not_configured"
      : ageMs === null ? "waiting_for_first_scheduler_cycle"
        : failed > 0 ? "partial"
          : candidateCount === 0 ? "no_active_orders"
            : ageMs > SCAN_INTERVAL_MS * 5 ? "stale" : "healthy";
    return {
      enabled: configured,
      mode: "scheduled_read_only_order_and_fill_reconciliation",
      status,
      last_run_at_ms: Number.isFinite(lastRunAt) && lastRunAt > 0 ? lastRunAt : null,
      age_ms: ageMs,
      candidates: candidateCount,
      checked,
      failed,
      interval_ms: SCAN_INTERVAL_MS,
      live_order_submission_by_scheduler: false
    };
  }

  async reconcileOpenCoinbaseLiveOrders(source = "scheduled") {
    if (!coinbaseAdvancedStatus(this.env).credentials_configured) {
      return { status: "skipped", reason: "coinbase_credentials_not_configured", checked: 0 };
    }
    const records = this.getState("coinbase_live_orders") || [];
    const nowMs = Date.now();
    const activeStatuses = new Set([
      "SUBMITTING", "UNKNOWN", "PENDING", "OPEN", "QUEUED",
      "PARTIALLY_FILLED", "CANCEL_QUEUED"
    ]);
    const terminalStatuses = new Set([
      "FILLED", "CANCELLED", "CANCELED", "EXPIRED", "FAILED"
    ]);
    const lastAttemptAt = (item) => {
      const value = Number(item?.last_reconciled_at_ms || item?.updated_at_ms || item?.created_at_ms || 0);
      return Number.isFinite(value) ? value : 0;
    };
    const active = records.filter((item) => {
      const status = String(item?.status || "").toUpperCase();
      if (activeStatuses.has(status)) return true;
      if (!terminalStatuses.has(status) || !item?.exchange_order_id) return false;
      const fillStatus = String(item?.fill_sync?.status || "").toLowerCase();
      if (fillStatus === "complete" || fillStatus === "proof_required") return false;
      const lastAttempt = lastAttemptAt(item);
      return !lastAttempt || nowMs - lastAttempt >= 5 * 60 * 1000;
    }).sort((left, right) => lastAttemptAt(left) - lastAttemptAt(right)).slice(0, 3);
    let checked = 0;
    let failed = 0;
    for (const record of active) {
      try {
        await this.reconcileAndSyncLiveOrder(record);
        checked += 1;
      } catch (error) {
        failed += 1;
        record.status = "UNKNOWN";
        record.last_reconcile_error = typeof error?.code === "string"
          ? error.code : "live_order_reconciliation_failed";
        record.updated_at_ms = Date.now();
        const latest = this.getState("coinbase_live_orders") || [];
        this.setState("coinbase_live_orders", latest.map((item) =>
          item.client_order_id === record.client_order_id ? record : item
        ).slice(0, 100));
        this.logEvent("coinbase_live_auto_reconcile_error", "Automatic read-only live order reconciliation failed", {
          client_order_id: record.client_order_id,
          error_code: record.last_reconcile_error,
          source
        });
      }
    }
    const runtime = this.getState("runtime") || {};
    runtime.last_live_reconcile_at_ms = Date.now();
    runtime.last_live_reconcile_checked = checked;
    runtime.last_live_reconcile_failed = failed;
    runtime.last_live_reconcile_candidate_count = active.length;
    this.setState("runtime", runtime);
    return { status: failed ? "partial" : "completed", checked, failed };
  }

  async alarm() {
    const invokedAtMs = Date.now();
    const startingRuntime = this.getState("runtime") || {};
    const fullScanDue = shouldRunScheduledMarketScan(
      startingRuntime.last_scheduled_scan_at_ms,
      invokedAtMs,
      SCAN_INTERVAL_MS
    );

    // Frequent alarms maintain L2 freshness independently from the heavier
    // strategy/candle scan. They do not alter scheduled-scan health counters.
    if (!fullScanDue) {
      let refreshResult = null;
      let refreshErrorCode = null;
      try {
        refreshResult = await runAfterActiveScan(
          () => this.scanPromise,
          () => this.refreshOrderBooksOnly()
        );
      } catch (error) {
        refreshErrorCode = typeof error?.code === "string" && /^[a-z0-9_]{1,80}$/.test(error.code)
          ? error.code
          : "book_refresh_cycle_failed";
      } finally {
        // One scheduler-state write per short alarm; snapshot rows and setAlarm
        // are the other bounded writes on this path.
        const current = this.getState("runtime") || {};
        current.last_scheduled_alarm_at_ms = invokedAtMs;
        if (refreshResult?.telemetry) {
          Object.assign(current, refreshResult.telemetry);
        } else if (refreshErrorCode) {
          current.last_book_refresh_at_ms = Date.now();
          current.last_book_refresh_status = "error";
          current.last_book_refresh_failed_count = PRODUCTS.length;
          current.last_book_refresh_issues = [{ symbol: null, reason: refreshErrorCode }];
        }
        const nextAt = Date.now() + BOOK_REFRESH_INTERVAL_MS;
        current.next_alarm_at_ms = nextAt;
        this.setState("runtime", current);
        await this.ctx.storage.setAlarm(nextAt);
      }
      if (refreshErrorCode) {
        this.logEvent("order_book_refresh_error", "Scheduled L2-only market refresh failed", {
          reason: refreshErrorCode
        });
      }
      return;
    }

    const previousScheduledScanStatus = startingRuntime.last_scheduled_scan_status || "not_run";
    const previousScheduledScanError = startingRuntime.last_scheduled_scan_error || null;
    startingRuntime.last_scheduled_alarm_at_ms = invokedAtMs;
    startingRuntime.last_scheduled_scan_status = "running";
    startingRuntime.last_scheduled_scan_error = null;
    this.setState("runtime", startingRuntime);
    const priorRuntime = this.getState("runtime") || {};
    const cycleKey = String(priorRuntime.next_alarm_at_ms ||
      Math.floor(invokedAtMs / SCAN_INTERVAL_MS) * SCAN_INTERVAL_MS);
    try {
      const result = await runAfterActiveScan(
        () => this.scanPromise || this.researchBackfillPromise,
        () => this.runCycle("scheduled", cycleKey)
      );
      const runtime = this.getState("runtime") || {};
      runtime.last_scheduled_alarm_at_ms = invokedAtMs;
      if (!result?.skipped) {
        const feed = result?.market_feed;
        runtime.last_scheduled_scan_status = feed?.healthy === true ? "completed"
          : feed ? (Number(feed.healthy_market_count || 0) > 0 ? "partial" : "unavailable")
            : "error";
        runtime.last_scheduled_scan_at_ms = Number(runtime.last_scan_at_ms) > 0
          ? Number(runtime.last_scan_at_ms) : Date.now();
        runtime.last_scheduled_scan_healthy_market_count =
          Number(feed?.healthy_market_count) || 0;
        runtime.last_scheduled_scan_expected_market_count =
          Number(feed?.expected_market_count) || PRODUCTS.length;
        runtime.last_scheduled_scan_issues = (Array.isArray(feed?.issues) ? feed.issues : [])
          .slice(0, 9)
          .map((issue) => ({
            symbol: typeof issue?.symbol === "string" ? issue.symbol.slice(0, 24) : null,
            reason: typeof issue?.reason === "string" ? issue.reason.slice(0, 160) : "unknown"
          }));
        runtime.last_scheduled_scan_error = feed?.healthy === true ? null
          : (feed?.issues || []).map((issue) => (issue.symbol || "universe") + ": " + issue.reason)
            .join("; ").slice(0, 180) || null;
      } else if (runtime.last_scheduled_scan_status === "running") {
        runtime.last_scheduled_scan_status = previousScheduledScanStatus;
        runtime.last_scheduled_scan_error = previousScheduledScanError;
      }
      this.setState("runtime", runtime);
    } catch (error) {
      const nowMs = Date.now();
      const runtime = this.getState("runtime") || {};
      const settings = this.getState("settings") || {};
      const previousHealthyScanAtMs = runtime.last_healthy_scheduled_scan_at_ms ??
        (runtime.source === "scheduled" && runtime.last_scan_status === "completed" ? runtime.last_scan_at_ms : null);
      runtime.last_scheduled_alarm_at_ms = invokedAtMs;
      runtime.last_scheduled_scan_status = "error";
      runtime.last_scheduled_scan_at_ms = nowMs;
      runtime.last_scheduled_scan_healthy_market_count = 0;
      runtime.last_scheduled_scan_expected_market_count = PRODUCTS.length;
      runtime.last_scheduled_scan_issues = [{ symbol: null, reason: "scheduled_scan_failed" }];
      runtime.last_scheduled_scan_error = String(error?.message || error).slice(0, 180);
      runtime.consecutive_unhealthy_scheduled_scans =
        Math.max(0, Number(runtime.consecutive_unhealthy_scheduled_scans) || 0) + 1;
      runtime.healthy_scheduled_scan_streak = 0;
      runtime.last_scan_status = "error";
      runtime.last_scan_error = runtime.last_scheduled_scan_error;
      runtime.last_scan_at_ms = nowMs;
      const watchdogDecision = shouldHaltPaperAutomation({
        autoEnabled: !!settings.auto_paper_enabled,
        halted: !!settings.halted,
        consecutiveUnhealthyScans: runtime.consecutive_unhealthy_scheduled_scans,
        lastHealthyScanAtMs: previousHealthyScanAtMs,
        nowMs,
        staleAfterMs: SCAN_INTERVAL_MS * 3,
        failureThreshold: 3
      });
      if (watchdogDecision.halt) {
        settings.auto_paper_resume_after_watchdog = settings.auto_paper_enabled === true;
        settings.auto_paper_enabled = false;
        settings.halted = true;
        settings.halt_reason = "market_data_watchdog";
        this.setState("settings", settings);
        this.logEvent("market_data_watchdog_halt", "Paper auto-entry halted after scheduled scan failures", {
          reason: watchdogDecision.reason,
          consecutive_unhealthy_scheduled_scans: runtime.consecutive_unhealthy_scheduled_scans,
          last_healthy_scheduled_scan_at_ms: previousHealthyScanAtMs
        });
      }
      this.setState("runtime", runtime);
      this.logEvent("scheduled_scan_error", "Scheduled market scan failed", {
        error: runtime.last_scan_error,
        consecutive_unhealthy_scheduled_scans: runtime.consecutive_unhealthy_scheduled_scans
      });
    } finally {
      // Reconciliation is read-only; it never creates, edits or cancels orders.
      try {
        await this.reconcileOpenCoinbaseLiveOrders("scheduled_alarm");
      } catch (error) {
        this.logEvent("coinbase_live_auto_reconcile_error", "Scheduled read-only Coinbase order reconciliation failed", {
          error_code: typeof error?.code === "string" ? error.code : "live_order_reconciliation_failed"
        });
      }
      const nextAt = Date.now() + BOOK_REFRESH_INTERVAL_MS;
      const runtime = this.getState("runtime") || {};
      runtime.next_alarm_at_ms = nextAt;
      this.setState("runtime", runtime);
      await this.ctx.storage.setAlarm(nextAt);
    }
  }

  async runCycle(source, cycleKey = null) {
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = this.performCycle(source, cycleKey).finally(() => { this.scanPromise = null; });
    return this.scanPromise;
  }

  async performCycle(source, cycleKey = null) {
    if (source === "scheduled" && cycleKey !== null) {
      const inserted = this.sql.exec(
        "INSERT OR IGNORE INTO scan_cycles(cycle_key,started_at_ms) VALUES(?,?) RETURNING cycle_key",
        cycleKey, Date.now()
      ).toArray();
      if (inserted.length !== 1) {
        this.logEvent("scheduled_scan_duplicate", "Duplicate scheduled alarm cycle skipped", { cycle_key: cycleKey });
        return { source, skipped: true, reason: "duplicate_alarm_cycle" };
      }
      this.sql.exec("DELETE FROM scan_cycles WHERE cycle_key NOT IN (SELECT cycle_key FROM scan_cycles ORDER BY started_at_ms DESC LIMIT 200)");
    }
    const nowMs = Date.now();
    const markets = [];
    const candleArchives = [];
    const legacyBitstampExitSymbols = new Set(
      this.getOpenTrades()
        .filter((trade) => trade.metadata?.market_data_provider === "bitstamp_spot")
        .map((trade) => trade.symbol)
    );
    for (const product of PRODUCTS) {
      try {
        const cachedCandles = {};
        try {
          cachedCandles.one_hour = this.loadResearchCandleCache(product.product, 3600);
        } catch (error) {
          this.logEvent("research_cache_read_error", "1H research cache read failed; fetching fresh candles", {
            product: product.product, timeframe_seconds: 3600,
            error: String(error?.message || error).slice(0, 160)
          });
        }
        try {
          cachedCandles.six_hour = this.loadResearchCandleCache(product.product, 21600);
        } catch (error) {
          this.logEvent("research_cache_read_error", "6H research cache read failed; fetching fresh candles", {
            product: product.product, timeframe_seconds: 21600,
            error: String(error?.message || error).slice(0, 160)
          });
        }
        for (const [timeframeSeconds, key, label] of [
          [60, "one_minute", "1M"], [300, "five_minute", "5M"]
        ]) {
          try {
            cachedCandles[key] = this.loadResearchCandleCache(product.product, timeframeSeconds);
          } catch (error) {
            this.logEvent("research_cache_read_error", label + " research cache read failed; fetching fresh candles", {
              product: product.product, timeframe_seconds: timeframeSeconds,
              error: String(error?.message || error).slice(0, 160)
            });
          }
        }
        if (legacyBitstampExitSymbols.has(product.symbol)) {
          cachedCandles.bitstamp = {};
          for (const [timeframeSeconds, key, label] of [
            [60, "one_minute", "1M"], [300, "five_minute", "5M"],
            [3600, "one_hour", "1H"], [21600, "six_hour", "6H"]
          ]) {
            try {
              cachedCandles.bitstamp[key] = this.loadResearchCandleCache(
                product.product, timeframeSeconds, "bitstamp_spot"
              );
            } catch (error) {
              this.logEvent("research_cache_read_error", "Legacy Bitstamp exit cache read failed", {
                product: product.product, timeframe_seconds: timeframeSeconds,
                error: String(error?.message || error).slice(0, 160)
              });
            }
          }
        }
        const snapshot = await fetchProductSnapshot(
          product, Date.now(), cachedCandles, undefined,
          { allowBitstampLegacyExit: legacyBitstampExitSymbols.has(product.symbol) }
        );
        candleArchives.push({
          product: product.product,
          exchange: snapshot.market_data_provider || "coinbase_exchange",
          one_minute: snapshot.one_minute_audit,
          five_minute: snapshot.five_minute_audit,
          one_hour: snapshot.one_hour_audit,
          six_hour: snapshot.six_hour_audit,
          received_at_ms: Date.now()
        });
        const primary = analyzeTimeframe(snapshot.one_hour_audit, 3600000);
        const higher = analyzeTimeframe(snapshot.six_hour_audit, 21600000);
        const strategyResearch = evaluateResearchCandidates(
          snapshot.one_hour_audit, snapshot.six_hour_audit, 6 * 60 * 60 * 1000
        );
        const microScalpResearch = evaluateMicroScalpResearch({
          oneMinuteAudit: snapshot.one_minute_audit,
          fiveMinuteAudit: snapshot.five_minute_audit,
          market: {
            status: snapshot.status,
            market_data_provider: snapshot.market_data_provider,
            quote_received_at_ms: snapshot.quote_received_at_ms,
            ticker_time: snapshot.ticker_time,
            book_retrieved_at_ms: snapshot.book_retrieved_at_ms,
            bid: snapshot.bid, ask: snapshot.ask, last: snapshot.last,
            spread_bps: snapshot.spread_bps,
            quote_volume_usd: snapshot.quote_volume_usd,
            bid_depth_quote: snapshot.bid_depth_quote,
            ask_depth_quote: snapshot.ask_depth_quote,
            data_quality: snapshot.data_quality
          },
          primary, higher, nowMs: Date.now()
        });
        // Store compact evidence only; never include hundreds of raw candles in each dashboard payload.
        const market = {
          symbol: snapshot.symbol,
          product: snapshot.product,
          status: "live",
          market_data_provider: snapshot.market_data_provider || "unknown",
          fetched_at_ms: snapshot.fetched_at_ms,
          quote_received_at_ms: snapshot.quote_received_at_ms,
          ticker_time: snapshot.ticker_time,
          bid: snapshot.bid,
          ask: snapshot.ask,
          last: snapshot.last,
          spread_bps: snapshot.spread_bps,
          quote_volume_usd: snapshot.quote_volume_usd,
          bid_depth_quote: snapshot.bid_depth_quote,
          ask_depth_quote: snapshot.ask_depth_quote,
          book_retrieved_at_ms: snapshot.book_retrieved_at_ms,
          book_event_time_ms: snapshot.book_event_time_ms ?? null,
          book_age_ms: snapshot.book_age_ms,
          book_sequence: snapshot.book_sequence,
          data_quality: snapshot.data_quality,
          one_hour_audit_summary: {
            ok: snapshot.one_hour_audit.ok,
            issues: snapshot.one_hour_audit.issues,
            valid_closed_bars: snapshot.one_hour_audit.valid_closed_bars,
            missing_intervals: snapshot.one_hour_audit.missing_intervals,
            last_closed_candle_ms: snapshot.one_hour_audit.rows?.at(-1)?.time ?? null
          },
          six_hour_audit_summary: {
            ok: snapshot.six_hour_audit.ok,
            issues: snapshot.six_hour_audit.issues,
            valid_closed_bars: snapshot.six_hour_audit.valid_closed_bars,
            missing_intervals: snapshot.six_hour_audit.missing_intervals,
            last_closed_candle_ms: snapshot.six_hour_audit.rows?.at(-1)?.time ?? null
          },
          primary,
          higher,
          strategy_research: strategyResearch,
          micro_scalp_research: microScalpResearch,
          signal: primary.signal,
          score: primary.score,
          regime_1h: primary.regime,
          regime_6h: higher.regime
        };
        markets.push(market);
      } catch (error) {
        candleArchives.push({ product: product.product, provider_error: true, error: String(error?.message || error).slice(0, 120), received_at_ms: Date.now() });
        const status = Number(error?.status);
        const errorCode = error?.code === "legacy_exit_market_data_unavailable"
          ? "legacy_exit_market_data_unavailable"
          : error?.code === "all_market_data_providers_unavailable"
            ? "all_market_data_providers_unavailable"
            : status === 429 ? "provider_rate_limited"
            : Number.isFinite(status) && status >= 500 ? "provider_server_error"
              : Number.isFinite(status) && status >= 400 ? "provider_http_error"
                : error?.name === "TimeoutError" || error?.name === "AbortError"
                  ? "provider_timeout" : "provider_network_error";
        const failed = {
          symbol: product.symbol, product: product.product, status: "error",
          error_code: errorCode,
          primary_error_code: error?.primary_error_code || null,
          backup_error_code: error?.backup_error_code || null,
          error: String(error?.message || error).slice(0, 180),
          fetched_at_ms: Date.now()
        };
        markets.push(failed);
      }
    }

    // Research ingestion is independent of owner automation settings and can only
    // persist validated, fully closed public candles; it never creates paper trades.
    for (const archive of candleArchives) {
      const checkedAt = archive.received_at_ms || Date.now();
      if (archive.provider_error) {
        for (const timeframeSeconds of [60, 300, 3600, 21600]) {
          try {
            this.markResearchHistoryUnavailable(archive.product, timeframeSeconds, checkedAt);
          } catch (error) {
            this.logEvent("research_archive_error", "Research archive status update failed", {
              product: archive.product, timeframe_seconds: timeframeSeconds,
              error: String(error?.message || error).slice(0, 160)
            });
          }
        }
        continue;
      }
      for (const [timeframeSeconds, audit] of [
        [60, archive.one_minute],
        [300, archive.five_minute],
        [3600, archive.one_hour],
        [21600, archive.six_hour]
      ]) {
        try {
          const result = archive.exchange === "bitstamp_spot"
            ? this.archiveProviderCandles(archive.exchange, archive.product, timeframeSeconds, audit, checkedAt)
            : this.archiveClosedCandles(archive.product, timeframeSeconds, audit, checkedAt);
          if (result?.status && result.status !== "clean") {
            this.logEvent("research_archive_quality", "Research candles were not archived", {
              product: archive.product, timeframe_seconds: timeframeSeconds,
              status: result.status, stored: result.stored || 0
            });
          }
        } catch (error) {
          // Archive maintenance is isolated from price/exit monitoring. A storage
          // issue must be visible, but must not abort the complete scheduled scan.
          this.logEvent("research_archive_error", "Research candle archive write failed", {
            product: archive.product, timeframe_seconds: timeframeSeconds,
            error: String(error?.message || error).slice(0, 160)
          });
        }
      }
    }

    // Candle/history requests can age L2 snapshots while later markets are
    // scanned. Refresh the exact entry venue after all candle work and immediately
    // before exits/entry gates. Bitstamp is permitted here only for an open
    // legacy position recorded with that provider; new candidates remain Coinbase-only.
    const finalBookRequestState = createCoinbaseRequestState();
    for (const market of markets) {
      if (market.status !== "live") continue;
      const provider = market.market_data_provider;
      const legacyBitstampExit = provider === "bitstamp_spot" &&
        legacyBitstampExitSymbols.has(market.symbol);
      if (provider !== "coinbase_exchange" && !legacyBitstampExit) continue;
      try {
        const freshBook = provider === "coinbase_exchange"
          ? await fetchCoinbaseOrderBook(market.product, finalBookRequestState)
          : await fetchBitstampOrderBook(market.product, finalBookRequestState);
        Object.assign(market, freshBook);
        market.spread_bps = ((freshBook.ask - freshBook.bid) / ((freshBook.ask + freshBook.bid) / 2)) * 10000;
        market.data_quality = { ...(market.data_quality || {}), book_provider: provider,
          book_status: "available", book_error: null,
          book_freshness_source: provider === "coinbase_exchange"
            ? "final_post_candle_local_retrieval_time"
            : "final_post_candle_legacy_bitstamp_exchange_timestamp",
          book_sequence_available: freshBook.book_sequence !== null };
      } catch (error) {
        market.data_quality = { ...(market.data_quality || {}), book_provider: provider,
          book_status: "provider_error",
          book_error: String(error?.code || error?.message || "order_book_refresh_failed").slice(0, 100) };
        market.book_retrieved_at_ms = null; market.book_age_ms = null;
        market.bid_depth_quote = null; market.ask_depth_quote = null;
      }
    }
    // Read the latest owner settings after public fetches complete so a concurrent
    // disable action cannot be hidden by a stale pre-fetch automation setting.
    const state = this.getState("settings") || {};
    const risk = { ...DEFAULT_RISK, ...(state.risk || {}) };
    const marketContext = assessCrossMarketContext(markets, Date.now());
    for (const market of markets) {
      market.market_context = marketContext;
      if (market.status !== "live") {
        market.entry_gate = { eligible: false, reason: "market_data_unavailable" };
      } else if (market.one_hour_audit_summary?.ok !== true) {
        market.entry_gate = { eligible: false, reason: "one_hour_candle_audit_failed" };
      } else if (market.six_hour_audit_summary?.ok !== true) {
        market.entry_gate = { eligible: false, reason: "six_hour_candle_audit_failed" };
      } else {
        market.entry_gate = assessCandidate({
          market,
          primary: market.primary || {},
          higher: market.higher || {},
          nowMs: Date.now(),
          costs: { feeBpsPerSide: risk.fee_bps_per_side, slippageBps: risk.slippage_bps },
          marketContext
        });
      }
      this.saveMarket(market, market.status === "live" ? "live" : "error");
    }
    const marketFeed = assessMarketUniverse(
      markets, PRODUCTS.map((product) => product.symbol), Date.now(),
      MAX_QUOTE_AGE_MS, MAX_ORDER_BOOK_AGE_MS
    );
    const markBySymbol = this.buildPositionLockedBidMarks(markets, Date.now());

    const exits = this.monitorExits(markBySymbol, risk, Date.now());
    const portfolio = this.portfolio(markBySymbol, risk, Date.now());
    const previousRuntime = this.getState("runtime") || {};
    const consecutiveUnhealthyScans = advanceUnhealthyScanStreak(
      Number(previousRuntime.consecutive_unhealthy_scheduled_scans || 0),
      source,
      marketFeed.healthy
    );
    const previousHealthyScanAtMs = previousRuntime.last_healthy_scan_at_ms ??
      (previousRuntime.last_scan_status === "completed" ? previousRuntime.last_scan_at_ms : null);
    const lastHealthyScanAtMs = marketFeed.healthy ? Date.now() : previousHealthyScanAtMs;
    const previousHealthyScheduledScanAtMs = previousRuntime.last_healthy_scheduled_scan_at_ms ??
      (previousRuntime.source === "scheduled" && previousRuntime.last_scan_status === "completed"
        ? previousRuntime.last_scan_at_ms : null);
    const lastHealthyScheduledScanAtMs = source === "scheduled" && marketFeed.healthy
      ? Date.now() : previousHealthyScheduledScanAtMs;
    const healthyScheduledScanStreak = source === "scheduled"
      ? (marketFeed.healthy ? Math.max(0, Number(previousRuntime.healthy_scheduled_scan_streak) || 0) + 1 : 0)
      : Math.max(0, Number(previousRuntime.healthy_scheduled_scan_streak) || 0);
    const watchdogDecision = shouldHaltPaperAutomation({
      autoEnabled: !!state.auto_paper_enabled,
      halted: !!state.halted,
      consecutiveUnhealthyScans,
      lastHealthyScanAtMs: previousHealthyScheduledScanAtMs,
      nowMs: Date.now(),
      staleAfterMs: SCAN_INTERVAL_MS * 3,
      failureThreshold: 3
    });
    if (watchdogDecision.halt) {
      const haltState = this.getState("settings") || state;
      haltState.auto_paper_resume_after_watchdog = haltState.auto_paper_enabled === true;
      haltState.auto_paper_enabled = false;
      haltState.halted = true;
      haltState.halt_reason = "market_data_watchdog";
      this.setState("settings", haltState);
      Object.assign(state, haltState);
      this.logEvent("market_data_watchdog_halt", "Paper auto-entry halted by the market-data scheduler watchdog", {
        reason: watchdogDecision.reason,
        consecutive_unhealthy_scheduled_scans: consecutiveUnhealthyScans,
        last_healthy_scan_at_ms: previousHealthyScanAtMs
      });
    }
    const latestSettings = this.getState("settings") || state;
    if (shouldAutoResumeWatchdog({
      halted: latestSettings.halted,
      haltReason: latestSettings.halt_reason,
      healthyScheduledScanStreak
    })) {
      latestSettings.halted = false;
      latestSettings.halt_reason = null;
      latestSettings.auto_paper_enabled = shouldResumePaperAutomationAfterWatchdog({
        resumeAllowed: latestSettings.auto_paper_resume_after_watchdog,
        capitalSetupRequired: latestSettings.capital_setup_required
      });
      latestSettings.auto_paper_resume_after_watchdog = false;
      this.setState("settings", latestSettings);
      Object.assign(state, latestSettings);
      this.logEvent("market_data_watchdog_recovered", "Paper auto-entry resumed after two complete healthy scheduled scans", {
        healthy_scheduled_scan_streak: healthyScheduledScanStreak
      });
    }
    const entryResults = [];
    let entryStatus = state.halted ? "halted" : "disabled";
    if (watchdogDecision.halt) {
      entryResults.push({ reason: watchdogDecision.reason });
    } else if (state.auto_paper_enabled && !state.halted) {
      // Require the complete configured universe to have fresh quotes and clean,
      // closed 1H/6H candles. A single degraded symbol blocks all new entries.
      if (!marketFeed.healthy) {
        entryStatus = "blocked";
        entryResults.push({
          reason: "market_universe_data_incomplete",
          unhealthy_markets: marketFeed.issues
        });
      } else {
        const reasons = this.entryBlockReasons(portfolio, risk, Date.now());
        if (reasons.length) {
          entryStatus = "blocked";
          entryResults.push({ reason: reasons.join(",") });
        } else {
          const candidates = [];
          for (const market of markets) {
            const assessment = market.entry_gate || { eligible: false, reason: "entry_gate_not_evaluated" };
            if (assessment.eligible) candidates.push({ market, assessment });
            else entryResults.push({ symbol: market.symbol, reason: assessment.reason });
          }
          candidates.sort((a, b) => b.market.primary.score - a.market.primary.score);
          if (candidates.length) {
            const opened = this.openPaperTrade(candidates[0], portfolio, risk, Date.now());
            if (opened.ok) {
              entryStatus = "opened";
              entryResults.push({ symbol: opened.trade.symbol, trade_id: opened.trade.id, notional_usd: opened.trade.notional_usd });
            } else {
              entryStatus = "blocked";
              entryResults.push({ reason: opened.reason });
            }
          } else {
            entryStatus = "no_qualified_signal";
          }
        }
      }
    }
    const updatedPortfolio = this.portfolio(markBySymbol, risk, Date.now());
    this.sql.exec(
      "INSERT INTO equity_snapshots(at_ms,equity_usd,realized_pnl_usd,unrealized_pnl_usd,open_positions,drawdown_pct) VALUES(?,?,?,?,?,?)",
      Date.now(), updatedPortfolio.equity_usd, updatedPortfolio.realized_pnl_usd, updatedPortfolio.unrealized_pnl_usd,
      updatedPortfolio.open_positions, updatedPortfolio.drawdown_pct_from_peak
    );
    this.sql.exec("DELETE FROM equity_snapshots WHERE at_ms NOT IN (SELECT at_ms FROM equity_snapshots ORDER BY at_ms DESC LIMIT 2000)");
    const runtimeUpdate = {
      next_alarm_at_ms: previousRuntime.next_alarm_at_ms ?? null,
      last_scheduled_alarm_at_ms: previousRuntime.last_scheduled_alarm_at_ms ?? null,
      last_scheduled_scan_status: previousRuntime.last_scheduled_scan_status || "not_run",
      last_scheduled_scan_error: previousRuntime.last_scheduled_scan_error || null,
      last_scan_at_ms: Date.now(),
      last_scan_status: marketFeed.healthy ? "completed"
        : markets.some((market) => market.status === "live") ? "partial" : "unavailable",
      last_scan_error: marketFeed.healthy ? null
        : marketFeed.issues.map((issue) => (issue.symbol || "universe") + ": " + issue.reason)
          .join("; ").slice(0, 180),
      last_healthy_scan_at_ms: lastHealthyScanAtMs,
      last_healthy_scheduled_scan_at_ms: lastHealthyScheduledScanAtMs,
      healthy_scheduled_scan_streak: healthyScheduledScanStreak,
      healthy_market_count: marketFeed.healthy_market_count,
      expected_market_count: marketFeed.expected_market_count,
      consecutive_unhealthy_scheduled_scans: consecutiveUnhealthyScans,
      source, schedule_minutes: SCAN_INTERVAL_MS / 60000, last_entry_status: entryStatus,
      last_entry_results: entryResults.slice(0, 10),
      market_feed_issues: marketFeed.issues.slice(0, 12),
      provider_failures: markets.filter((market) => market.status !== "live").map((market) => ({
        symbol: market.symbol,
        reason: market.error_code || "provider_unavailable",
        primary_error_code: market.primary_error_code || null,
        backup_error_code: market.backup_error_code || null
      })).slice(0, 3),
      market_data_providers: markets.map((market) => ({
        symbol: market.symbol,
        status: market.status,
        provider: market.market_data_provider || null,
        failover_used: market.data_quality?.failover_used === true,
        failover_attempted: market.data_quality?.failover_attempted === true,
        failover_reason: market.data_quality?.failover_reason || null,
        failover_error: market.data_quality?.failover_error || null,
        primary_provider_error: market.data_quality?.primary_provider_error || null,
        entry_ready: market.entry_gate?.eligible === true
      })).slice(0, 3)
    };
    const runtime = mergeScanRuntimeState(previousRuntime, runtimeUpdate, source);
    this.setState("runtime", runtime);
    this.logEvent("market_scan", "Market scan cycle completed", {
      source, cycle_key: cycleKey, successful_markets: markets.filter((market) => market.status === "live").length,
      healthy_markets: marketFeed.healthy_market_count, expected_markets: marketFeed.expected_market_count,
      market_feed_healthy: marketFeed.healthy,
      consecutive_unhealthy_scheduled_scans: consecutiveUnhealthyScans,
      total_markets: markets.length, paper_exits: exits.length, auto_paper_enabled: !!state.auto_paper_enabled,
      entry_status: entryStatus, entries: entryResults
    });
    return {
      source,
      markets: markets.map((market) => ({
        symbol: market.symbol, status: market.status,
        market_data_provider: market.market_data_provider || null,
        signal: market.signal || "HOLD",
        score: market.score || 0, regime_1h: market.regime_1h || "UNKNOWN",
        regime_6h: market.regime_6h || "UNKNOWN", spread_bps: market.spread_bps ?? null,
        data_quality: market.data_quality || null, error: market.error || null
      })),
      paper_exits: exits.length, paper_entries: entryResults, entry_status: entryStatus,
      market_feed: marketFeed, market_context: marketContext,
      portfolio: updatedPortfolio, live_trading_enabled: false
    };
  }

  markResearchHistoryUnavailable(product, timeframeSeconds, checkedAtMs) {
    this.sql.exec(
      "INSERT INTO research_history_state(product,timeframe_seconds,bars_count,last_quality_check_at_ms,last_quality_status) " +
      "VALUES(?,?,0,?,'provider_unavailable') ON CONFLICT(product,timeframe_seconds) DO UPDATE SET " +
      "last_quality_check_at_ms=excluded.last_quality_check_at_ms,last_quality_status=excluded.last_quality_status",
      product, timeframeSeconds, checkedAtMs
    );
  }

  archiveClosedCandles(product, timeframeSeconds, audit, receivedAtMs) {
    const intervalMs = timeframeSeconds * 1000;
    const retentionBars = timeframeSeconds === 60 ? 4320
      : timeframeSeconds === 300 ? 2000
        : timeframeSeconds === 3600 ? 4320 : timeframeSeconds === 21600 ? 1440 : 0;
    const previous = this.sql.exec(
      "SELECT * FROM research_history_state WHERE product=? AND timeframe_seconds=?",
      product, timeframeSeconds
    ).toArray()[0] || {};
    if (!retentionBars || !audit?.ok || !Array.isArray(audit.rows)) {
      const reason = !retentionBars ? "unsupported_timeframe"
        : (audit?.issues || ["candle_audit_failed"]).slice(0, 2).join(",");
      this.sql.exec(
        "INSERT INTO research_history_state(product,timeframe_seconds,bars_count,last_quality_check_at_ms,last_quality_status) " +
        "VALUES(?,?,0,?,?) ON CONFLICT(product,timeframe_seconds) DO UPDATE SET " +
        "last_quality_check_at_ms=excluded.last_quality_check_at_ms,last_quality_status=excluded.last_quality_status",
        product, timeframeSeconds, receivedAtMs, "audit_rejected:" + reason
      );
      return { stored: 0, status: "audit_rejected" };
    }

    const previousLast = previous.last_candle_ms == null ? null
      : (Number.isFinite(Number(previous.last_candle_ms)) ? Number(previous.last_candle_ms) : null);
    const newRows = selectNewClosedCandles(audit.rows, previousLast, intervalMs, receivedAtMs);
    const gapCount = countMissingArchiveBars(previousLast, newRows, intervalMs);
    if (gapCount === null) {
      this.sql.exec(
        "INSERT INTO research_history_state(product,timeframe_seconds,bars_count,last_quality_check_at_ms,last_quality_status) " +
        "VALUES(?,?,0,?,'archive_gap_alignment_error') ON CONFLICT(product,timeframe_seconds) DO UPDATE SET " +
        "last_quality_check_at_ms=excluded.last_quality_check_at_ms,last_quality_status=excluded.last_quality_status",
        product, timeframeSeconds, receivedAtMs
      );
      return { stored: 0, status: "archive_gap_alignment_error" };
    }

    let inserted = 0;
    // Keep each multi-row insert below conservative Durable Object SQLite bind limits.
    // Each candle row uses 11 parameters, so 8 rows use 88 bind variables.
    const batchSize = 8;
    for (let offset = 0; offset < newRows.length; offset += batchSize) {
      const batch = newRows.slice(offset, offset + batchSize);
      const valuesSql = batch.map(() => "(?,?,?,?,?,?,?,?,?,?,?)").join(",");
      const values = batch.flatMap((row) => [
        "coinbase_exchange", product, timeframeSeconds, row.time,
        row.open, row.high, row.low, row.close, row.volume, receivedAtMs, 1
      ]);
      inserted += this.sql.exec(
        "INSERT OR IGNORE INTO research_candles(exchange,product,timeframe_seconds,candle_open_ms,open,high,low,close,volume,received_at_ms,schema_version) " +
        "VALUES " + valuesSql + " RETURNING candle_open_ms",
        ...values
      ).toArray().length;
    }

    const latest = newRows.length ? newRows[newRows.length - 1].time : previousLast;
    const first = previous.first_candle_ms == null
      ? (newRows[0]?.time ?? null)
      : (Number.isFinite(Number(previous.first_candle_ms)) ? Number(previous.first_candle_ms) : (newRows[0]?.time ?? null));
    let barsCount = Math.max(0, Number(previous.bars_count) || 0) + inserted;
    const cumulativeGaps = Math.max(0, Number(previous.cumulative_missing_intervals) || 0) + gapCount;
    let retainedFirst = first;

    if (Number.isFinite(latest) && barsCount > retentionBars) {
      const cutoff = latest - ((retentionBars - 1) * intervalMs);
      const deleted = Number(this.sql.exec(
        "SELECT COUNT(*) AS count FROM research_candles WHERE exchange='coinbase_exchange' AND product=? AND timeframe_seconds=? AND candle_open_ms<?",
        product, timeframeSeconds, cutoff
      ).toArray()[0]?.count || 0);
      if (deleted > 0) {
        this.sql.exec(
          "DELETE FROM research_candles WHERE exchange='coinbase_exchange' AND product=? AND timeframe_seconds=? AND candle_open_ms<?",
          product, timeframeSeconds, cutoff
        );
        barsCount = Math.max(0, barsCount - deleted);
        retainedFirst = this.sql.exec(
          "SELECT MIN(candle_open_ms) AS first_candle_ms FROM research_candles WHERE exchange='coinbase_exchange' AND product=? AND timeframe_seconds=?",
          product, timeframeSeconds
        ).toArray()[0]?.first_candle_ms ?? null;
      }
    }

    this.sql.exec(
      "INSERT INTO research_history_state(product,timeframe_seconds,bars_count,first_candle_ms,last_candle_ms,cumulative_missing_intervals,last_quality_check_at_ms,last_ingested_at_ms,last_quality_status) " +
      "VALUES(?,?,?,?,?,?,?,?, 'clean') ON CONFLICT(product,timeframe_seconds) DO UPDATE SET " +
      "bars_count=excluded.bars_count,first_candle_ms=excluded.first_candle_ms,last_candle_ms=excluded.last_candle_ms," +
      "cumulative_missing_intervals=excluded.cumulative_missing_intervals,last_quality_check_at_ms=excluded.last_quality_check_at_ms," +
      "last_ingested_at_ms=COALESCE(excluded.last_ingested_at_ms,research_history_state.last_ingested_at_ms)," +
      "last_quality_status=excluded.last_quality_status",
      product, timeframeSeconds, barsCount, retainedFirst, latest,
      cumulativeGaps, receivedAtMs, inserted > 0 ? receivedAtMs : null
    );
    return { stored: inserted, bars_count: barsCount, cumulative_missing_intervals: cumulativeGaps, status: "clean" };
  }

  archiveProviderCandles(exchange, product, timeframeSeconds, audit, receivedAtMs) {
    if (exchange !== "bitstamp_spot") return { stored: 0, status: "unsupported_provider" };
    const retentionBars = timeframeSeconds === 60 ? 4320
      : timeframeSeconds === 300 ? 2000
        : timeframeSeconds === 3600 ? 4320 : timeframeSeconds === 21600 ? 1440 : 0;
    if (!retentionBars || !audit?.ok || !Array.isArray(audit.rows)) {
      return { stored: 0, status: "audit_rejected" };
    }

    const intervalMs = timeframeSeconds * 1000;
    const rows = audit.rows.slice(-retentionBars);
    const previousLastValue = this.sql.exec(
      "SELECT MAX(candle_open_ms) AS last_candle_ms FROM research_candles " +
      "WHERE exchange=? AND product=? AND timeframe_seconds=?",
      exchange, product, timeframeSeconds
    ).toArray()[0]?.last_candle_ms;
    const previousLast = previousLastValue == null ? null
      : (Number.isFinite(Number(previousLastValue)) ? Number(previousLastValue) : null);
    const newRows = previousLast === null
      ? rows
      : rows.filter((row) => Number(row.time) > previousLast);

    const gapCount = countMissingArchiveBars(previousLast, newRows, intervalMs);
    if (gapCount === null) return { stored: 0, status: "archive_gap_alignment_error" };

    let inserted = 0;
    // Only add candles newer than this provider's archive cursor. A normal scan
    // therefore writes at most the newly closed bars, not the full 160–200 bar
    // window on every 15-minute cycle.
    const batchSize = 8;
    for (let offset = 0; offset < newRows.length; offset += batchSize) {
      const batch = newRows.slice(offset, offset + batchSize);
      const valuesSql = batch.map(() => "(?,?,?,?,?,?,?,?,?,?,?)").join(",");
      const values = batch.flatMap((row) => [
        exchange, product, timeframeSeconds, row.time,
        row.open, row.high, row.low, row.close, row.volume, receivedAtMs, 1
      ]);
      inserted += this.sql.exec(
        "INSERT OR IGNORE INTO research_candles(exchange,product,timeframe_seconds,candle_open_ms,open,high,low,close,volume,received_at_ms,schema_version) " +
        "VALUES " + valuesSql + " RETURNING candle_open_ms",
        ...values
      ).toArray().length;
    }

    const latest = newRows.at(-1)?.time ?? previousLast;
    if (Number.isFinite(latest)) {
      const cutoff = latest - ((retentionBars - 1) * intervalMs);
      this.sql.exec(
        "DELETE FROM research_candles WHERE exchange=? AND product=? AND timeframe_seconds=? AND candle_open_ms<?",
        exchange, product, timeframeSeconds, cutoff
      );
    }
    return {
      stored: inserted,
      bars_count: Math.min(retentionBars, rows.length),
      missing_intervals_since_previous_archive: gapCount,
      status: "clean"
    };
  }

  researchTournament() {
    const settings = this.getState("settings") || {};
    const risk = { ...DEFAULT_RISK, ...(settings.risk || {}) };
    const initialEquity = Number(settings.initial_capital_usd) > 0 ? Number(settings.initial_capital_usd) : 100;
    const assets = PRODUCTS.map(({ symbol, product }) => {
      const loadBars = (timeframeSeconds, limit) => this.sql.exec(
        "SELECT candle_open_ms AS time,open,high,low,close,volume FROM research_candles " +
        "WHERE exchange='coinbase_exchange' AND product=? AND timeframe_seconds=? " +
        "ORDER BY candle_open_ms DESC LIMIT ?",
        product, timeframeSeconds, limit
      ).toArray().reverse();
      // Retention is 4,320 1H bars / 1,440 6H bars. Load enough history
      // to meet the stricter four-fold walk-forward gate when the archive has
      // accumulated at least ~125 days of clean provider-consistent candles.
      const candles1h = loadBars(3600, 3500);
      const candles6h = loadBars(21600, 1200);
      const options = {
        initialEquity,
        allocationPct: 0.1,
        feeBpsPerSide: risk.fee_bps_per_side,
        slippageBps: risk.slippage_bps
      };
      const exploratory = runStrategyTournament({
        candles1h, candles6h,
        options: { ...options, includeMonteCarlo: true },
        startIndex: 100
      });
      const walkForward = runWalkForwardResearch({ candles1h, candles6h, options });
      const recursiveWarmup = runRecursiveWarmupAnalysis({ candles1h, candles6h });
      const compactStrategies = (strategies) => Object.fromEntries(
        Object.entries(strategies || {}).map(([name, result]) => {
          const { trades = [], ...summary } = result;
          return [name, { ...summary, trade_records_omitted: trades.length }];
        })
      );
      const compactExploratory = exploratory.ok
        ? { ...exploratory, strategies: compactStrategies(exploratory.strategies) }
        : exploratory;
      const compactWalkForward = walkForward.ok
        ? {
          ...walkForward,
          folds: walkForward.folds.map((fold) => ({
            ...fold,
            results: compactStrategies(fold.results)
          })),
          cost_stress: walkForward.cost_stress.map((item) => ({
            cost_multiplier: item.cost_multiplier,
            result: item.result.ok
              ? { ...item.result, strategies: compactStrategies(item.result.strategies) }
              : item.result
          }))
        }
        : walkForward;
      return {
        symbol,
        product,
        history: { bars_1h: candles1h.length, bars_6h: candles6h.length },
        recursive_warmup: recursiveWarmup,
        exploratory: compactExploratory,
        walk_forward: compactWalkForward
      };
    });
    return {
      mode: "offline_research_only",
      generated_at_ms: Date.now(),
      no_trading_side_effects: true,
      strategy_comparability: {
        status: "not_equivalent",
        production_paper_strategy: {
          version: "cloud-paper-v1",
          entry_model: "assessCandidate with live ticker, spread, order-book depth, closed 1H/6H indicators and market-data freshness gates",
          fill_model: "current ask plus configured slippage; exits are monitored from fresh bid marks with configured slippage",
          exit_model: "fixed initial stop, cost-aware dynamic take-profit and one-way cost-aware trailing stop"
        },
        tournament_models: ["trend_continuation", "range_mean_reversion", "breakout_continuation"],
        reason: "The offline tournament uses separate research entry hypotheses, ATR-based stop/target rules and next-1H-open fills; it does not replay cloud-paper-v1.",
        limitations: [
          "Archived OHLCV has no historical spread or order-book depth, so production entry-liquidity gates cannot be replayed.",
          "Tournament results compare research hypotheses with each other only; they are not expected returns or a historical backtest of the production PAPER bot."
        ]
      },
      assumptions: {
        initial_equity_usd: initialEquity,
        allocation_pct: 10,
        fee_bps_per_side: risk.fee_bps_per_side,
        slippage_bps_per_side: risk.slippage_bps,
        spread_model: "not_available_in_ohlcv_archive; slippage_is_a_stress_proxy",
        execution: "next_1h_open",
        stop_target_conflict: "stop_first",
        live_execution_enabled: false
      },
      assets
    };
  }

  researchHistorySummary() {
    const records = this.sql.exec(
      "SELECT product,timeframe_seconds,bars_count,first_candle_ms,last_candle_ms,cumulative_missing_intervals," +
      "last_quality_check_at_ms,last_ingested_at_ms,last_quality_status FROM research_history_state " +
      "ORDER BY product,timeframe_seconds"
    ).toArray();
    return buildResearchHistorySummary(records, Date.now());
  }

  saveMarket(market, status) {
    this.sql.exec(
      "INSERT INTO market_snapshots(symbol,status,observed_at_ms,data_json) VALUES(?,?,?,?) " +
      "ON CONFLICT(symbol) DO UPDATE SET status=excluded.status,observed_at_ms=excluded.observed_at_ms,data_json=excluded.data_json",
      market.symbol, status, market.fetched_at_ms || Date.now(), JSON.stringify(market)
    );
  }

  getMarkets() {
    return this.sql.exec("SELECT data_json FROM market_snapshots ORDER BY symbol").toArray()
      .map((row) => { try { return JSON.parse(row.data_json); } catch { return { status: "error" }; } });
  }

  /**
   * Refresh only L2 books between slower strategy/candle scans. This method
   * never recalculates entry signals or opens positions. Each book must come
   * from the exact provider already selected for that market.
   */
  async refreshOrderBooksOnly() {
    const markets = this.getMarkets();
    const bySymbol = new Map(markets.map((market) => [market?.symbol, market]));
    const coinbaseState = createCoinbaseRequestState();
    const requestState = coinbaseState;
    const initialOpenTrades = this.getOpenTrades();
    const legacyBitstampExitSymbols = new Set(
      initialOpenTrades
        .filter((trade) => trade.metadata?.market_data_provider === "bitstamp_spot")
        .map((trade) => trade.symbol)
    );
    const issues = [];
    let refreshed = 0;
    let failed = 0;
    let skipped = 0;

    for (const product of PRODUCTS) {
      const market = bySymbol.get(product.symbol);
      if (!market || market.status !== "live") {
        skipped += 1;
        issues.push({ symbol: product.symbol, reason: "market_snapshot_unavailable" });
        continue;
      }

      const provider = market.market_data_provider;
      try {
        let book;
        if (provider === "coinbase_exchange") {
          book = await fetchCoinbaseOrderBook(market.product, requestState);
        } else if (provider === "bitstamp_spot" &&
                   legacyBitstampExitSymbols.has(product.symbol)) {
          // Transitional read-only mark refresh for a pre-existing Bitstamp paper
          // position. New entries are Coinbase-only and cannot use this branch.
          book = await fetchBitstampOrderBook(market.product, requestState);
        } else {
          skipped += 1;
          issues.push({ symbol: product.symbol, reason: "market_data_provider_unsupported" });
          continue;
        }

        const retrievedAtMs = Number(book?.book_retrieved_at_ms);
        if (!Number.isFinite(retrievedAtMs) || retrievedAtMs <= 0 ||
            retrievedAtMs > Date.now() + 1000 ||
            ![book.bid, book.ask, book.bid_depth_quote, book.ask_depth_quote].every(Number.isFinite) ||
            book.bid <= 0 || book.ask < book.bid ||
            book.bid_depth_quote < 0 || book.ask_depth_quote < 0) {
          throw new Error("order_book_failed_validation");
        }

        market.bid = book.bid;
        market.ask = book.ask;
        market.bid_depth_quote = book.bid_depth_quote;
        market.ask_depth_quote = book.ask_depth_quote;
        market.book_retrieved_at_ms = retrievedAtMs;
        market.book_event_time_ms = Number.isFinite(book.book_event_time_ms)
          ? book.book_event_time_ms : null;
        market.book_age_ms = Math.max(0, Date.now() - retrievedAtMs);
        market.book_sequence = Number.isSafeInteger(book.book_sequence) ? book.book_sequence : null;
        market.quote_received_at_ms = retrievedAtMs;
        market.spread_bps = ((book.ask - book.bid) / ((book.ask + book.bid) / 2)) * 10000;
        market.data_quality = {
          ...(market.data_quality || {}),
          book_provider: provider,
          book_status: "available",
          book_error: null,
          book_freshness_source: provider === "bitstamp_spot"
            ? "bitstamp_exchange_order_book_timestamp"
            : "coinbase_local_l2_retrieval_time",
          quote_freshness_source: "local_order_book_response_time_for_exit_marking"
        };
        this.saveMarket(market, "live");
        refreshed += 1;
      } catch (error) {
        failed += 1;
        const status = Number(error?.status);
        const errorCode = typeof error?.code === "string" && /^[a-z0-9_]{1,80}$/.test(error.code)
          ? error.code
          : status === 429 ? "provider_rate_limited"
            : status >= 500 ? "provider_server_error"
              : "order_book_refresh_failed";
        market.data_quality = {
          ...(market.data_quality || {}),
          book_provider: provider,
          book_status: "provider_error",
          book_error: errorCode
        };
        this.saveMarket(market, "live");
        issues.push({ symbol: product.symbol, reason: errorCode });
      }
    }

    // The market objects above were updated in place and persisted by saveMarket().
    // Reuse them instead of reading all snapshot rows a second time on every 10s alarm.
    const refreshedMarkets = markets;
    const feed = assessMarketUniverse(
      refreshedMarkets, PRODUCTS.map((product) => product.symbol), Date.now(), MAX_QUOTE_AGE_MS, MAX_ORDER_BOOK_AGE_MS
    );
    const status = failed === 0 && skipped === 0 ? "completed"
      : refreshed > 0 ? "partial" : "unavailable";

    // Existing PAPER positions get a fresh-book exit check at this faster cadence.
    // The provider lock is retained; this path has no entry or live-order code.
    const settings = this.getState("settings") || {};
    const risk = { ...DEFAULT_RISK, ...(settings.risk || {}) };
    // Refresh open positions once after external awaits so a concurrent owner close
    // is respected. Pass the snapshot into both helpers to avoid duplicate SQL reads.
    const openTrades = this.getOpenTrades();
    const markBySymbol = this.buildPositionLockedBidMarks(refreshedMarkets, Date.now(), openTrades);
    const exits = this.monitorExits(markBySymbol, risk, Date.now(), openTrades);
    // Do not run full-ledger SUM/COUNT risk aggregates on every 10s book refresh.
    // Portfolio/risk baselines are recomputed on the 90s strategy scan and dashboard.

    const telemetry = {
      last_book_refresh_at_ms: Date.now(),
      last_book_refresh_status: status,
      last_book_refresh_success_count: refreshed,
      last_book_refresh_failed_count: failed,
      last_book_refresh_skipped_count: skipped,
      last_book_refresh_healthy_market_count: feed.healthy_market_count,
      last_book_refresh_expected_market_count: feed.expected_market_count,
      last_book_refresh_issues: issues.slice(0, PRODUCTS.length).map((issue) => ({
        symbol: issue.symbol,
        reason: String(issue.reason || "unknown").slice(0, 100)
      })),
      last_book_refresh_exits: exits
    };

    return { status, refreshed, failed, skipped, market_feed: feed, paper_exits: exits, telemetry };
  }

  getOpenTrades() {
    return this.sql.exec("SELECT * FROM trades WHERE status='OPEN' ORDER BY opened_at_ms ASC").toArray()
      .map((row) => ({ ...row, metadata: this.parseJson(row.metadata_json) }));
  }

  buildPositionLockedBidMarks(markets, nowMs = Date.now(), openTrades = null) {
    const positions = Array.isArray(openTrades) ? openTrades : this.getOpenTrades();
    const requiredProviders = new Map(
      positions.map((trade) => [
        trade.symbol,
        typeof trade.metadata?.market_data_provider === "string" && trade.metadata.market_data_provider
          ? trade.metadata.market_data_provider
          : "coinbase_exchange"
      ])
    );
    return buildFreshBidMarks(
      markets, nowMs, MAX_QUOTE_AGE_MS, requiredProviders
    );
  }

  getTrades(limit = 100, offset = 0) {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(Number(limit) || 100)));
    const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0));
    return this.sql.exec("SELECT * FROM trades ORDER BY id DESC LIMIT ? OFFSET ?", safeLimit, safeOffset).toArray()
      .map((row) => ({ ...row, metadata: this.parseJson(row.metadata_json) }));
  }

  tradeAnalytics() {
    const totals = this.sql.exec(
      "SELECT COUNT(*) AS total_trades, " +
      "SUM(CASE WHEN status='CLOSED' THEN 1 ELSE 0 END) AS closed_trades, " +
      "SUM(CASE WHEN status='OPEN' THEN 1 ELSE 0 END) AS open_trades, " +
      "SUM(CASE WHEN status='CLOSED' AND pnl_usd>0 THEN 1 ELSE 0 END) AS wins, " +
      "SUM(CASE WHEN status='CLOSED' AND pnl_usd<0 THEN 1 ELSE 0 END) AS losses, " +
      "COALESCE(SUM(CASE WHEN status='CLOSED' AND pnl_usd>0 THEN pnl_usd ELSE 0 END),0) AS gross_profit_usd, " +
      "COALESCE(SUM(CASE WHEN status='CLOSED' AND pnl_usd<0 THEN pnl_usd ELSE 0 END),0) AS gross_loss_signed_usd, " +
      "COALESCE(SUM(CASE WHEN status='CLOSED' THEN pnl_usd ELSE 0 END),0) AS net_realized_pnl_usd, " +
      "COALESCE(SUM(fees_usd),0) AS total_fees_usd, " +
      "AVG(CASE WHEN status='CLOSED' THEN pnl_usd END) AS expectancy_per_closed_trade_usd, " +
      "AVG(CASE WHEN status='CLOSED' AND pnl_usd>0 THEN pnl_usd END) AS average_win_usd, " +
      "AVG(CASE WHEN status='CLOSED' AND pnl_usd<0 THEN pnl_usd END) AS average_loss_usd, " +
      "AVG(CASE WHEN status='CLOSED' THEN (closed_at_ms-opened_at_ms)/60000.0 END) AS average_holding_minutes " +
      "FROM trades"
    ).toArray()[0] || {};
    const closed = Number(totals.closed_trades || 0);
    const wins = Number(totals.wins || 0);
    const grossProfit = Number(totals.gross_profit_usd || 0);
    const grossLossAbs = Math.abs(Number(totals.gross_loss_signed_usd || 0));
    const perSymbol = this.sql.exec(
      "SELECT symbol, COUNT(*) AS total_trades, " +
      "SUM(CASE WHEN status='CLOSED' THEN 1 ELSE 0 END) AS closed_trades, " +
      "SUM(CASE WHEN status='CLOSED' AND pnl_usd>0 THEN 1 ELSE 0 END) AS wins, " +
      "COALESCE(SUM(CASE WHEN status='CLOSED' THEN pnl_usd ELSE 0 END),0) AS net_pnl_usd, " +
      "COALESCE(SUM(fees_usd),0) AS fees_usd " +
      "FROM trades GROUP BY symbol ORDER BY symbol"
    ).toArray();
    const equityHistory = this.sql.exec(
      "SELECT at_ms,equity_usd,realized_pnl_usd,unrealized_pnl_usd,open_positions,drawdown_pct " +
      "FROM (SELECT * FROM equity_snapshots ORDER BY at_ms DESC LIMIT 200) ORDER BY at_ms ASC"
    ).toArray();
    const executionRows = this.sql.exec(
      "SELECT entry_price,metadata_json,status FROM trades ORDER BY opened_at_ms DESC,id DESC LIMIT ?",
      DASHBOARD_ANALYTICS_SAMPLE_LIMIT
    ).toArray().map((row) => ({
      entry_price: Number(row.entry_price),
      status: row.status,
      metadata: this.parseJson(row.metadata_json)
    }));
    const executionAudit = summarizePaperExecution(executionRows);
    const recentClosed = this.sql.exec(
      "SELECT pnl_usd FROM trades WHERE status='CLOSED' ORDER BY closed_at_ms DESC,id DESC LIMIT ?",
      DASHBOARD_ANALYTICS_SAMPLE_LIMIT
    ).toArray();
    let currentLossStreak = 0;
    let longestRecentLossStreak = 0;
    for (const row of recentClosed) {
      if (Number(row.pnl_usd) < 0) {
        currentLossStreak += 1;
        longestRecentLossStreak = Math.max(longestRecentLossStreak, currentLossStreak);
      } else {
        currentLossStreak = 0;
      }
    }
    return {
      mode: "paper_only",
      total_trades: Number(totals.total_trades || 0),
      closed_trades: closed,
      open_trades: Number(totals.open_trades || 0),
      wins, losses: Number(totals.losses || 0),
      win_rate_pct: closed ? Number((wins / closed * 100).toFixed(2)) : null,
      gross_profit_usd: grossProfit,
      gross_loss_usd: grossLossAbs,
      profit_factor: grossLossAbs > 0 ? Number((grossProfit / grossLossAbs).toFixed(4)) : null,
      profit_factor_unbounded: grossProfit > 0 && grossLossAbs === 0,
      net_realized_pnl_usd: Number(totals.net_realized_pnl_usd || 0),
      total_fees_usd: Number(totals.total_fees_usd || 0),
      expectancy_per_closed_trade_usd: totals.expectancy_per_closed_trade_usd == null ? null : Number(totals.expectancy_per_closed_trade_usd),
      average_win_usd: totals.average_win_usd == null ? null : Number(totals.average_win_usd),
      average_loss_usd: totals.average_loss_usd == null ? null : Number(totals.average_loss_usd),
      average_holding_minutes: totals.average_holding_minutes == null ? null : Number(totals.average_holding_minutes),
      execution_audit: executionAudit,
      longest_loss_streak_in_latest_250_closed: longestRecentLossStreak,
      loss_streak_scope: "latest 250 closed trades",
      per_symbol: perSymbol.map((row) => ({
        symbol: row.symbol, total_trades: Number(row.total_trades || 0),
        closed_trades: Number(row.closed_trades || 0), wins: Number(row.wins || 0),
        win_rate_pct: Number(row.closed_trades || 0) ? Number((Number(row.wins || 0) / Number(row.closed_trades) * 100).toFixed(2)) : null,
        net_pnl_usd: Number(row.net_pnl_usd || 0), fees_usd: Number(row.fees_usd || 0)
      })),
      equity_history: equityHistory
    };
  }

  parseJson(value) {
    try { return JSON.parse(value || "{}"); } catch { return {}; }
  }

  monitorExits(markBySymbol, risk, nowMs, openTrades = null) {
    const closed = [];
    const positions = Array.isArray(openTrades) ? openTrades : this.getOpenTrades();
    for (const trade of positions) {
      const bid = markBySymbol.get(trade.symbol);
      if (!Number.isFinite(bid) || bid <= 0) continue;

      const metadata = trade.metadata || {};
      const roundTripCostBps = Number.isFinite(Number(metadata.round_trip_cost_bps))
        ? Number(metadata.round_trip_cost_bps)
        : 2 * (risk.fee_bps_per_side + risk.slippage_bps);
      const trailing = updateTrailingStop({
        entryPrice: trade.entry_price,
        currentStop: trade.stop_loss,
        previousHighWater: Number(metadata.high_water_bid),
        currentBid: bid,
        roundTripCostBps
      });
      if (trailing.ok && trailing.changed) {
        const nextMetadata = {
          ...metadata,
          high_water_bid: trailing.highWaterBid,
          trailing_stop_active: trailing.active,
          trailing_activation_pct: trailing.activationPct,
          trailing_distance_pct: trailing.distancePct
        };
        this.sql.exec(
          "UPDATE trades SET stop_loss=?,metadata_json=? WHERE id=? AND status='OPEN'",
          trailing.stopLoss, JSON.stringify(nextMetadata), trade.id
        );
        const previousStop = trade.stop_loss;
        trade.stop_loss = trailing.stopLoss;
        trade.metadata = nextMetadata;
        if (trailing.stopLoss > previousStop + 1e-10) {
          this.logEvent("paper_trailing_stop", "Paper trailing stop moved upward", {
            trade_id: trade.id, symbol: trade.symbol,
            previous_stop: previousStop, trailing_stop: trailing.stopLoss,
            high_water_bid: trailing.highWaterBid
          });
        }
      }

      let reference = null;
      let reason = null;
      if (bid <= trade.stop_loss) {
        reference = bid;
        reason = trade.metadata?.trailing_stop_active ? "trailing_stop" : "stop_loss";
      } else if (bid >= trade.take_profit) {
        reference = trade.take_profit;
        reason = "take_profit";
      }
      if (reference === null) continue;
      const exitPrice = reference * (1 - risk.slippage_bps / 10000);
      const exitFee = exitPrice * trade.quantity * risk.fee_bps_per_side / 10000;
      const netPnl = (exitPrice - trade.entry_price) * trade.quantity - trade.fees_usd - exitFee;
      this.sql.exec(
        "UPDATE trades SET status='CLOSED',closed_at_ms=?,exit_price=?,fees_usd=?,pnl_usd=?,metadata_json=? WHERE id=? AND status='OPEN'",
        nowMs, exitPrice, trade.fees_usd + exitFee, netPnl,
        JSON.stringify({
          ...trade.metadata,
          close_reason: reason,
          close_reference_price: reference,
          exit_mark_bid: bid,
          exit_fill_price: exitPrice,
          exit_slippage_bps: risk.slippage_bps,
          exit_fee_bps_per_side: risk.fee_bps_per_side,
          exit_observed_at_ms: nowMs,
          close_market_data_provider: trade.metadata?.market_data_provider || "coinbase_exchange"
        }), trade.id
      );
      this.logEvent("paper_exit", "Paper position closed by " + reason, {
        trade_id: trade.id,
        symbol: trade.symbol,
        net_pnl_usd: netPnl,
        market_data_provider: trade.metadata?.market_data_provider || "coinbase_exchange"
      });
      closed.push({ trade_id: trade.id, symbol: trade.symbol, reason, net_pnl_usd: netPnl });
    }
    return closed;
  }

  closeTradeAt(trade, bid, risk, nowMs, reason, exitMarketDataProvider = null) {
    const exitPrice = bid * (1 - risk.slippage_bps / 10000);
    const exitFee = exitPrice * trade.quantity * risk.fee_bps_per_side / 10000;
    const netPnl = (exitPrice - trade.entry_price) * trade.quantity - trade.fees_usd - exitFee;
    const updated = this.sql.exec(
      "UPDATE trades SET status='CLOSED',closed_at_ms=?,exit_price=?,fees_usd=?,pnl_usd=?,metadata_json=? WHERE id=? AND status='OPEN' RETURNING id",
      nowMs, exitPrice, trade.fees_usd + exitFee, netPnl,
      JSON.stringify({
        ...trade.metadata,
        close_reason: reason,
        close_reference_price: bid,
        exit_mark_bid: bid,
        exit_fill_price: exitPrice,
        exit_slippage_bps: risk.slippage_bps,
        exit_fee_bps_per_side: risk.fee_bps_per_side,
        exit_observed_at_ms: nowMs,
        close_market_data_provider: exitMarketDataProvider ||
          trade.metadata?.market_data_provider || "coinbase_exchange"
      }), trade.id
    ).toArray();
    if (updated.length !== 1) throw new Error("paper_trade_already_closed");
    this.logEvent("paper_exit", "Paper position closed by owner", {
      trade_id: trade.id, symbol: trade.symbol, net_pnl_usd: netPnl, reason
    });
    return this.getTrades(100).find((item) => item.id === trade.id);
  }

  portfolio(markBySymbol, risk, nowMs) {
    const realized = Number(this.sql.exec("SELECT COALESCE(SUM(pnl_usd),0) AS pnl FROM trades WHERE status='CLOSED'").toArray()[0]?.pnl || 0);
    const initial = Number(this.getState("settings")?.initial_capital_usd || 100);
    const openTrades = this.getOpenTrades();
    let unrealized = 0;
    let exposure = 0;
    let unmarked = 0;
    for (const trade of openTrades) {
      const bid = markBySymbol.get(trade.symbol);
      if (!Number.isFinite(bid) || bid <= 0) {
        unmarked += 1; exposure += trade.notional_usd; continue;
      }
      const estimatedExit = bid * (1 - risk.slippage_bps / 10000);
      const exitFee = estimatedExit * trade.quantity * risk.fee_bps_per_side / 10000;
      unrealized += (estimatedExit - trade.entry_price) * trade.quantity - trade.fees_usd - exitFee;
      exposure += bid * trade.quantity;
    }
    const equity = initial + realized + unrealized;
    const settings = this.getState("settings");
    const storedPeak = Math.max(initial, Number(settings.peak_equity_usd || initial));
    // An unmarked open position makes current equity incomplete. Do not let a
    // stale/incomplete valuation move the persisted high-water mark.
    const peak = unmarked > 0 ? storedPeak : Math.max(storedPeak, equity);
    if (unmarked === 0 && peak > storedPeak) {
      settings.peak_equity_usd = peak;
      this.setState("settings", settings);
    }
    const drawdown = unmarked > 0 ? null : (peak > 0 ? Math.max(0, ((peak - equity) / peak) * 100) : 0);
    const dayKey = new Date(nowMs).toISOString().slice(0, 10);
    const closedToday = Number(this.sql.exec(
      "SELECT COALESCE(SUM(pnl_usd),0) AS pnl FROM trades WHERE status='CLOSED' AND date(closed_at_ms/1000,'unixepoch')=?",
      dayKey
    ).toArray()[0]?.pnl || 0);
    const monday = new Date(nowMs);
    const weekday = (monday.getUTCDay() + 6) % 7;
    monday.setUTCDate(monday.getUTCDate() - weekday);
    const weekStartMs = Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate());
    const closedThisWeek = Number(this.sql.exec(
      "SELECT COALESCE(SUM(pnl_usd),0) AS pnl FROM trades WHERE status='CLOSED' AND closed_at_ms>=?",
      weekStartMs
    ).toArray()[0]?.pnl || 0);
    const ledgerTradeCount = Number(this.sql.exec(
      "SELECT COUNT(*) AS count FROM trades"
    ).toArray()[0]?.count || 0);
    const dayBaseline = resolveRiskBaseline({
      periodKey: dayKey, storedPeriodKey: this.getState("risk_day_key"),
      storedBaseline: this.getState("risk_day_baseline"), equity, closedPnl: closedToday,
      unmarkedPositions: unmarked, tradeCount: ledgerTradeCount
    });
    if (dayBaseline.shouldPersist) {
      this.setState("risk_day_key", dayKey);
      this.setState("risk_day_baseline", dayBaseline.baseline);
    }
    const weekKey = new Date(weekStartMs).toISOString().slice(0, 10);
    const weekBaseline = resolveRiskBaseline({
      periodKey: weekKey, storedPeriodKey: this.getState("risk_week_key"),
      storedBaseline: this.getState("risk_week_baseline"), equity, closedPnl: closedThisWeek,
      unmarkedPositions: unmarked, tradeCount: ledgerTradeCount
    });
    if (weekBaseline.shouldPersist) {
      this.setState("risk_week_key", weekKey);
      this.setState("risk_week_baseline", weekBaseline.baseline);
    }
    return {
      mode: "paper_only", initial_capital_usd: initial, realized_pnl_usd: realized, unrealized_pnl_usd: unrealized,
      equity_usd: equity, exposure_usd: exposure, open_positions: openTrades.length, unmarked_positions: unmarked,
      peak_equity_usd: peak, drawdown_pct_from_peak: drawdown,
      daily_equity_pnl_usd: dayBaseline.initialized ? equity - dayBaseline.baseline : null,
      weekly_equity_pnl_usd: weekBaseline.initialized ? equity - weekBaseline.baseline : null,
      daily_risk_baseline_usd: dayBaseline.initialized ? dayBaseline.baseline : null,
      weekly_risk_baseline_usd: weekBaseline.initialized ? weekBaseline.baseline : null,
      daily_risk_baseline_initialized: dayBaseline.initialized,
      weekly_risk_baseline_initialized: weekBaseline.initialized,
      ledger_trade_count: ledgerTradeCount,
      risk_period_timezone: "UTC", last_updated_at_ms: nowMs
    };
  }

  entryBlockReasons(portfolio, risk, nowMs) {
    const reasons = [];
    if (portfolio.unmarked_positions > 0) reasons.push("open_position_without_fresh_mark");
    if (portfolio.open_positions >= risk.max_open_positions) reasons.push("max_open_positions");
    const protection = this.riskProtectionStatus(portfolio, risk, nowMs);
    reasons.push(...protection.block_reasons);
    if (this.getState("settings")?.capital_setup_required) reasons.push("paper_capital_setup_review_required");
    if (portfolio.drawdown_pct_from_peak >= risk.max_total_drawdown_pct) {
      reasons.push("max_total_drawdown");
      const state = this.getState("settings");
      state.auto_paper_enabled = false; state.auto_paper_resume_after_watchdog = false; state.halted = true; state.halt_reason = "max_total_drawdown"; this.setState("settings", state);
      this.logEvent("drawdown_circuit_breaker", "Paper automation halted by total drawdown limit");
    }
    if (!Number.isFinite(portfolio.daily_equity_pnl_usd) || !Number.isFinite(portfolio.weekly_equity_pnl_usd)) {
      reasons.push("risk_period_baseline_unavailable");
    } else {
      if (portfolio.daily_equity_pnl_usd <= -(portfolio.initial_capital_usd * risk.max_daily_loss_pct / 100)) reasons.push("daily_loss_limit");
      if (portfolio.weekly_equity_pnl_usd <= -(portfolio.initial_capital_usd * risk.max_weekly_loss_pct / 100)) reasons.push("weekly_loss_limit");
    }
    const dayStart = new Date(nowMs); dayStart.setUTCHours(0, 0, 0, 0);
    const completedCyclesToday = countCompletedPaperCyclesInWindow(
      this.sql, dayStart.getTime(), dayStart.getTime() + 24 * 60 * 60 * 1000
    );
    if (!getDailyCycleAllowance(completedCyclesToday, PAPER_AUTOMATION_PROFILE.max_cycles_per_day).allowed) {
      reasons.push("daily_cycle_cap");
    }
    const maxExposure = portfolio.equity_usd * risk.max_total_exposure_pct / 100;
    if (portfolio.exposure_usd >= maxExposure) reasons.push("max_exposure");
    return [...new Set(reasons)];
  }

  openPaperTrade(candidate, portfolio, risk, nowMs) {
    const market = candidate.market;
    const assessment = candidate.assessment;
    // Defense in depth: no caller or future route may open a fresh PAPER
    // position from a legacy Bitstamp exit snapshot.
    if (market?.market_data_provider !== "coinbase_exchange") {
      return { ok: false, reason: "coinbase_market_data_required_for_new_entry" };
    }
    if (assessment?.eligible !== true) {
      return { ok: false, reason: assessment?.reason || "paper_entry_assessment_not_eligible" };
    }
    const previous = this.sql.exec(
      "SELECT status,opened_at_ms,closed_at_ms FROM trades WHERE symbol=? ORDER BY opened_at_ms DESC LIMIT 1",
      market.symbol
    ).toArray()[0];
    if (previous) {
      const lastAt = previous.status === "OPEN" ? previous.opened_at_ms : previous.closed_at_ms;
      if (previous.status === "OPEN") return { ok: false, reason: "position_already_open" };
      if (lastAt && nowMs - lastAt < 4 * 60 * 60 * 1000) return { ok: false, reason: "symbol_cooldown_4h" };
    }
    const recentClosed = this.sql.exec(
      "SELECT pnl_usd,closed_at_ms FROM trades WHERE status='CLOSED' ORDER BY closed_at_ms DESC,id DESC LIMIT 3"
    ).toArray();
    const lossCooldown = assessLossCooldown(recentClosed, nowMs);
    if (lossCooldown.blocked) return { ok: false, reason: lossCooldown.reason };
    const adaptiveRisk = assessAdaptiveRisk({
      drawdownPct: portfolio.drawdown_pct_from_peak,
      lossStreak: lossCooldown.lossStreak
    });
    if (!adaptiveRisk.allowed) return { ok: false, reason: adaptiveRisk.reason };

    const entryPrice = market.ask * (1 + risk.slippage_bps / 10000);
    const feeRate = risk.fee_bps_per_side / 10000;
    const roundTripCostBps = 2 * (risk.fee_bps_per_side + risk.slippage_bps) + assessment.spread_bps;
    const roundTripCostRate = roundTripCostBps / 10000;
    const dynamicTarget = calculateDynamicTakeProfit({
      atrPct: market.primary?.atr_pct,
      roundTripCostBps
    });
    if (!dynamicTarget.ok) return { ok: false, reason: dynamicTarget.reason };
    const effectiveStopRate = risk.stop_loss_pct / 100 + roundTripCostRate;
    const effectiveRiskPct = risk.risk_per_trade_pct * adaptiveRisk.multiplier;
    const riskBudget = portfolio.equity_usd * effectiveRiskPct / 100;
    const riskLimitedNotional = riskBudget / effectiveStopRate;
    const maxExposure = portfolio.equity_usd * risk.max_total_exposure_pct / 100;
    const remainingExposure = Math.max(0, maxExposure - portfolio.exposure_usd);
    const positionCap = Number.isFinite(Number(risk.max_position_notional_usd)) && Number(risk.max_position_notional_usd) > 0
      ? Number(risk.max_position_notional_usd) : PAPER_AUTOMATION_PROFILE.max_position_notional_usd;
    const notional = Math.min(riskLimitedNotional, remainingExposure, positionCap);
    if (!Number.isFinite(notional) || notional < 2) return { ok: false, reason: "risk_or_exposure_budget_too_small" };
    const quantity = notional / entryPrice;
    const entryFee = notional * feeRate;
    const trade = {
      symbol: market.symbol, status: "OPEN", entry_price: entryPrice, quantity, notional_usd: notional,
      stop_loss: entryPrice * (1 - risk.stop_loss_pct / 100),
      take_profit: entryPrice * (1 + dynamicTarget.target_pct / 100),
      fees_usd: entryFee, pnl_usd: null, opened_at_ms: nowMs,
      metadata_json: JSON.stringify({
        strategy_version: "cloud-paper-v1", timeframe: "1h", confirmation_timeframe: "6h",
        market_data_provider: market.market_data_provider || "coinbase_exchange",
        score: market.primary.score, regime_1h: market.primary.regime, regime_6h: market.higher.regime,
        spread_bps: assessment.spread_bps, round_trip_cost_bps: roundTripCostBps,
        dynamic_take_profit_pct: dynamicTarget.target_pct,
        dynamic_take_profit_bps: dynamicTarget.target_bps,
        estimated_net_edge_bps: dynamicTarget.estimated_net_edge_bps,
        fee_bps_per_side: risk.fee_bps_per_side, slippage_bps: risk.slippage_bps,
        configured_risk_per_trade_pct: risk.risk_per_trade_pct,
        adaptive_risk_multiplier: adaptiveRisk.multiplier,
        effective_risk_per_trade_pct: effectiveRiskPct,
        trailing_stop_policy: "cost_aware_ratchet_v1",
        high_water_bid: entryPrice,
        entry_quote_bid: market.bid,
        entry_quote_ask: market.ask,
        entry_quote_mid: (market.bid + market.ask) / 2,
        entry_quote_received_at_ms: market.quote_received_at_ms ?? null,
        entry_ticker_time: market.ticker_time ?? null,
        entry_order_book_retrieved_at_ms: market.book_retrieved_at_ms ?? null,
        entry_bid_depth_quote: market.bid_depth_quote ?? null,
        entry_ask_depth_quote: market.ask_depth_quote ?? null,
        entry_fill_price: entryPrice,
        entry_slippage_bps: risk.slippage_bps,
        entry_fee_bps_per_side: risk.fee_bps_per_side,
        execution: "simulated_market_buy_at_ask_plus_slippage"
      })
    };
    let id;
    try {
      const inserted = this.sql.exec(
        "INSERT INTO trades(symbol,status,entry_price,quantity,notional_usd,stop_loss,take_profit,fees_usd,pnl_usd,opened_at_ms,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?) RETURNING id",
        trade.symbol, trade.status, trade.entry_price, trade.quantity, trade.notional_usd,
        trade.stop_loss, trade.take_profit, trade.fees_usd, trade.pnl_usd, trade.opened_at_ms, trade.metadata_json
      ).toArray();
      id = inserted[0]?.id;
      if (!Number.isSafeInteger(Number(id)) || Number(id) < 1) {
        return { ok: false, reason: "ledger_insert_id_unavailable" };
      }
    } catch {
      return { ok: false, reason: "ledger_insert_failed_or_duplicate_open_trade" };
    }
    this.logEvent("paper_entry", "Automatic paper position opened", {
      trade_id: id, symbol: trade.symbol, notional_usd: notional,
      adaptive_risk_multiplier: adaptiveRisk.multiplier,
      effective_risk_per_trade_pct: effectiveRiskPct
    });
    return { ok: true, trade: { ...trade, id } };
  }

  riskProtectionStatus(portfolio, risk, nowMs) {
    const recentClosed = this.sql.exec(
      "SELECT pnl_usd,closed_at_ms FROM trades WHERE status='CLOSED' ORDER BY closed_at_ms DESC,id DESC LIMIT 3"
    ).toArray();
    const lossCooldown = assessLossCooldown(recentClosed, nowMs);
    const adaptiveRisk = assessAdaptiveRisk({
      drawdownPct: portfolio.drawdown_pct_from_peak,
      lossStreak: lossCooldown.lossStreak
    });
    const blockReasons = [];
    if (lossCooldown.blocked) blockReasons.push(lossCooldown.reason);
    if (!adaptiveRisk.allowed) blockReasons.push(adaptiveRisk.reason);

    const initial = Number(portfolio.initial_capital_usd);
    const softFraction = Number.isFinite(risk.soft_loss_guard_fraction)
      ? Math.min(1, Math.max(0.5, risk.soft_loss_guard_fraction)) : 0.75;
    const dailyLimit = initial * risk.max_daily_loss_pct / 100;
    const weeklyLimit = initial * risk.max_weekly_loss_pct / 100;
    if (Number.isFinite(portfolio.daily_equity_pnl_usd)) {
      if (portfolio.daily_equity_pnl_usd <= -(dailyLimit * softFraction)) {
        blockReasons.push("daily_soft_loss_lock");
      }
      const profitLock = initial * risk.daily_profit_lock_pct / 100;
      if (Number.isFinite(profitLock) && profitLock > 0 &&
          portfolio.daily_equity_pnl_usd >= profitLock) {
        blockReasons.push("daily_profit_lock");
      }
    } else {
      blockReasons.push("daily_risk_baseline_unavailable");
    }
    if (Number.isFinite(portfolio.weekly_equity_pnl_usd)) {
      if (portfolio.weekly_equity_pnl_usd <= -(weeklyLimit * softFraction)) {
        blockReasons.push("weekly_soft_loss_lock");
      }
    } else {
      blockReasons.push("weekly_risk_baseline_unavailable");
    }
    const multiplier = adaptiveRisk.allowed ? adaptiveRisk.multiplier : 0;
    return {
      mode: "paper_only",
      new_entries_paused: blockReasons.length > 0,
      block_reasons: [...new Set(blockReasons)],
      base_risk_per_trade_pct: risk.risk_per_trade_pct,
      adaptive_risk_multiplier: multiplier,
      effective_risk_per_trade_pct: Number((risk.risk_per_trade_pct * multiplier).toFixed(4)),
      drawdown_pct_from_peak: portfolio.drawdown_pct_from_peak,
      consecutive_loss_streak: lossCooldown.lossStreak,
      loss_cooldown_active: lossCooldown.blocked,
      loss_cooldown_remaining_ms: lossCooldown.remainingMs,
      trailing_stop: {
        enabled: true,
        activation: "after high-water exceeds estimated round-trip costs + trail distance + 0.2% net buffer",
        distance: "cost-aware; at least 0.9% below high-water bid",
        ratchet_only: true
      },
      daily_equity_pnl_usd: portfolio.daily_equity_pnl_usd,
      weekly_equity_pnl_usd: portfolio.weekly_equity_pnl_usd,
      daily_risk_baseline_usd: portfolio.daily_risk_baseline_usd,
      weekly_risk_baseline_usd: portfolio.weekly_risk_baseline_usd,
      daily_risk_baseline_initialized: portfolio.daily_risk_baseline_initialized === true,
      weekly_risk_baseline_initialized: portfolio.weekly_risk_baseline_initialized === true,
      soft_daily_loss_limit_usd: Number.isFinite(dailyLimit) ? dailyLimit * softFraction : null,
      soft_weekly_loss_limit_usd: Number.isFinite(weeklyLimit) ? weeklyLimit * softFraction : null,
      daily_hard_loss_limit_usd: Number.isFinite(dailyLimit) ? dailyLimit : null,
      weekly_hard_loss_limit_usd: Number.isFinite(weeklyLimit) ? weeklyLimit : null,
      daily_profit_lock_usd: Number.isFinite(initial) ? initial * risk.daily_profit_lock_pct / 100 : null
    };
  }

  automationStatus() {
    const settings = this.getState("settings");
    const runtime = this.getState("runtime") || {};
    const nowMs = Date.now();
    const lastScanAtMs = Number(runtime.last_scan_at_ms);
    const lastScanAgeMs = Number.isFinite(lastScanAtMs) && lastScanAtMs > 0
      ? Math.max(0, nowMs - lastScanAtMs) : null;
    const nextAlarmAtMs = runtime.next_alarm_at_ms == null ? null : Number(runtime.next_alarm_at_ms);
    const dayStart = new Date(nowMs);
    dayStart.setUTCHours(0, 0, 0, 0);
    const cyclesCompleted = countCompletedPaperCyclesInWindow(
      this.sql, dayStart.getTime(), dayStart.getTime() + 24 * 60 * 60 * 1000
    );
    const cycleAllowance = getDailyCycleAllowance(cyclesCompleted, PAPER_AUTOMATION_PROFILE.max_cycles_per_day);
    const nextAlarmInMs = nextAlarmAtMs !== null && Number.isFinite(nextAlarmAtMs)
      ? Math.max(0, nextAlarmAtMs - nowMs) : null;
    const scheduler = deriveSchedulerStatus({
      lastScheduledAlarmAtMs: runtime.last_scheduled_alarm_at_ms,
      lastScheduledScanStatus: runtime.last_scheduled_scan_status,
      nowMs,
      staleAfterMs: SCAN_INTERVAL_MS * 3
    });
    return {
      enabled: !!settings.auto_paper_enabled,
      halted: !!settings.halted,
      halt_reason: settings.halt_reason || null,
      capital_setup_required: !!settings.capital_setup_required,
      capital_setup_required_reason: settings.capital_setup_required_reason || null,
      continuous_monitoring: true,
      automatic_watchdog_recovery: true,
      daily_cycle_limit: cycleAllowance.limit,
      daily_cycles_used: cycleAllowance.used,
      daily_cycles_basis: "completed_buy_sell_round_trips_by_sell_close_time_utc",
      daily_cycles_remaining: cycleAllowance.remaining,
      schedule_minutes: SCAN_INTERVAL_MS / 60000,
      schedule_seconds: SCAN_INTERVAL_MS / 1000,
      book_refresh_seconds: BOOK_REFRESH_INTERVAL_MS / 1000,
      last_book_refresh_at_ms: Number(runtime.last_book_refresh_at_ms) > 0
        ? Number(runtime.last_book_refresh_at_ms) : null,
      last_book_refresh_age_ms: Number(runtime.last_book_refresh_at_ms) > 0
        ? Math.max(0, nowMs - Number(runtime.last_book_refresh_at_ms)) : null,
      last_book_refresh_status: runtime.last_book_refresh_status || "not_started",
      last_book_refresh_success_count: Number(runtime.last_book_refresh_success_count) || 0,
      last_book_refresh_failed_count: Number(runtime.last_book_refresh_failed_count) || 0,
      last_book_refresh_skipped_count: Number(runtime.last_book_refresh_skipped_count) || 0,
      scanner_status: scheduler.status,
      last_scan_age_ms: lastScanAgeMs,
      last_scheduled_alarm_age_ms: scheduler.ageMs,
      last_scheduled_scan_status: runtime.last_scheduled_scan_status || "not_run",
      last_scheduled_scan_error: runtime.last_scheduled_scan_error
        ? String(runtime.last_scheduled_scan_error).slice(0, 180) : null,
      last_scan_error: runtime.last_scan_error ? String(runtime.last_scan_error).slice(0, 180) : null,
      next_alarm_at_ms: Number.isFinite(nextAlarmAtMs) ? nextAlarmAtMs : null,
      next_alarm_in_ms: nextAlarmInMs,
      live_order_reconciliation: {
        status: runtime.last_live_reconcile_failed > 0 ? "partial"
          : runtime.last_live_reconcile_at_ms ? "completed" : "not_run",
        last_at_ms: Number.isFinite(Number(runtime.last_live_reconcile_at_ms)) ? Number(runtime.last_live_reconcile_at_ms) : null,
        checked: Number(runtime.last_live_reconcile_checked) || 0,
        failed: Number(runtime.last_live_reconcile_failed) || 0,
        scope: "read_only_active_coinbase_orders_and_actual_fills"
      },
      runtime,
      engine: "durable_object_alarm",
      live_trading_enabled: false,
      mode: "paper_only"
    };
  }

  dashboard() {
    const settings = this.getState("settings");
    const runtime = this.getState("runtime") || {};
    const markets = this.getMarkets();
    const nowMs = Date.now();
    const currentMarketFeed = assessMarketUniverse(
      markets, PRODUCTS.map((product) => product.symbol), nowMs,
      MAX_QUOTE_AGE_MS, MAX_ORDER_BOOK_AGE_MS
    );
    const lastScheduledScanAtMs = Number(runtime.last_scheduled_scan_at_ms);
    const lastScheduledScanAgeMs = Number.isFinite(lastScheduledScanAtMs) && lastScheduledScanAtMs > 0
      ? Math.max(0, nowMs - lastScheduledScanAtMs) : null;
    const marketFeedFreshness = classifyMarketFeedFreshness({
      currentFeedHealthy: currentMarketFeed.healthy,
      lastScheduledScanStatus: runtime.last_scheduled_scan_status || "not_run",
      lastScheduledHealthyMarketCount: runtime.last_scheduled_scan_healthy_market_count,
      lastScheduledExpectedMarketCount: runtime.last_scheduled_scan_expected_market_count || PRODUCTS.length,
      lastScheduledScanAgeMs,
      staleAfterMs: SCAN_INTERVAL_MS * 3
    });
    const currentMarketStatus = currentMarketFeed.healthy ? "healthy"
      : currentMarketFeed.healthy_market_count > 0 ? "partial" : "unavailable";
    const currentMarketFeedDiagnostics = {
      ...currentMarketFeed,
      status: currentMarketStatus,
      freshness_state: marketFeedFreshness.state,
      freshness_reason: marketFeedFreshness.reason,
      checked_at_ms: nowMs
    };
    const trades = this.getTrades(30);
    const openPositions = this.getOpenTrades();
    const marks = this.buildPositionLockedBidMarks(markets, nowMs);
    const portfolio = this.portfolio(marks, { ...DEFAULT_RISK, ...(settings.risk || {}) }, nowMs);
    return {
      mode: "paper_only", live_trading_enabled: false,
      settings: {
        auto_paper_enabled: !!settings.auto_paper_enabled, halted: !!settings.halted,
        risk: { ...DEFAULT_RISK, ...(settings.risk || {}) }, paper_initial_capital_usd: settings.initial_capital_usd
      },
      automation: this.automationStatus(),
      current_market_feed: currentMarketFeedDiagnostics,
      market_context: assessCrossMarketContext(markets, nowMs),
      portfolio, markets, trades, open_positions: openPositions,
      risk_protection: this.riskProtectionStatus(portfolio, { ...DEFAULT_RISK, ...(settings.risk || {}) }, nowMs),
      runtime, analytics: this.tradeAnalytics(), research_history: this.researchHistorySummary(),
      recent_events: this.sql.exec("SELECT * FROM events ORDER BY id DESC LIMIT 20").toArray()
    };
  }
}
