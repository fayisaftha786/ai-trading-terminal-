import test from "node:test";
import assert from "node:assert/strict";
import {
  assessMarketUniverse,
  advanceUnhealthyScanStreak,
  assessAdaptiveRisk,
  assessLossCooldown,
  deriveSchedulerStatus,
  shouldHaltPaperAutomation,
  updateTrailingStop
} from "../src/automation-guards.js";

const NOW = Date.parse("2026-11-08T12:00:00.000Z");

function healthyMarket(symbol) {
  const interval = 3600000;
  return {
    symbol,
    status: "live",
    ticker_time: new Date(NOW - 1000).toISOString(),
    bid: 100,
    ask: 100.01,
    last: 100,
    book_retrieved_at_ms: NOW - 1000,
    bid_depth_quote: 8000,
    ask_depth_quote: 9000,
    one_hour_audit_summary: { ok: true, valid_closed_bars: 300, issues: [] },
    six_hour_audit_summary: { ok: true, valid_closed_bars: 150, issues: [] }
  };
}

test("market-universe gate requires every configured market and clean closed candles", () => {
  const symbols = ["BTC/USD", "ETH/USD", "SOL/USD"];
  const markets = symbols.map(healthyMarket);
  assert.equal(assessMarketUniverse(markets, symbols, NOW).healthy, true);

  const partial = assessMarketUniverse(markets.slice(0, 2), symbols, NOW);
  assert.equal(partial.healthy, false);
  assert.ok(partial.issues.some((issue) => issue.reason === "market_universe_incomplete"));

  const broken = markets.map((market) => ({ ...market }));
  broken[1].six_hour_audit_summary = {
    ok: false, valid_closed_bars: 150, issues: ["missing_intervals"]
  };
  const rejected = assessMarketUniverse(broken, symbols, NOW);
  assert.equal(rejected.healthy, false);
  assert.ok(rejected.issues.some((issue) => issue.symbol === "ETH/USD" && issue.reason.includes("6h_candle_integrity_failed")));
});

test("market-universe gate requires a fresh L2 snapshot and adequate depth on both sides", () => {
  const symbols = ["BTC/USD"];

  const staleBook = healthyMarket("BTC/USD");
  staleBook.book_retrieved_at_ms = NOW - 15001;
  assert.ok(assessMarketUniverse([staleBook], symbols, NOW).issues[0].reason.includes("orderbook_snapshot_stale_or_missing"));

  const missingBookTime = healthyMarket("BTC/USD");
  delete missingBookTime.book_retrieved_at_ms;
  assert.ok(assessMarketUniverse([missingBookTime], symbols, NOW).issues[0].reason.includes("orderbook_snapshot_stale_or_missing"));

  const shallowBid = healthyMarket("BTC/USD");
  shallowBid.bid_depth_quote = 4999.99;
  assert.ok(assessMarketUniverse([shallowBid], symbols, NOW).issues[0].reason.includes("orderbook_depth_unavailable_or_low"));

  const shallowAsk = healthyMarket("BTC/USD");
  shallowAsk.ask_depth_quote = 100;
  assert.ok(assessMarketUniverse([shallowAsk], symbols, NOW).issues[0].reason.includes("orderbook_depth_unavailable_or_low"));
});

test("market-universe gate rejects stale and crossed quotes", () => {
  const symbols = ["BTC/USD"];
  const stale = healthyMarket("BTC/USD");
  stale.ticker_time = new Date(NOW - 121000).toISOString();
  assert.ok(assessMarketUniverse([stale], symbols, NOW).issues[0].reason.includes("ticker_stale"));

  const crossed = healthyMarket("BTC/USD");
  crossed.ask = crossed.bid - 0.1;
  assert.ok(assessMarketUniverse([crossed], symbols, NOW).issues[0].reason.includes("invalid_or_crossed_quote"));

  const missingBarCount = healthyMarket("BTC/USD");
  delete missingBarCount.one_hour_audit_summary.valid_closed_bars;
  assert.ok(assessMarketUniverse([missingBarCount], symbols, NOW).issues[0].reason.includes("1h_candle_integrity_failed"));

});

