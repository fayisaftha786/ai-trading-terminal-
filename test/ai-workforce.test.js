import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildAiWorkforceRun,
  evaluateAiWorkforceRiskVeto,
  markAiWorkforceFailure,
  readAiWorkforceStatus
} from "../src/ai-workforce.js";

const engineSource = readFileSync(new URL("../src/engine.js", import.meta.url), "utf8");
const dashboardSource = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

function market(symbol, overrides = {}) {
  return {
    symbol,
    product: symbol.replace("/", "-"),
    status: "live",
    market_data_provider: "coinbase_exchange",
    spread_bps: 8,
    bid_depth_quote: 9000,
    ask_depth_quote: 8500,
    book_retrieved_at_ms: 1_000_000,
    primary: {
      regime: "UPTREND", signal: "HOLD", score: 70, rsi14: 56,
      adx14: 24, plus_di14: 28, minus_di14: 12,
      ema20_slope_pct: 0.08, volume_ratio_20: 1.3,
      breakout_20: false
    },
    higher: { regime: "UPTREND" },
    strategy_research: {
      status: "research_only",
      candidates: [
        { strategy_id: "trend_pullback", eligible_for_research: false },
        { strategy_id: "volatility_breakout", eligible_for_research: false },
        { strategy_id: "range_mean_reversion", eligible_for_research: false }
      ]
    },
    ...overrides
  };
}

function context(overrides = {}) {
  const now = 1_000_000;
  const markets = [market("BTC/USD"), market("ETH/USD"), market("SOL/USD")];
  return {
    markets,
    marketFeed: { healthy: true, healthy_market_count: 3, expected_market_count: 3, issues: [] },
    marketContext: {
      status: "verified", mode: "RISK_ON", reason: "btc_trend_and_cross_market_breadth_aligned",
      btc_regime_1h: "UPTREND", btc_regime_6h: "UPTREND",
      breadth_1h: { uptrend: 3 }, breadth_6h: { uptrend: 3 },
      allowed_for_long_entries: true
    },
    portfolio: { open_positions: 0, unmarked_positions: 0 },
    settings: { halted: false, auto_paper_enabled: false },
    runtime: {
      last_scheduled_alarm_at_ms: now - 1_000,
      last_scheduled_scan_at_ms: now - 90_000,
      last_scheduled_scan_status: "completed",
      last_scan_status: "completed"
    },
    entryStatus: "no_qualified_signal",
    source: "scheduled",
    nowMs: now,
    paperMode: true,
    ...overrides
  };
}

test("Risk Guardian requires the full market, eligible regime, marked portfolio and DEMO mode", () => {
  const safe = evaluateAiWorkforceRiskVeto({
    marketFeed: { healthy: true },
    marketContext: { allowed_for_long_entries: true },
    portfolio: { unmarked_positions: 0 },
    settings: { halted: false },
    paperMode: true
  });
  assert.equal(safe.veto, false);

  const unsafe = evaluateAiWorkforceRiskVeto({
    marketFeed: { healthy: false },
    marketContext: { allowed_for_long_entries: false },
    portfolio: { unmarked_positions: 1 },
    settings: { halted: true },
    paperMode: false
  });
  assert.equal(unsafe.veto, true);
  assert.deepEqual(unsafe.vetoReasons, [
    "complete_market_universe",
    "market_context_allows_long_entries",
    "owner_stop_not_active",
    "portfolio_fully_marked",
    "paper_only_mode"
  ]);
});
test("workforce creates twelve unique deterministic roles and never authorizes execution", () => {
  const result = buildAiWorkforceRun(context());
  assert.equal(result.worker_count, 12);
  assert.equal(result.workers.length, 12);
  assert.equal(new Set(result.workers.map((worker) => worker.id)).size, 12);
  assert.equal(result.mode, "paper_only_read_only");
  assert.equal(result.execution_authorized, false);
  assert.equal(result.paper_auto_entry_eligible, false);
  assert.equal(result.live_trading_enabled, false);
  assert.ok(result.workers.every((worker) => worker.execution_authorized === false));
  assert.equal(result.workers.find((worker) => worker.id === "risk_guardian").veto, false);
});

