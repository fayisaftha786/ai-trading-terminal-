import test from "node:test";
import assert from "node:assert/strict";
import { ema, rsiWilder, auditCandles, analyzeTimeframe, assessCandidate } from "../src/strategy.js";

function makeCandles(count, intervalMs, startMs = 0, trend = 0.15) {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * trend + Math.sin(index / 3) * 0.2;
    return { time: startMs + index * intervalMs, open: close - 0.1, high: close + 0.4, low: close - 0.4, close, volume: 1000 + (index % 7) * 50 };
  });
}

test("EMA uses an SMA seed and remains finite", () => {
  const values = ema([1, 2, 3, 4, 5], 3);
  assert.equal(values.length, 5);
  assert.equal(values[2], 2);
  assert.ok(values.every(Number.isFinite));
});

test("Wilder RSI handles rising, falling and flat series", () => {
  assert.equal(rsiWilder(Array.from({ length: 30 }, (_, i) => 100 + i)), 100);
  assert.equal(rsiWilder(Array.from({ length: 30 }, (_, i) => 130 - i)), 0);
  assert.equal(rsiWilder(Array(30).fill(100)), 50);
});

test("candle audit excludes the active candle and rejects gaps", () => {
  const interval = 3600000;
  const now = (150 * interval) + 1;
  const input = makeCandles(151, interval);
  const audit = auditCandles(input, interval, now, 150);
  assert.equal(audit.rows.length, 150);
  assert.equal(audit.ok, true);
  const broken = input.filter((_, index) => index !== 80);
  const bad = auditCandles(broken, interval, now, 150);
  assert.equal(bad.ok, false);
  assert.ok(bad.issues.includes("missing_intervals"));
});

test("duplicate and off-grid candles fail closed", () => {
  const interval = 3600000;
  const now = 151 * interval;
  const rows = makeCandles(151, interval);
  rows[10].time += 1000;
  rows.push({ ...rows[12] });
  const audit = auditCandles(rows, interval, now, 150);
  assert.equal(audit.ok, false);
  assert.ok(audit.issues.includes("off_grid_timestamp"));
  assert.ok(audit.issues.includes("duplicate_timestamp"));
});

test("analysis returns HOLD when candle integrity is not clean", () => {
  const result = analyzeTimeframe({ ok: false, issues: ["missing_intervals"], rows: [] });
  assert.equal(result.signal, "HOLD");
  assert.equal(result.score, 0);
});

test("candidate gate rejects crossed, wide, stale and shallow markets", () => {
  const now = Date.now();
  const market = { status: "live", ticker_time: new Date(now).toISOString(), bid: 100, ask: 100.01,
    last: 100, quote_volume_usd: 5000000, bid_depth_quote: 10000, ask_depth_quote: 10000 };
  const primary = { signal: "BUY_CANDIDATE", score: 90, regime: "UPTREND", last_closed_candle_ms: now - 3600000,
    atr_pct: 2, rsi14: 55, adx14: 30, plus_di14: 40, minus_di14: 10 };
  const higher = { regime: "UPTREND", last_closed_candle_ms: now - 21600000 };
  const costs = { feeBpsPerSide: 15, slippageBps: 10 };
  assert.equal(assessCandidate({ market, primary, higher, nowMs: now, costs }).eligible, true);
  assert.equal(assessCandidate({ market: { ...market, ask: 99 }, primary, higher, nowMs: now, costs }).reason, "invalid_or_crossed_quote");
  assert.equal(assessCandidate({ market: { ...market, bid_depth_quote: 10 }, primary, higher, nowMs: now, costs }).reason, "top10_orderbook_depth_unavailable_or_low");
  assert.equal(assessCandidate({ market: { ...market, ticker_time: new Date(now - 180000).toISOString() }, primary, higher, nowMs: now, costs }).reason, "ticker_stale_or_timestamp_invalid");
  assert.equal(assessCandidate({ market: { ...market, ask: 101 }, primary, higher, nowMs: now, costs }).reason, "spread_too_wide");
});

test("candidate gate blocks signals without higher-timeframe agreement", () => {
  const now = Date.now();
  const market = { status: "live", ticker_time: new Date(now).toISOString(), bid: 100, ask: 100.01,
    last: 100, quote_volume_usd: 5000000, bid_depth_quote: 10000, ask_depth_quote: 10000 };
  const primary = { signal: "BUY_CANDIDATE", score: 90, regime: "UPTREND", last_closed_candle_ms: now - 3600000,
    atr_pct: 2, rsi14: 55, adx14: 30, plus_di14: 40, minus_di14: 10 };
  const higher = { regime: "RANGE_OR_TRANSITION", last_closed_candle_ms: now - 21600000 };
  const result = assessCandidate({ market, primary, higher, nowMs: now, costs: { feeBpsPerSide: 15, slippageBps: 10 } });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "timeframes_not_both_uptrend");
});