test("only scheduled unhealthy scans increase the consecutive failure streak", () => {
  assert.equal(advanceUnhealthyScanStreak(1, "scheduled", false), 2);
  assert.equal(advanceUnhealthyScanStreak(2, "manual", false), 2);
  assert.equal(advanceUnhealthyScanStreak(2, "scheduled", true), 0);
  assert.equal(advanceUnhealthyScanStreak(2, "manual", true), 2);
  assert.equal(advanceUnhealthyScanStreak(0, "manual", true), 0);
});

test("paper auto-entry is latched off after three scheduled data failures", () => {
  const decision = shouldHaltPaperAutomation({
    autoEnabled: true, halted: false, consecutiveUnhealthyScans: 3,
    lastHealthyScanAtMs: NOW - 10 * 60 * 1000, nowMs: NOW
  });
  assert.deepEqual(decision, { halt: true, reason: "consecutive_market_data_failures" });
  assert.equal(shouldHaltPaperAutomation({
    autoEnabled: false, halted: false, consecutiveUnhealthyScans: 9,
    lastHealthyScanAtMs: NOW - 60 * 60 * 1000, nowMs: NOW
  }).halt, false);
  assert.equal(shouldHaltPaperAutomation({
    autoEnabled: true, halted: true, consecutiveUnhealthyScans: 9,
    lastHealthyScanAtMs: NOW - 60 * 60 * 1000, nowMs: NOW
  }).halt, false);
});

test("a long gap since a healthy scan halts entries even when current feed recovered", () => {
  const decision = shouldHaltPaperAutomation({
    autoEnabled: true, halted: false, consecutiveUnhealthyScans: 0,
    lastHealthyScanAtMs: NOW - 46 * 60 * 1000, nowMs: NOW
  });
  assert.deepEqual(decision, { halt: true, reason: "scheduler_stale_since_last_healthy_scan" });
  assert.equal(shouldHaltPaperAutomation({
    autoEnabled: true, halted: false, consecutiveUnhealthyScans: 0,
    lastHealthyScanAtMs: NOW - 44 * 60 * 1000, nowMs: NOW
  }).halt, false);
  assert.equal(shouldHaltPaperAutomation({
    autoEnabled: true, halted: false, consecutiveUnhealthyScans: 3,
    lastHealthyScanAtMs: null, nowMs: NOW
  }).reason, "consecutive_market_data_failures");
});


test("scheduler heartbeat is independent of manual scans and reports missed alarms", () => {
  assert.deepEqual(deriveSchedulerStatus({
    lastScheduledAlarmAtMs: null,
    lastScheduledScanStatus: "completed",
    nowMs: NOW
  }), { status: "starting", ageMs: null });

  assert.deepEqual(deriveSchedulerStatus({
    lastScheduledAlarmAtMs: NOW - 60_000,
    lastScheduledScanStatus: "completed",
    nowMs: NOW
  }), { status: "healthy", ageMs: 60_000 });

  // A later manual scan is deliberately not an input: it cannot refresh
  // the scheduled-alarm heartbeat or hide a stopped scheduler.
  assert.deepEqual(deriveSchedulerStatus({
    lastScheduledAlarmAtMs: NOW - 46 * 60 * 1000,
    lastScheduledScanStatus: "completed",
    nowMs: NOW
  }), { status: "stale", ageMs: 46 * 60 * 1000 });

  assert.equal(deriveSchedulerStatus({
    lastScheduledAlarmAtMs: NOW - 30_000,
    lastScheduledScanStatus: "error",
    nowMs: NOW
  }).status, "error");
  assert.equal(deriveSchedulerStatus({
    lastScheduledAlarmAtMs: NOW - 30_000,
    lastScheduledScanStatus: "running",
    nowMs: NOW
  }).status, "running");
});


