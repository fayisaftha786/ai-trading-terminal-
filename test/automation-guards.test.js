import test from "node:test";
import assert from "node:assert/strict";
import {
  assessMarketUniverse,
  advanceUnhealthyScanStreak,
  shouldHaltPaperAutomation
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

test("market-universe gate rejects stale and crossed quotes", () => {
  const symbols = ["BTC/USD"];
  const stale = healthyMarket("BTC/USD");
  stale.ticker_time = new Date(NOW - 121000).toISOString();
  assert.ok(assessMarketUniverse([stale], symbols, NOW).issues[0].reason.includes("ticker_stale"));

  const crossed = healthyMarket("BTC/USD");
  crossed.ask = crossed.bid - 0.1;
  assert.ok(assessMarketUniverse([crossed], symbols, NOW).issues[0].reason.includes("invalid_or_crossed_quote"));
});

test("only scheduled unhealthy scans increase the consecutive failure streak", () => {
  assert.equal(advanceUnhealthyScanStreak(1, "scheduled", false), 2);
  assert.equal(advanceUnhealthyScanStreak(2, "manual", false), 2);
  assert.equal(advanceUnhealthyScanStreak(2, "scheduled", true), 0);
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
