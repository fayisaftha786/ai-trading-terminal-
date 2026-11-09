import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ema, rsiWilder, auditCandles, analyzeTimeframe, assessCandidate, buildFreshBidMarks, evaluateResearchCandidates, isFreshBidQuote, resolveRiskBaseline } from "../src/strategy.js";

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
    last: 100, quote_volume_usd: 5000000, bid_depth_quote: 10000, ask_depth_quote: 10000, book_retrieved_at_ms: now - 1000 };
  const primary = { signal: "BUY_CANDIDATE", score: 90, regime: "UPTREND", last_closed_candle_ms: now - 3600000,
    atr_pct: 2, rsi14: 55, adx14: 30, plus_di14: 40, minus_di14: 10 };
  const higher = { regime: "UPTREND", last_closed_candle_ms: now - 21600000 };
  const costs = { feeBpsPerSide: 15, slippageBps: 10 };
  assert.equal(assessCandidate({ market, primary, higher, nowMs: now, costs }).eligible, true);
  assert.equal(assessCandidate({ market: { ...market, ask: 99 }, primary, higher, nowMs: now, costs }).reason, "invalid_or_crossed_quote");
  assert.equal(assessCandidate({ market: { ...market, bid_depth_quote: 10 }, primary, higher, nowMs: now, costs }).reason, "top10_orderbook_depth_unavailable_or_low");
  assert.equal(assessCandidate({ market: { ...market, book_retrieved_at_ms: now - 20000 }, primary, higher, nowMs: now, costs }).reason, "orderbook_snapshot_retrieval_stale_or_missing");
  assert.equal(assessCandidate({ market: { ...market, book_retrieved_at_ms: undefined }, primary, higher, nowMs: now, costs }).reason, "orderbook_snapshot_retrieval_stale_or_missing");
  assert.equal(assessCandidate({ market: { ...market, book_retrieved_at_ms: now + 2000 }, primary, higher, nowMs: now, costs }).reason, "orderbook_snapshot_retrieval_stale_or_missing");
  assert.equal(assessCandidate({ market: { ...market, ticker_time: new Date(now - 180000).toISOString() }, primary, higher, nowMs: now, costs }).reason, "ticker_stale_or_timestamp_invalid");
  assert.equal(assessCandidate({ market: { ...market, ask: 101 }, primary, higher, nowMs: now, costs }).reason, "spread_too_wide");
});

test("candidate gate rejects stale timeframe candles and invalid execution assumptions", () => {
  const now = Date.now();
  const market = { status: "live", ticker_time: new Date(now).toISOString(), bid: 100, ask: 100.01,
    last: 100, quote_volume_usd: 5000000, bid_depth_quote: 10000, ask_depth_quote: 10000,
    book_retrieved_at_ms: now - 1000 };
  const primary = { signal: "BUY_CANDIDATE", score: 90, regime: "UPTREND",
    last_closed_candle_ms: now - 3600000, atr_pct: 2, rsi14: 55,
    adx14: 30, plus_di14: 40, minus_di14: 10 };
  const higher = { regime: "UPTREND", last_closed_candle_ms: now - 21600000 };
  const costs = { feeBpsPerSide: 15, slippageBps: 10 };

  assert.equal(assessCandidate({
    market, primary: { ...primary, last_closed_candle_ms: now - 3600000 - 5400001 },
    higher, nowMs: now, costs
  }).reason, "one_hour_candle_stale");

  assert.equal(assessCandidate({
    market, primary,
    higher: { ...higher, last_closed_candle_ms: now - 21600000 - 25200001 },
    nowMs: now, costs
  }).reason, "six_hour_candle_stale");

  assert.equal(assessCandidate({
    market, primary, higher, nowMs: now,
    costs: { feeBpsPerSide: Number.NaN, slippageBps: 10 }
  }).reason, "execution_cost_assumptions_invalid");

  assert.equal(assessCandidate({
    market, primary: null, higher, nowMs: now, costs
  }).reason, "timeframe_analysis_unavailable");

  assert.equal(assessCandidate({
    market, primary: { ...primary, score: Number.NaN }, higher, nowMs: now, costs
  }).reason, "timeframe_metrics_invalid");
});