test("loss cooldown pauses after two or three consecutive realised losses and resets on a non-loss", () => {
  const twoLosses = [
    { pnl_usd: -0.3, closed_at_ms: NOW - 60_000 },
    { pnl_usd: -0.2, closed_at_ms: NOW - 90_000 },
    { pnl_usd: 0.4, closed_at_ms: NOW - 120_000 }
  ];
  const two = assessLossCooldown(twoLosses, NOW);
  assert.equal(two.blocked, true);
  assert.equal(two.lossStreak, 2);
  assert.equal(two.reason, "two_loss_cooldown_4h");
  assert.equal(two.remainingMs, (4 * 60 * 60 * 1000) - 60_000);

  const three = assessLossCooldown([
    { pnl_usd: -0.1, closed_at_ms: NOW - 60_000 },
    { pnl_usd: -0.2, closed_at_ms: NOW - 90_000 },
    { pnl_usd: -0.3, closed_at_ms: NOW - 120_000 }
  ], NOW);
  assert.equal(three.blocked, true);
  assert.equal(three.lossStreak, 3);
  assert.equal(three.reason, "three_loss_cooldown_12h");

  assert.deepEqual(assessLossCooldown([
    { pnl_usd: 0.01, closed_at_ms: NOW - 1000 },
    { pnl_usd: -0.2, closed_at_ms: NOW - 2000 }
  ], NOW), { blocked: false, lossStreak: 0, remainingMs: 0, reason: null });
  assert.equal(assessLossCooldown(twoLosses, NOW + 5 * 60 * 60 * 1000).blocked, false);
});

test("loss cooldown fails closed for malformed recent loss records", () => {
  assert.equal(assessLossCooldown([
    { pnl_usd: -1, closed_at_ms: "invalid" },
    { pnl_usd: -1, closed_at_ms: NOW - 2000 }
  ], NOW).reason, "loss_cooldown_timestamp_invalid");
  assert.equal(assessLossCooldown([{ pnl_usd: "bad", closed_at_ms: NOW }], NOW).reason, "recent_trade_result_invalid");
});

test("adaptive risk only scales down and pauses at high drawdown", () => {
  assert.equal(assessAdaptiveRisk({ drawdownPct: 0, lossStreak: 0 }).multiplier, 1);
  assert.equal(assessAdaptiveRisk({ drawdownPct: 1.5, lossStreak: 0 }).multiplier, 0.75);
  assert.equal(assessAdaptiveRisk({ drawdownPct: 2.5, lossStreak: 0 }).multiplier, 0.5);
  assert.equal(assessAdaptiveRisk({ drawdownPct: 3.5, lossStreak: 0 }).multiplier, 0.25);
  assert.equal(assessAdaptiveRisk({ drawdownPct: 0.2, lossStreak: 2 }).multiplier, 0.5);
  assert.equal(assessAdaptiveRisk({ drawdownPct: 0.2, lossStreak: 3 }).multiplier, 0.25);
  assert.deepEqual(assessAdaptiveRisk({ drawdownPct: 4, lossStreak: 0 }), {
    allowed: false, multiplier: 0, reason: "preemptive_drawdown_pause"
  });
  assert.equal(assessAdaptiveRisk({ drawdownPct: null, lossStreak: 0 }).allowed, false);
});

test("cost-aware trailing stop activates only after a profit buffer and never loosens", () => {
  const dormant = updateTrailingStop({
    entryPrice: 100, currentStop: 99, previousHighWater: 100,
    currentBid: 101.9, roundTripCostBps: 55
  });
  assert.equal(dormant.ok, true);
  assert.equal(dormant.active, false);
  assert.equal(dormant.stopLoss, 99);

  const activated = updateTrailingStop({
    entryPrice: 100, currentStop: 99, previousHighWater: 100,
    currentBid: 102.1, roundTripCostBps: 55
  });
  assert.equal(activated.active, true);
  assert.ok(activated.stopLoss > 100);
  assert.ok(activated.stopLoss < 102.1);

  const pullback = updateTrailingStop({
    entryPrice: 100, currentStop: activated.stopLoss,
    previousHighWater: activated.highWaterBid, currentBid: 100.5,
    roundTripCostBps: 55
  });
  assert.equal(pullback.stopLoss, activated.stopLoss);
  assert.equal(pullback.highWaterBid, activated.highWaterBid);
});

test("trailing stop rejects invalid prices and cost assumptions", () => {
  assert.equal(updateTrailingStop({
    entryPrice: 0, currentStop: 99, currentBid: 100
  }).ok, false);
});
