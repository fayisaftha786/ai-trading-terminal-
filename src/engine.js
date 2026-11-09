import { DurableObject } from "cloudflare:workers";
import { PRODUCTS, fetchProductSnapshot } from "./coinbase.js";
import { analyzeTimeframe, assessCandidate, buildFreshBidMarks, evaluateResearchCandidates, isFreshBidQuote, resolveRiskBaseline } from "./strategy.js";
import { assessMarketUniverse, advanceUnhealthyScanStreak, assessAdaptiveRisk, assessLossCooldown, deriveSchedulerStatus, shouldHaltPaperAutomation, updateTrailingStop } from "./automation-guards.js";
import { buildResearchHistorySummary, countMissingArchiveBars, selectNewClosedCandles } from "./research.js";
import { runStrategyTournament, runWalkForwardResearch } from "./strategy-tournament.js";

const SCAN_INTERVAL_MS = 15 * 60 * 1000;
const MAX_QUOTE_AGE_MS = 120000;
const DEFAULT_RISK = {
  risk_per_trade_pct: 0.25, max_daily_loss_pct: 1.5, max_weekly_loss_pct: 4,
  max_total_exposure_pct: 20, max_open_positions: 3, stop_loss_pct: 1,
  take_profit_pct: 3, fee_bps_per_side: 15, slippage_bps: 10,
  max_total_drawdown_pct: 5, daily_profit_lock_pct: 1, soft_loss_guard_fraction: 0.75
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store, private" }
  });
}