test("candidate gate blocks signals without higher-timeframe agreement", () => {
  const now = Date.now();
  const market = { status: "live", ticker_time: new Date(now).toISOString(), bid: 100, ask: 100.01,
    last: 100, quote_volume_usd: 5000000, bid_depth_quote: 10000, ask_depth_quote: 10000, book_retrieved_at_ms: now - 1000 };
  const primary = { signal: "BUY_CANDIDATE", score: 90, regime: "UPTREND", last_closed_candle_ms: now - 3600000,
    atr_pct: 2, rsi14: 55, adx14: 30, plus_di14: 40, minus_di14: 10 };
  const higher = { regime: "RANGE_OR_TRANSITION", last_closed_candle_ms: now - 21600000 };
  const result = assessCandidate({ market, primary, higher, nowMs: now, costs: { feeBpsPerSide: 15, slippageBps: 10 } });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "timeframes_not_both_uptrend");
});


test("fresh bid marks reject stale, future, crossed and invalid ticker snapshots", () => {
  const now = Date.now();
  const markets = [
    { symbol: "BTC/USD", status: "live", ticker_time: new Date(now - 1000).toISOString(), bid: 100, ask: 100.1 },
    { symbol: "ETH/USD", status: "live", ticker_time: new Date(now - 121000).toISOString(), bid: 50, ask: 50.1 },
    { symbol: "SOL/USD", status: "live", ticker_time: new Date(now + 6000).toISOString(), bid: 20, ask: 20.1 },
    { symbol: "BAD/USD", status: "live", ticker_time: new Date(now).toISOString(), bid: 10.1, ask: 10 },
    { symbol: "OFF/USD", status: "error", ticker_time: new Date(now).toISOString(), bid: 5, ask: 5.1 }
  ];
  const marks = buildFreshBidMarks(markets, now);
  assert.deepEqual([...marks.entries()], [["BTC/USD", 100]]);
});

test("risk baseline waits for a fully marked portfolio", () => {
  const waiting = resolveRiskBaseline({
    periodKey: "2026-11-07", storedPeriodKey: "2026-11-06", storedBaseline: 100,
    equity: 98, closedPnl: -1, unmarkedPositions: 1
  });
  assert.equal(waiting.initialized, false);
  assert.equal(waiting.shouldPersist, false);
  assert.equal(waiting.baseline, null);

  const initialized = resolveRiskBaseline({
    periodKey: "2026-11-07", storedPeriodKey: "2026-11-06", storedBaseline: 100,
    equity: 98, closedPnl: -1, unmarkedPositions: 0
  });
  assert.equal(initialized.initialized, true);
  assert.equal(initialized.shouldPersist, true);
  assert.equal(initialized.baseline, 99);
});

test("risk baseline remains stable once initialized for a period", () => {
  const existing = resolveRiskBaseline({
    periodKey: "2026-11-07", storedPeriodKey: "2026-11-07", storedBaseline: 97.5,
    equity: 120, closedPnl: 0, unmarkedPositions: 0
  });
  assert.equal(existing.initialized, true);
  assert.equal(existing.shouldPersist, false);
  assert.equal(existing.baseline, 97.5);
});



test("research lab reports three candidates but never authorizes execution", () => {
  const sixHours = 6 * 60 * 60 * 1000;
  const oneHour = 60 * 60 * 1000;
  const base = 1_700_000_000_000 - (1_700_000_000_000 % sixHours);
  const primary = makeCandles(160, oneHour, base, 0.15);
  const higher = makeCandles(150, sixHours, base - (900 * oneHour), 0.2);
  const nowMs = base + (161 * oneHour);
  const primaryAudit = auditCandles(primary, oneHour, nowMs);
  const higherAudit = auditCandles(higher, sixHours, nowMs);
  const result = evaluateResearchCandidates(primaryAudit, higherAudit, sixHours);

  assert.equal(result.status, "research_only");
  assert.deepEqual(result.candidates.map((candidate) => candidate.strategy_id), [
    "trend_pullback", "volatility_breakout", "range_mean_reversion"
  ]);
  assert.ok(result.candidates.every((candidate) =>
    candidate.execution_authorized === false && candidate.score_is_probability === false
  ));
  assert.equal(result.execution_authorized, false);
  assert.equal(result.paper_auto_entry_eligible, false);
  assert.equal(result.live_trading_enabled, false);
});


