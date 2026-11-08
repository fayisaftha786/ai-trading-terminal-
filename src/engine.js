import { DurableObject } from "cloudflare:workers";
import { PRODUCTS, fetchProductSnapshot } from "./coinbase.js";
import { analyzeTimeframe, assessCandidate, buildFreshBidMarks, resolveRiskBaseline } from "./strategy.js";
import { buildResearchHistorySummary, countMissingArchiveBars, selectNewClosedCandles } from "./research.js";
import { runStrategyTournament, runWalkForwardResearch } from "./strategy-tournament.js";

const SCAN_INTERVAL_MS = 15 * 60 * 1000;
const MAX_QUOTE_AGE_MS = 120000;
const DEFAULT_RISK = {
  risk_per_trade_pct: 0.25, max_daily_loss_pct: 1.5, max_weekly_loss_pct: 4,
  max_total_exposure_pct: 20, max_open_positions: 3, stop_loss_pct: 1,
  take_profit_pct: 3, fee_bps_per_side: 15, slippage_bps: 10,
  max_total_drawdown_pct: 5
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
      if (request.method === "GET" && url.pathname === "/api/health") {
        return jsonResponse({
          status: "ok", mode: "paper_only", engine: "cloudflare_durable_object_sqlite",
          schedule_minutes: 15, live_trading_enabled: false, binance_testnet_enabled: false
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
        const quoteTime = Date.parse(market?.ticker_time || "");
        if (!Number.isFinite(quoteTime) || Date.now() - quoteTime < -5000 || Date.now() - quoteTime > MAX_QUOTE_AGE_MS ||
            !Number.isFinite(market?.bid) || market.bid <= 0) {
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
    const priorRuntime = this.getState("runtime") || {};
    const cycleKey = String(priorRuntime.next_alarm_at_ms || Math.floor(Date.now() / SCAN_INTERVAL_MS) * SCAN_INTERVAL_MS);
    try {
      await this.runCycle("scheduled", cycleKey);
    } catch (error) {
      const runtime = this.getState("runtime") || {};
      runtime.last_scan_status = "error";
      runtime.last_scan_error = String(error?.message || error).slice(0, 180);
      runtime.last_scan_at_ms = Date.now();
      this.setState("runtime", runtime);
      this.logEvent("scheduled_scan_error", "Scheduled market scan failed", { error: runtime.last_scan_error });
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
        const snapshot = await fetchProductSnapshot(product, Date.now());
        candleArchives.push({
          product: product.product,
          one_hour: snapshot.one_hour_audit,
          six_hour: snapshot.six_hour_audit,
          received_at_ms: Date.now()
        });
        const primary = analyzeTimeframe(snapshot.one_hour_audit);
        const higher = analyzeTimeframe(snapshot.six_hour_audit);
        // Store compact evidence only; never include hundreds of raw candles in each dashboard payload.
        const market = {
          symbol: snapshot.symbol,
          product: snapshot.product,
          status: "live",
          fetched_at_ms: snapshot.fetched_at_ms,
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
            missing_intervals: snapshot.one_hour_audit.missing_intervals
          },
          six_hour_audit_summary: {
            ok: snapshot.six_hour_audit.ok,
            issues: snapshot.six_hour_audit.issues,
            valid_closed_bars: snapshot.six_hour_audit.valid_closed_bars,
            missing_intervals: snapshot.six_hour_audit.missing_intervals
          },
          primary,
          higher,
          signal: primary.signal,
          score: primary.score,
          regime_1h: primary.regime,
          regime_6h: higher.regime
        };
        markets.push(market);
      } catch (error) {
        candleArchives.push({ product: product.product, provider_error: true, error: String(error?.message || error).slice(0, 120), received_at_ms: Date.now() });
        const failed = { symbol: product.symbol, product: product.product, status: "error", error: String(error?.message || error).slice(0, 180), fetched_at_ms: Date.now() };
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
      if (market.status === "live") {
        market.entry_gate = assessCandidate({
          market,
          primary: market.primary || {},
          higher: market.higher || {},
          nowMs: Date.now(),
          costs: { feeBpsPerSide: risk.fee_bps_per_side, slippageBps: risk.slippage_bps }
        });
      } else {
        market.entry_gate = { eligible: false, reason: "market_data_unavailable" };
      }
      this.saveMarket(market, market.status === "live" ? "live" : "error");
    }
    const markBySymbol = buildFreshBidMarks(markets, Date.now(), MAX_QUOTE_AGE_MS);

    const exits = this.monitorExits(markBySymbol, risk, Date.now());
    const portfolio = this.portfolio(markBySymbol, risk, Date.now());
    const entryResults = [];
    let entryStatus = "disabled";
    if (state.auto_paper_enabled && !state.halted) {
      // Fail closed for the complete configured market universe: a partial
      // Coinbase outage must not silently permit new entries on only some symbols.
      const unavailableMarkets = markets.filter((market) => market.status !== "live");
      if (markets.length !== PRODUCTS.length || unavailableMarkets.length > 0) {
        entryStatus = "blocked";
        entryResults.push({
          reason: "market_universe_data_incomplete",
          unavailable_symbols: unavailableMarkets.map((market) => market.symbol)
        });
      } else {
        const reasons = this.entryBlockReasons(portfolio, risk, Date.now());
        if (reasons.length) {
          entryStatus = "blocked";
          entryResults.push({ reason: reasons.join(",") });
        } else {
          const candidates = [];
        for (const market of markets) {
          if (market.status !== "live") continue;
          const assessment = market.entry_gate || assessCandidate({
            market, primary: market.primary || {}, higher: market.higher || {},
            nowMs: Date.now(), costs: { feeBpsPerSide: risk.fee_bps_per_side, slippageBps: risk.slippage_bps }
          });
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
    const priorRuntime = this.getState("runtime") || {};
    const runtime = {
      next_alarm_at_ms: priorRuntime.next_alarm_at_ms ?? null,
      last_scan_at_ms: Date.now(),
      last_scan_status: markets.every((market) => market.status === "live") ? "completed"
        : markets.some((market) => market.status === "live") ? "partial" : "unavailable",
      last_scan_error: markets.every((market) => market.status === "live") ? null
        : markets.map((market) => market.status === "live" ? null : market.symbol + ": " + (market.error || "provider unavailable"))
          .filter(Boolean).join("; ").slice(0, 180),
      source, schedule_minutes: SCAN_INTERVAL_MS / 60000, last_entry_status: entryStatus,
      last_entry_results: entryResults.slice(0, 10)
    };
    this.setState("runtime", runtime);
    this.logEvent("market_scan", "Market scan cycle completed", {
      source, cycle_key: cycleKey, successful_markets: markets.filter((market) => market.status === "live").length,
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
      let reference = null;
      let reason = null;
      if (bid <= trade.stop_loss) { reference = bid; reason = "stop_loss"; }
      else if (bid >= trade.take_profit) { reference = trade.take_profit; reason = "take_profit"; }
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
    return reasons;
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
    const entryPrice = market.ask * (1 + risk.slippage_bps / 10000);
    const feeRate = risk.fee_bps_per_side / 10000;
    const roundTripCostRate = (2 * (risk.fee_bps_per_side + risk.slippage_bps) + assessment.spread_bps) / 10000;
    const effectiveStopRate = risk.stop_loss_pct / 100 + roundTripCostRate;
    const riskBudget = portfolio.equity_usd * risk.risk_per_trade_pct / 100;
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
    this.logEvent("paper_entry", "Automatic paper position opened", { trade_id: id, symbol: trade.symbol, notional_usd: notional });
    return { ok: true, trade: { ...trade, id } };
  }

  automationStatus() {
    const settings = this.getState("settings");
    const runtime = this.getState("runtime") || {};
    const nowMs = Date.now();
    const lastScanAtMs = Number(runtime.last_scan_at_ms);
    const lastScanAgeMs = Number.isFinite(lastScanAtMs) && lastScanAtMs > 0
      ? Math.max(0, nowMs - lastScanAtMs) : null;
    const nextAlarmAtMs = Number(runtime.next_alarm_at_ms);
    const nextAlarmInMs = Number.isFinite(nextAlarmAtMs)
      ? Math.max(0, nextAlarmAtMs - nowMs) : null;
    const status = runtime.last_scan_status;
    const scannerStatus = status === "error" ? "error"
      : lastScanAgeMs === null ? "starting"
        : lastScanAgeMs > (SCAN_INTERVAL_MS * 3) ? "stale"
          : status === "partial" ? "partial"
            : status === "unavailable" ? "unavailable"
              : status === "completed" ? "healthy" : "unknown";
    return {
      enabled: !!settings.auto_paper_enabled,
      halted: !!settings.halted,
      schedule_minutes: SCAN_INTERVAL_MS / 60000,
      scanner_status: scannerStatus,
      last_scan_age_ms: lastScanAgeMs,
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
      runtime, analytics: this.tradeAnalytics(), research_history: this.researchHistorySummary(),
      recent_events: this.sql.exec("SELECT * FROM events ORDER BY id DESC LIMIT 20").toArray()
    };
  }
}
