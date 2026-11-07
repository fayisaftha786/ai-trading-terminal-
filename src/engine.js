import { DurableObject } from "cloudflare:workers";
import { PRODUCTS, fetchProductSnapshot } from "./coinbase.js";
import { analyzeTimeframe, assessCandidate } from "./strategy.js";

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
      "CREATE TABLE IF NOT EXISTS equity_snapshots(id INTEGER PRIMARY KEY AUTOINCREMENT,at_ms INTEGER NOT NULL,equity_usd REAL NOT NULL,realized_pnl_usd REAL NOT NULL,unrealized_pnl_usd REAL NOT NULL,open_positions INTEGER NOT NULL,drawdown_pct REAL NOT NULL)"
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
        return jsonResponse({ trades: this.getTrades(100), open_positions: this.getOpenTrades() });
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
    for (const product of PRODUCTS) {
      try {
        const snapshot = await fetchProductSnapshot(product, Date.now());
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
          book_timestamp_ms: snapshot.book_timestamp_ms,
          book_age_ms: snapshot.book_age_ms,
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
        this.saveMarket(market, "live");
        markets.push(market);
      } catch (error) {
        const failed = { symbol: product.symbol, product: product.product, status: "error", error: String(error?.message || error).slice(0, 180), fetched_at_ms: Date.now() };
        this.saveMarket(failed, "error");
        markets.push(failed);
      }
    }

    const state = this.getState("settings");
    const risk = { ...DEFAULT_RISK, ...(state.risk || {}) };
    const markBySymbol = new Map(markets
      .filter((market) => market.status === "live" && Number.isFinite(market.bid) && market.bid > 0 &&
        Number.isFinite(Date.parse(market.ticker_time || "")) && Date.now() - Date.parse(market.ticker_time) >= -5000 && Date.now() - Date.parse(market.ticker_time) <= MAX_QUOTE_AGE_MS)
      .map((market) => [market.symbol, market.bid]));

    const exits = this.monitorExits(markBySymbol, risk, Date.now());
    const portfolio = this.portfolio(markBySymbol, risk, Date.now());
    const entryResults = [];
    let entryStatus = "disabled";
    if (state.auto_paper_enabled && !state.halted) {
      const reasons = this.entryBlockReasons(portfolio, risk, Date.now());
      if (reasons.length) {
        entryStatus = "blocked";
        entryResults.push({ reason: reasons.join(",") });
      } else {
        const candidates = [];
        for (const market of markets) {
          if (market.status !== "live") continue;
          const assessment = assessCandidate({
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
      last_scan_status: markets.some((market) => market.status === "live") ? "completed" : "unavailable",
      last_scan_error: markets.every((market) => market.status !== "live") ? "All public market providers were unavailable" : null,
      source, schedule_minutes: SCAN_INTERVAL_MS / 60000, last_entry_status: entryStatus
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

  getTrades(limit = 100) {
    return this.sql.exec("SELECT * FROM trades ORDER BY id DESC LIMIT ?", Math.max(1, Math.min(100, limit))).toArray()
      .map((row) => ({ ...row, metadata: this.parseJson(row.metadata_json) }));
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
    const peak = Math.max(initial, Number(settings.peak_equity_usd || initial), equity);
    if (peak > Number(settings.peak_equity_usd || initial)) {
      settings.peak_equity_usd = peak;
      this.setState("settings", settings);
    }
    const drawdown = peak > 0 ? Math.max(0, ((peak - equity) / peak) * 100) : 0;
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
    let dayBaseline = this.getState("risk_day_baseline");
    if (this.getState("risk_day_key") !== dayKey || !Number.isFinite(Number(dayBaseline))) {
      dayBaseline = equity - closedToday;
      this.setState("risk_day_key", dayKey);
      this.setState("risk_day_baseline", dayBaseline);
    }
    const weekKey = new Date(weekStartMs).toISOString().slice(0, 10);
    let weekBaseline = this.getState("risk_week_baseline");
    if (this.getState("risk_week_key") !== weekKey || !Number.isFinite(Number(weekBaseline))) {
      weekBaseline = equity - closedThisWeek;
      this.setState("risk_week_key", weekKey);
      this.setState("risk_week_baseline", weekBaseline);
    }
    return {
      mode: "paper_only", initial_capital_usd: initial, realized_pnl_usd: realized, unrealized_pnl_usd: unrealized,
      equity_usd: equity, exposure_usd: exposure, open_positions: openTrades.length, unmarked_positions: unmarked,
      peak_equity_usd: peak, drawdown_pct_from_peak: drawdown,
      daily_equity_pnl_usd: equity - Number(dayBaseline), weekly_equity_pnl_usd: equity - Number(weekBaseline),
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
    if (portfolio.daily_equity_pnl_usd <= -(portfolio.initial_capital_usd * risk.max_daily_loss_pct / 100)) reasons.push("daily_loss_limit");
    if (portfolio.weekly_equity_pnl_usd <= -(portfolio.initial_capital_usd * risk.max_weekly_loss_pct / 100)) reasons.push("weekly_loss_limit");
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
    return { enabled: !!settings.auto_paper_enabled, halted: !!settings.halted, schedule_minutes: 15, runtime, engine: "durable_object_alarm", mode: "paper_only" };
  }

  dashboard() {
    const settings = this.getState("settings");
    const runtime = this.getState("runtime") || {};
    const markets = this.getMarkets();
    const trades = this.getTrades(30);
    const openPositions = this.getOpenTrades();
    const marks = new Map(markets.filter((market) => market.status === "live" && Number.isFinite(market.bid)).map((market) => [market.symbol, market.bid]));
    const portfolio = this.portfolio(marks, { ...DEFAULT_RISK, ...(settings.risk || {}) }, Date.now());
    return {
      mode: "paper_only", live_trading_enabled: false, binance_testnet_enabled: false,
      settings: {
        auto_paper_enabled: !!settings.auto_paper_enabled, halted: !!settings.halted,
        risk: { ...DEFAULT_RISK, ...(settings.risk || {}) }, paper_initial_capital_usd: settings.initial_capital_usd
      },
      automation: this.automationStatus(), portfolio, markets, trades, open_positions: openPositions,
      runtime, recent_events: this.sql.exec("SELECT * FROM events ORDER BY id DESC LIMIT 20").toArray()
    };
  }
}