test("research lab blocks dirty and future confirmation candle histories", () => {
  const sixHours = 6 * 60 * 60 * 1000;
  const oneHour = 60 * 60 * 1000;
  const base = 1_700_000_000_000 - (1_700_000_000_000 % sixHours);
  const primary = makeCandles(160, oneHour, base, 0.15);
  const cleanHigher = makeCandles(150, sixHours, base - (900 * oneHour), 0.2);
  const nowMs = base + (200 * oneHour);

  const dirtyPrimary = primary.map((row) => ({ ...row }));
  dirtyPrimary[80] = { ...dirtyPrimary[80], time: dirtyPrimary[79].time };
  const dirty = evaluateResearchCandidates(
    auditCandles(dirtyPrimary, oneHour, nowMs),
    auditCandles(cleanHigher, sixHours, nowMs),
    sixHours
  );
  assert.equal(dirty.status, "blocked");
  assert.equal(dirty.reason, "candle_integrity_failed");
  assert.equal(dirty.execution_authorized, false);

  const futureHigher = makeCandles(150, sixHours, base - (714 * oneHour), 0.2);
  const future = evaluateResearchCandidates(
    auditCandles(primary, oneHour, nowMs),
    auditCandles(futureHigher, sixHours, nowMs),
    sixHours
  );
  assert.equal(future.status, "blocked");
  assert.equal(future.reason, "higher_timeframe_data_is_from_the_future");
  assert.equal(future.execution_authorized, false);
});



test("Cloudflare dashboard inline JavaScript parses before deployment", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[2].trim())
    .filter(Boolean);
  assert.equal(scripts.length, 1, "expected the Cloudflare dashboard inline application script");
  scripts.forEach((source, index) => {
    assert.doesNotThrow(
      () => new vm.Script(source, { filename: `public/index.html:inline-${index + 1}` }),
      "Cloudflare dashboard inline JavaScript must remain syntactically valid"
    );
  });
});


test("fresh local ticker retrieval remains usable for paper exits when last trade timestamp is old", () => {
  const now = Date.now();
  const market = {
    symbol: "BTC/USD",
    status: "live",
    ticker_time: new Date(now - 5 * 60 * 1000).toISOString(),
    quote_received_at_ms: now - 1000,
    bid: 100,
    ask: 100.01
  };
  assert.equal(isFreshBidQuote(market, now), true);
  assert.deepEqual([...buildFreshBidMarks([market], now).entries()], [["BTC/USD", 100]]);

  const staleObservation = { ...market, quote_received_at_ms: now - 121000 };
  assert.equal(isFreshBidQuote(staleObservation, now), false);
  assert.equal(buildFreshBidMarks([staleObservation], now).size, 0);

  const futureEvent = { ...market, ticker_time: new Date(now + 6000).toISOString() };
  assert.equal(isFreshBidQuote(futureEvent, now), false);
});


test("candidate gate blocks a newly retrieved quote when no recent exchange trade occurred", () => {
  const now = Date.now();
  const market = {
    status: "live",
    ticker_time: new Date(now - 5 * 60 * 1000).toISOString(),
    quote_received_at_ms: now - 1000,
    bid: 100, ask: 100.01, last: 100,
    quote_volume_usd: 5000000,
    bid_depth_quote: 10000, ask_depth_quote: 10000,
    book_retrieved_at_ms: now - 1000
  };
  const primary = {
    signal: "BUY_CANDIDATE", score: 90, regime: "UPTREND",
    last_closed_candle_ms: now - 3600000,
    atr_pct: 2, rsi14: 55, adx14: 30, plus_di14: 40, minus_di14: 10
  };
  const higher = { regime: "UPTREND", last_closed_candle_ms: now - 21600000 };
  const result = assessCandidate({
    market, primary, higher, nowMs: now,
    costs: { feeBpsPerSide: 15, slippageBps: 10 }
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "ticker_stale_or_timestamp_invalid");
});


test("fresh received bid can still mark an open PAPER position when exchange event time is missing", () => {
  const now = Date.now();
  const market = {
    symbol: "ETH/USD",
    status: "live",
    quote_received_at_ms: now - 500,
    bid: 2000,
    ask: 2000.1
  };
  assert.equal(isFreshBidQuote(market, now), true);
  assert.deepEqual([...buildFreshBidMarks([market], now).entries()], [["ETH/USD", 2000]]);
  const oldSchema = { ...market };
  delete oldSchema.quote_received_at_ms;
  assert.equal(isFreshBidQuote(oldSchema, now), false);
});