export class TradingEngine extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
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
      "CREATE TABLE IF NOT EXISTS research_history_state(product TEXT NOT NULL,timeframe_seconds INTEGER NOT NULL,bars_count INTEGER NOT NULL DEFAULT 0,first_candle_ms INTEGER,last_candle_ms INTEGER,cumulative_missing_intervals INTEGER NOT NULL DEFAULT 0,last_quality_check_at_ms INTEGER,last_ingested_at_ms INTEGER,last_quality_status TEXT NOT NULL DEFAULT 'not_started',PRIMARY KEY(product,timeframe_seconds))"
    ];
    // Durable Object SQL exec expects a single statement per call.
    for (const statement of schemaStatements) this.sql.exec(statement);
    this.sql.exec(
      "INSERT OR IGNORE INTO app_state(key,value_json) VALUES(?,?)",
      "settings",
      JSON.stringify({ initial_capital_usd: 100, risk: DEFAULT_RISK, auto_paper_enabled: false, halted: false, peak_equity_usd: 100 })
    );
    this.sql.exec(
      "INSERT OR IGNORE INTO app_state(key,value_json) VALUES(?,?)",
      "runtime",
      JSON.stringify({ last_scan_at_ms: null, last_scan_status: "not_started", last_scan_error: null })
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

  loadResearchCandleCache(product, timeframeSeconds) {
    return this.sql.exec(
      "SELECT candle_open_ms AS time,open,high,low,close,volume FROM research_candles " +
      "WHERE exchange='coinbase_exchange' AND product=? AND timeframe_seconds=? " +
      "ORDER BY candle_open_ms DESC LIMIT 300",
      product, timeframeSeconds
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
      const dueAt = Date.now() + 30000;
      const runtime = this.getState("runtime") || {};
      runtime.next_alarm_at_ms = dueAt;
      this.setState("runtime", runtime);
      await this.ctx.storage.setAlarm(dueAt);
    }
  }

  async fetch(request) {
    await this.ensureAlarm();
    const url = new URL(request.url);
    try {
      // Internal-only: reached through the Worker's direct Durable Object binding.
      // Persist a one-way source-IP hash, never the raw address.
      if (request.method === "POST" && url.pathname === "/internal/auth/login-attempts") {
        let body;
        try { body = await request.json(); } catch { return jsonResponse({ error: "invalid_request" }, 400); }
        const ipHash = typeof body?.ip_hash === "string" ? body.ip_hash : "";
        const action = body?.action;
        if (!/^[A-Za-z0-9_-]{40,64}$/.test(ipHash) ||
            (action !== "reserve" && action !== "clear")) {
          return jsonResponse({ error: "invalid_request" }, 400);
        }
        const nowMs = Date.now();
        const windowMs = 10 * 60 * 1000;
        const attemptLimit = 8;
        this.sql.exec("DELETE FROM auth_login_attempts WHERE attempted_at_ms < ?", nowMs - windowMs);
        if (action === "clear") {
          this.sql.exec("DELETE FROM auth_login_attempts WHERE ip_hash=?", ipHash);
          return jsonResponse({ cleared: true });
        }
        const attempts = Number(this.sql.exec(
          "SELECT COUNT(*) AS count FROM auth_login_attempts WHERE ip_hash=? AND attempted_at_ms>=?",
          ipHash, nowMs - windowMs
        ).toArray()[0]?.count || 0);
        if (attempts >= attemptLimit) {
          return jsonResponse({ allowed: false, error: "too_many_login_attempts" }, 429);
        }
        this.sql.exec(
          "INSERT INTO auth_login_attempts(ip_hash,attempted_at_ms) VALUES(?,?)",
          ipHash, nowMs
        );
        // Bound storage when attempts arrive from many different source IPs.
        this.sql.exec(
          "DELETE FROM auth_login_attempts WHERE id IN (" +
          "SELECT id FROM auth_login_attempts ORDER BY attempted_at_ms DESC,id DESC LIMIT -1 OFFSET 10000)"
        );
        return jsonResponse({ allowed: true, attempts_remaining: attemptLimit - attempts - 1 });
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
        const diagnostics = {
          last_scan_status: runtime.last_scan_status || "not_started",
          last_scan_age_ms: Number.isFinite(Number(runtime.last_scan_at_ms)) && Number(runtime.last_scan_at_ms) > 0
            ? Math.max(0, nowMs - Number(runtime.last_scan_at_ms)) : null,
          last_scan_error: runtime.last_scan_error ? String(runtime.last_scan_error).slice(0, 160) : null,
          last_scheduled_scan_error: runtime.last_scheduled_scan_error
            ? String(runtime.last_scheduled_scan_error).slice(0, 160) : null,
          healthy_market_count: Number(runtime.healthy_market_count) || 0,
          expected_market_count: Number(runtime.expected_market_count) || PRODUCTS.length,
          consecutive_unhealthy_scheduled_scans: Number(runtime.consecutive_unhealthy_scheduled_scans) || 0,
          issues: (Array.isArray(runtime.market_feed_issues) ? runtime.market_feed_issues : [])
            .slice(0, 6)
            .map((issue) => ({
              symbol: typeof issue?.symbol === "string" ? issue.symbol.slice(0, 24) : null,
              reason: typeof issue?.reason === "string" ? issue.reason.slice(0, 120) : "unknown"
            })),
          provider_failures: (Array.isArray(runtime.provider_failures) ? runtime.provider_failures : [])
            .slice(0, 3)
            .map((failure) => ({
              symbol: typeof failure?.symbol === "string" ? failure.symbol.slice(0, 24) : null,
              reason: typeof failure?.reason === "string" ? failure.reason.slice(0, 80) : "unknown"
            }))
        };
        return jsonResponse({
          status: "ok", mode: "paper_only", engine: "cloudflare_durable_object_sqlite",
          schedule_minutes: SCAN_INTERVAL_MS / 60000,
          live_trading_enabled: false, binance_testnet_enabled: false,
          scheduler: {
            status: scheduler.status,
            last_alarm_at_ms: lastAlarmAtMs,
            last_alarm_age_ms: scheduler.ageMs,
            last_scheduled_scan_status: scanStatus,
            last_scheduled_scan_error: diagnostics.last_scheduled_scan_error,
            last_healthy_scan_at_ms: lastHealthyAtMs,
            last_healthy_scan_age_ms: lastHealthyAtMs === null ? null : Math.max(0, nowMs - lastHealthyAtMs),
            next_alarm_at_ms: nextAlarmAtMs
          },
          scan_diagnostics: diagnostics
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
        return jsonResponse({ enabled: !!state.auto_paper_enabled, halted: !!state.halted, mode: "paper_only" });
      }
      if (request.method === "PUT" && url.pathname === "/api/automation/paper-trading") {
        const body = await request.json();
        if (typeof body.enabled !== "boolean") return jsonResponse({ error: "enabled_boolean_required" }, 400);
        const state = this.getState("settings");
        if (body.enabled && state.halted) return jsonResponse({ error: "paper_automation_halted_reset_required" }, 409);
        if (body.enabled) {
          const nowMs = Date.now();
          const runtime = this.getState("runtime") || {};
          const lastScanAtMs = Number(runtime.last_scan_at_ms);
          const scanAgeMs = Number.isFinite(lastScanAtMs) ? nowMs - lastScanAtMs : Number.POSITIVE_INFINITY;
          const lastScheduledScanAtMs = Number(runtime.last_healthy_scheduled_scan_at_ms);
          const scheduledScanAgeMs = Number.isFinite(lastScheduledScanAtMs)
            ? nowMs - lastScheduledScanAtMs : Number.POSITIVE_INFINITY;
          const marketFeed = assessMarketUniverse(
            this.getMarkets(), PRODUCTS.map((product) => product.symbol), nowMs, MAX_QUOTE_AGE_MS
          );
          if (runtime.last_scan_status !== "completed" || scanAgeMs < 0 ||
              scanAgeMs > (SCAN_INTERVAL_MS * 3) || !marketFeed.healthy ||
              runtime.last_scheduled_scan_status !== "completed" ||
              scheduledScanAgeMs < 0 || scheduledScanAgeMs > (SCAN_INTERVAL_MS * 3)) {
            return jsonResponse({
              error: "fresh_complete_scheduled_scan_required",
              scheduled_scan_status: runtime.last_scheduled_scan_status || "not_run",
              scheduled_scan_age_ms: Number.isFinite(scheduledScanAgeMs) ? scheduledScanAgeMs : null,
              healthy_market_count: marketFeed.healthy_market_count,
              expected_market_count: marketFeed.expected_market_count,
              issues: marketFeed.issues
            }, 409);
          }
        }
        state.auto_paper_enabled = body.enabled;
        this.setState("settings", state);
        this.logEvent("paper_automation_setting", body.enabled ? "Automatic paper entries enabled by owner" : "Automatic paper entries disabled by owner");
        return jsonResponse({ enabled: state.auto_paper_enabled, halted: state.halted, mode: "paper_only" });
      }
      if (request.method === "POST" && url.pathname === "/api/automation/kill-switch") {
        const state = this.getState("settings");
        state.auto_paper_enabled = false;
        state.halted = true;
        this.setState("settings", state);
        this.logEvent("emergency_stop", "Paper auto-entry halted; scheduled monitoring continues");
        return jsonResponse({ stopped: true, auto_paper_enabled: false, halted: true, exit_monitoring_continues: true });
      }
      if (request.method === "POST" && url.pathname === "/api/automation/reset") {
        if (this.getOpenTrades().length > 0) return jsonResponse({ error: "open_paper_positions_must_be_closed_before_reset" }, 409);
        const state = this.getState("settings");
        state.halted = false;
        state.auto_paper_enabled = false;
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
        const risk = { ...DEFAULT_RISK, ...(this.getState("settings")?.risk || {}) };
        const closed = this.closeTradeAt(trade, market.bid, risk, Date.now(), "manual_owner_close");
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

  async alarm() {
    const invokedAtMs = Date.now();
    const startingRuntime = this.getState("runtime") || {};
    const previousScheduledScanStatus = startingRuntime.last_scheduled_scan_status || "not_run";
    const previousScheduledScanError = startingRuntime.last_scheduled_scan_error || null;
    startingRuntime.last_scheduled_alarm_at_ms = invokedAtMs;
    startingRuntime.last_scheduled_scan_status = "running";
    startingRuntime.last_scheduled_scan_error = null;
    this.setState("runtime", startingRuntime);
    const priorRuntime = this.getState("runtime") || {};
    const cycleKey = String(priorRuntime.next_alarm_at_ms || Math.floor(invokedAtMs / SCAN_INTERVAL_MS) * SCAN_INTERVAL_MS);
    try {
      const result = await this.runCycle("scheduled", cycleKey);
      const runtime = this.getState("runtime") || {};
      runtime.last_scheduled_alarm_at_ms = invokedAtMs;
      if (!result?.skipped) {
        const feed = result?.market_feed;
        runtime.last_scheduled_scan_status = feed?.healthy === true ? "completed"
          : feed ? (Number(feed.healthy_market_count || 0) > 0 ? "partial" : "unavailable")
            : "error";
        runtime.last_scheduled_scan_error = feed?.healthy === true ? null
          : (feed?.issues || []).map((issue) => (issue.symbol || "universe") + ": " + issue.reason)
            .join("; ").slice(0, 180) || null;
      } else {
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
      runtime.last_scheduled_scan_error = String(error?.message || error).slice(0, 180);
      runtime.consecutive_unhealthy_scheduled_scans =
        Math.max(0, Number(runtime.consecutive_unhealthy_scheduled_scans) || 0) + 1;
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
        settings.auto_paper_enabled = false;
        settings.halted = true;
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
      const nextAt = Date.now() + SCAN_INTERVAL_MS;
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
        const snapshot = await fetchProductSnapshot(product, Date.now(), cachedCandles);
        candleArchives.push({
          product: product.product,
          one_hour: snapshot.one_hour_audit,
          six_hour: snapshot.six_hour_audit,
          received_at_ms: Date.now()
        });
        const primary = analyzeTimeframe(snapshot.one_hour_audit);
        const higher = analyzeTimeframe(snapshot.six_hour_audit);
        const strategyResearch = evaluateResearchCandidates(
          snapshot.one_hour_audit, snapshot.six_hour_audit, 6 * 60 * 60 * 1000
        );
        // Store compact evidence only; never include hundreds of raw candles in each dashboard payload.
        const market = {
          symbol: snapshot.symbol,
          product: snapshot.product,
          status: "live",
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
          signal: primary.signal,
          score: primary.score,
          regime_1h: primary.regime,
          regime_6h: higher.regime
        };
        markets.push(market);
      } catch (error) {
        candleArchives.push({ product: product.product, provider_error: true, error: String(error?.message || error).slice(0, 120), received_at_ms: Date.now() });
        const status = Number(error?.status);
        const errorCode = status === 429 ? "provider_rate_limited"
          : Number.isFinite(status) && status >= 500 ? "provider_server_error"
            : Number.isFinite(status) && status >= 400 ? "provider_http_error"
              : error?.name === "TimeoutError" || error?.name === "AbortError"
                ? "provider_timeout" : "provider_network_error";
        const failed = {
          symbol: product.symbol, product: product.product, status: "error",
          error_code: errorCode,
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
        for (const timeframeSeconds of [3600, 21600]) {
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
        [3600, archive.one_hour],
        [21600, archive.six_hour]
      ]) {
        try {
          const result = this.archiveClosedCandles(archive.product, timeframeSeconds, audit, checkedAt);
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

    // Read the latest owner settings after public fetches complete so a concurrent
    // disable action cannot be hidden by a stale pre-fetch automation setting.
    const state = this.getState("settings") || {};
    const risk = { ...DEFAULT_RISK, ...(state.risk || {}) };
    for (const market of markets) {
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
          costs: { feeBpsPerSide: risk.fee_bps_per_side, slippageBps: risk.slippage_bps }
        });
      }
      this.saveMarket(market, market.status === "live" ? "live" : "error");
    }
    const marketFeed = assessMarketUniverse(
      markets, PRODUCTS.map((product) => product.symbol), Date.now(), MAX_QUOTE_AGE_MS
    );
    const markBySymbol = buildFreshBidMarks(markets, Date.now(), MAX_QUOTE_AGE_MS);

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
      haltState.auto_paper_enabled = false;
      haltState.halted = true;
      this.setState("settings", haltState);
      Object.assign(state, haltState);
      this.logEvent("market_data_watchdog_halt", "Paper auto-entry halted by the market-data scheduler watchdog", {
        reason: watchdogDecision.reason,
        consecutive_unhealthy_scheduled_scans: consecutiveUnhealthyScans,
        last_healthy_scan_at_ms: previousHealthyScanAtMs
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
    const runtime = {
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
      healthy_market_count: marketFeed.healthy_market_count,
      expected_market_count: marketFeed.expected_market_count,
      consecutive_unhealthy_scheduled_scans: consecutiveUnhealthyScans,
      source, schedule_minutes: SCAN_INTERVAL_MS / 60000, last_entry_status: entryStatus,
      last_entry_results: entryResults.slice(0, 10),
      market_feed_issues: marketFeed.issues.slice(0, 12),
      provider_failures: markets.filter((market) => market.status === "error").map((market) => ({
        symbol: market.symbol,
        reason: market.error_code || "provider_unavailable"
      })).slice(0, 3)
    };
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
        symbol: market.symbol, status: market.status, signal: market.signal || "HOLD",
        score: market.score || 0, regime_1h: market.regime_1h || "UNKNOWN",
        regime_6h: market.regime_6h || "UNKNOWN", spread_bps: market.spread_bps ?? null,
        data_quality: market.data_quality || null, error: market.error || null
      })),
      paper_exits: exits.length, paper_entries: entryResults, entry_status: entryStatus,
      market_feed: marketFeed,
      portfolio: updatedPortfolio, live_trading_enabled: false, binance_testnet_enabled: false
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
    const retentionBars = timeframeSeconds === 3600 ? 4320 : timeframeSeconds === 21600 ? 1440 : 0;
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
      const candles1h = loadBars(3600, 1000);
      const candles6h = loadBars(21600, 1000);
      const options = {
        initialEquity,
        allocationPct: 0.1,
        feeBpsPerSide: risk.fee_bps_per_side,
        slippageBps: risk.slippage_bps
      };
      const exploratory = runStrategyTournament({
        candles1h, candles6h, options,
        startIndex: 100
      });
      const walkForward = runWalkForwardResearch({ candles1h, candles6h, options });
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
        exploratory: compactExploratory,
        walk_forward: compactWalkForward
      };
    });
    return {
      mode: "offline_research_only",
      generated_at_ms: Date.now(),
      no_trading_side_effects: true,
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

  getOpenTrades() {
    return this.sql.exec("SELECT * FROM trades WHERE status='OPEN' ORDER BY opened_at_ms ASC").toArray()
      .map((row) => ({ ...row, metadata: this.parseJson(row.metadata_json) }));
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
    const recentClosed = this.sql.exec(
      "SELECT pnl_usd FROM trades WHERE status='CLOSED' ORDER BY closed_at_ms DESC,id DESC LIMIT 1000"
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
      longest_loss_streak_in_latest_1000_closed: longestRecentLossStreak,
      loss_streak_scope: "latest 1000 closed trades",
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

  monitorExits(markBySymbol, risk, nowMs) {
    const closed = [];
    for (const trade of this.getOpenTrades()) {
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
        JSON.stringify({ ...trade.metadata, close_reason: reason, close_reference_price: reference }), trade.id
      );
      this.logEvent("paper_exit", "Paper position closed by " + reason, { trade_id: trade.id, symbol: trade.symbol, net_pnl_usd: netPnl });
      closed.push({ trade_id: trade.id, symbol: trade.symbol, reason, net_pnl_usd: netPnl });
    }
    return closed;
  }

  closeTradeAt(trade, bid, risk, nowMs, reason) {
    const exitPrice = bid * (1 - risk.slippage_bps / 10000);
    const exitFee = exitPrice * trade.quantity * risk.fee_bps_per_side / 10000;
    const netPnl = (exitPrice - trade.entry_price) * trade.quantity - trade.fees_usd - exitFee;
    const updated = this.sql.exec(
      "UPDATE trades SET status='CLOSED',closed_at_ms=?,exit_price=?,fees_usd=?,pnl_usd=?,metadata_json=? WHERE id=? AND status='OPEN' RETURNING id",
      nowMs, exitPrice, trade.fees_usd + exitFee, netPnl,
      JSON.stringify({ ...trade.metadata, close_reason: reason, close_reference_price: bid }), trade.id
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
    const dayBaseline = resolveRiskBaseline({
      periodKey: dayKey, storedPeriodKey: this.getState("risk_day_key"),
      storedBaseline: this.getState("risk_day_baseline"), equity, closedPnl: closedToday,
      unmarkedPositions: unmarked
    });
    if (dayBaseline.shouldPersist) {
      this.setState("risk_day_key", dayKey);
      this.setState("risk_day_baseline", dayBaseline.baseline);
    }
    const weekKey = new Date(weekStartMs).toISOString().slice(0, 10);
    const weekBaseline = resolveRiskBaseline({
      periodKey: weekKey, storedPeriodKey: this.getState("risk_week_key"),
      storedBaseline: this.getState("risk_week_baseline"), equity, closedPnl: closedThisWeek,
      unmarkedPositions: unmarked
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
      risk_period_timezone: "UTC", last_updated_at_ms: nowMs
    };
  }

  entryBlockReasons(portfolio, risk, nowMs) {
    const reasons = [];
    if (portfolio.unmarked_positions > 0) reasons.push("open_position_without_fresh_mark");
    if (portfolio.open_positions >= risk.max_open_positions) reasons.push("max_open_positions");
    const protection = this.riskProtectionStatus(portfolio, risk, nowMs);
    reasons.push(...protection.block_reasons);
    if (portfolio.drawdown_pct_from_peak >= risk.max_total_drawdown_pct) {
      reasons.push("max_total_drawdown");
      const state = this.getState("settings");
      state.auto_paper_enabled = false; state.halted = true; this.setState("settings", state);
      this.logEvent("drawdown_circuit_breaker", "Paper automation halted by total drawdown limit");
    }
    if (!Number.isFinite(portfolio.daily_equity_pnl_usd) || !Number.isFinite(portfolio.weekly_equity_pnl_usd)) {
      reasons.push("risk_period_baseline_unavailable");
    } else {
      if (portfolio.daily_equity_pnl_usd <= -(portfolio.initial_capital_usd * risk.max_daily_loss_pct / 100)) reasons.push("daily_loss_limit");
      if (portfolio.weekly_equity_pnl_usd <= -(portfolio.initial_capital_usd * risk.max_weekly_loss_pct / 100)) reasons.push("weekly_loss_limit");
    }
    const dayStart = new Date(nowMs); dayStart.setUTCHours(0, 0, 0, 0);
    const entriesToday = Number(this.sql.exec("SELECT COUNT(*) AS count FROM trades WHERE opened_at_ms>=?", dayStart.getTime()).toArray()[0]?.count || 0);
    if (entriesToday >= 3) reasons.push("daily_entry_cap");
    const maxExposure = portfolio.equity_usd * risk.max_total_exposure_pct / 100;
    if (portfolio.exposure_usd >= maxExposure) reasons.push("max_exposure");
    return [...new Set(reasons)];
  }

  openPaperTrade(candidate, portfolio, risk, nowMs) {
    const market = candidate.market;
    const assessment = candidate.assessment;
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
    const roundTripCostRate = (2 * (risk.fee_bps_per_side + risk.slippage_bps) + assessment.spread_bps) / 10000;
    const effectiveStopRate = risk.stop_loss_pct / 100 + roundTripCostRate;
    const effectiveRiskPct = risk.risk_per_trade_pct * adaptiveRisk.multiplier;
    const riskBudget = portfolio.equity_usd * effectiveRiskPct / 100;
    const riskLimitedNotional = riskBudget / effectiveStopRate;
    const maxExposure = portfolio.equity_usd * risk.max_total_exposure_pct / 100;
    const remainingExposure = Math.max(0, maxExposure - portfolio.exposure_usd);
    const notional = Math.min(riskLimitedNotional, remainingExposure);
    if (!Number.isFinite(notional) || notional < 2) return { ok: false, reason: "risk_or_exposure_budget_too_small" };
    const quantity = notional / entryPrice;
    const entryFee = notional * feeRate;
    const trade = {
      symbol: market.symbol, status: "OPEN", entry_price: entryPrice, quantity, notional_usd: notional,
      stop_loss: entryPrice * (1 - risk.stop_loss_pct / 100),
      take_profit: entryPrice * (1 + risk.take_profit_pct / 100),
      fees_usd: entryFee, pnl_usd: null, opened_at_ms: nowMs,
      metadata_json: JSON.stringify({
        strategy_version: "cloud-paper-v1", timeframe: "1h", confirmation_timeframe: "6h",
        score: market.primary.score, regime_1h: market.primary.regime, regime_6h: market.higher.regime,
        spread_bps: assessment.spread_bps, round_trip_cost_bps: assessment.round_trip_cost_bps,
        fee_bps_per_side: risk.fee_bps_per_side, slippage_bps: risk.slippage_bps,
        configured_risk_per_trade_pct: risk.risk_per_trade_pct,
        adaptive_risk_multiplier: adaptiveRisk.multiplier,
        effective_risk_per_trade_pct: effectiveRiskPct,
        trailing_stop_policy: "cost_aware_ratchet_v1",
        high_water_bid: entryPrice,
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
        activation: "cost-aware; at least 2% above entry",
        distance: "cost-aware; at least 0.9% below high-water bid",
        ratchet_only: true
      },
      soft_daily_loss_limit_usd: Number.isFinite(dailyLimit) ? dailyLimit * softFraction : null,
      soft_weekly_loss_limit_usd: Number.isFinite(weeklyLimit) ? weeklyLimit * softFraction : null,
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
      schedule_minutes: SCAN_INTERVAL_MS / 60000,
      scanner_status: scheduler.status,
      last_scan_age_ms: lastScanAgeMs,
      last_scheduled_alarm_age_ms: scheduler.ageMs,
      last_scheduled_scan_status: runtime.last_scheduled_scan_status || "not_run",
      last_scheduled_scan_error: runtime.last_scheduled_scan_error
        ? String(runtime.last_scheduled_scan_error).slice(0, 180) : null,
      last_scan_error: runtime.last_scan_error ? String(runtime.last_scan_error).slice(0, 180) : null,
      next_alarm_at_ms: Number.isFinite(nextAlarmAtMs) ? nextAlarmAtMs : null,
      next_alarm_in_ms: nextAlarmInMs,
      runtime,
      engine: "durable_object_alarm",
      mode: "paper_only"
    };
  }

  dashboard() {
    const settings = this.getState("settings");
    const runtime = this.getState("runtime") || {};
    const markets = this.getMarkets();
    const trades = this.getTrades(30);
    const openPositions = this.getOpenTrades();
    const marks = buildFreshBidMarks(markets, Date.now(), MAX_QUOTE_AGE_MS);
    const portfolio = this.portfolio(marks, { ...DEFAULT_RISK, ...(settings.risk || {}) }, Date.now());
    return {
      mode: "paper_only", live_trading_enabled: false, binance_testnet_enabled: false,
      settings: {
        auto_paper_enabled: !!settings.auto_paper_enabled, halted: !!settings.halted,
        risk: { ...DEFAULT_RISK, ...(settings.risk || {}) }, paper_initial_capital_usd: settings.initial_capital_usd
      },
      automation: this.automationStatus(), portfolio, markets, trades, open_positions: openPositions,
      risk_protection: this.riskProtectionStatus(portfolio, { ...DEFAULT_RISK, ...(settings.risk || {}) }, Date.now()),
      runtime, analytics: this.tradeAnalytics(), research_history: this.researchHistorySummary(),
      recent_events: this.sql.exec("SELECT * FROM events ORDER BY id DESC LIMIT 20").toArray()
    };
  }
}