test("market-universe failure is surfaced and Risk Guardian vetoes", () => {
  const result = buildAiWorkforceRun(context({
    marketFeed: {
      healthy: false, healthy_market_count: 2, expected_market_count: 3,
      issues: [{ symbol: "SOL/USD", reason: "orderbook_stale" }]
    }
  }));
  const feed = result.workers.find((worker) => worker.id === "market_feed");
  const risk = result.workers.find((worker) => worker.id === "risk_guardian");
  assert.equal(feed.status, "partial");
  assert.match(feed.summary, /must remain blocked/);
  assert.equal(risk.status, "blocked");
  assert.equal(risk.veto, true);
  assert.ok(risk.metrics.veto_reasons.includes("complete_market_universe"));
});

test("unverified market regime and unavailable research are not fabricated as complete", () => {
  const markets = context().markets.map((item) => ({
    ...item,
    strategy_research: { status: "blocked", candidates: [] }
  }));
  const result = buildAiWorkforceRun(context({
    markets,
    marketContext: { status: "unavailable", mode: "BLOCKED", allowed_for_long_entries: false }
  }));
  assert.equal(result.workers.find((worker) => worker.id === "market_regime").status, "unavailable");
  assert.equal(result.workers.find((worker) => worker.id === "strategy_research").status, "unavailable");
});

test("unsupported providers are excluded from the Coinbase workforce analysis universe", () => {
  const result = buildAiWorkforceRun(context({
    markets: context().markets.map((item) => ({ ...item, market_data_provider: "binance" }))
  }));
  assert.equal(result.workers.find((worker) => worker.id === "trend").status, "blocked");
  assert.equal(result.workers.find((worker) => worker.id === "microstructure").status, "blocked");
});

test("null volume and order-book fields remain unavailable instead of becoming numeric zero", () => {
  const markets = context().markets.map((item) => ({
    ...item,
    spread_bps: null,
    bid_depth_quote: null,
    ask_depth_quote: null,
    book_retrieved_at_ms: null,
    primary: { ...item.primary, volume_ratio_20: null }
  }));
  const result = buildAiWorkforceRun(context({ markets }));
  assert.equal(result.workers.find((worker) => worker.id === "volume").status, "blocked");
  assert.equal(result.workers.find((worker) => worker.id === "microstructure").status, "blocked");
});
test("watchdog exposes a missing or stale scheduler heartbeat", () => {
  const result = buildAiWorkforceRun(context({
    runtime: { last_scheduled_alarm_at_ms: 1_000 },
    nowMs: 1_000_000
  }));
  const watchdog = result.workers.find((worker) => worker.id === "system_watchdog");
  assert.equal(watchdog.status, "unavailable");
  assert.equal(watchdog.metrics.scheduler_status, "stale_or_not_started");
});

test("failed scheduled scans mark every specialist as error without granting execution", () => {
  const failed = markAiWorkforceFailure(buildAiWorkforceRun(context()), new Error("provider timeout"), 1_100_000);
  assert.equal(failed.status, "error");
  assert.equal(failed.counts.error, 12);
  assert.ok(failed.workers.every((worker) => worker.status === "error"));
  assert.ok(failed.workers.every((worker) => worker.execution_authorized === false));
});

test("missing workforce data starts honestly in waiting state and stale runs are labeled", () => {
  const empty = readAiWorkforceStatus(null, {}, 1_000_000);
  assert.equal(empty.status, "waiting");
  assert.equal(empty.worker_count, 12);
  assert.ok(empty.workers.every((worker) => worker.status === "waiting"));

  const stale = readAiWorkforceStatus(buildAiWorkforceRun(context()), {}, 1_500_000);
  assert.equal(stale.freshness_status, "stale");
});

test("production engine enforces Risk Guardian before Paper entries and serves workforce status", () => {
  assert.match(engineSource, /buildAiWorkforceRun/);
  assert.match(engineSource, /evaluateAiWorkforceRiskVeto/);
  const riskGateIndex = engineSource.indexOf("const riskGuardianDecision = evaluateAiWorkforceRiskVeto");
  const openTradeIndex = engineSource.indexOf("this.openPaperTrade(candidates[0]");
  assert.ok(riskGateIndex >= 0 && openTradeIndex > riskGateIndex, "Risk Guardian must run before a new Paper entry");
  assert.ok(engineSource.includes("else if (riskGuardianDecision.veto)"));
  assert.ok(engineSource.includes('this.setState("workforce", workforce)'));
  assert.ok(engineSource.includes('readAiWorkforceStatus(this.getState("workforce"), runtime, nowMs)'));
  assert.ok(engineSource.includes("markAiWorkforceFailure"));
  assert.ok(dashboardSource.includes('id="aiWorkforcePanel"'));
  assert.ok(dashboardSource.includes("renderAiWorkforce(data.workforce)"));
});
