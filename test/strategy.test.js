import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ema, rsiWilder, auditCandles, analyzeTimeframe, classifyMarketRegime, assessCandidate, assessCrossMarketContext, buildFreshBidMarks, evaluateResearchCandidates, isFreshBidQuote, resolveRiskBaseline } from "../src/strategy.js";

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


test("new PAPER candidates are Coinbase-only even while legacy Bitstamp exits remain supported", () => {
  const now = Date.now();
  const market = {
    status: "live", market_data_provider: "bitstamp_spot",
    ticker_time: new Date(now).toISOString(), quote_received_at_ms: now - 1000,
    bid: 100, ask: 100.01, last: 100, quote_volume_usd: 5000000,
    bid_depth_quote: 10000, ask_depth_quote: 10000, book_retrieved_at_ms: now - 1000
  };
  const primary = {
    signal: "BUY_CANDIDATE", score: 90, regime: "UPTREND",
    last_closed_candle_ms: now - 3600000, atr_pct: 2, rsi14: 55,
    adx14: 30, plus_di14: 40, minus_di14: 10
  };
  const higher = { regime: "UPTREND", last_closed_candle_ms: now - 21600000 };
  const result = assessCandidate({
    market, primary, higher, nowMs: now,
    costs: { feeBpsPerSide: 15, slippageBps: 10 }
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "coinbase_market_data_required_for_new_entry");
});

test("candidate gate rejects crossed, wide, stale and shallow markets", () => {
  const now = Date.now();
  const market = { status: "live", market_data_provider: "coinbase_exchange", ticker_time: new Date(now).toISOString(), bid: 100, ask: 100.01,
    last: 100, quote_volume_usd: 5000000, bid_depth_quote: 10000, ask_depth_quote: 10000, book_retrieved_at_ms: now - 1000 };
  const primary = { signal: "BUY_CANDIDATE", score: 90, regime: "UPTREND", last_closed_candle_ms: now - 3600000,
    atr_pct: 2, rsi14: 55, adx14: 30, plus_di14: 40, minus_di14: 10 };
  const higher = { regime: "UPTREND", last_closed_candle_ms: now - 21600000 };
  const costs = { feeBpsPerSide: 15, slippageBps: 10 };
  assert.equal(assessCandidate({ market, primary, higher, nowMs: now, costs }).eligible, true);
  assert.equal(assessCandidate({ market: { ...market, ask: 99 }, primary, higher, nowMs: now, costs }).reason, "invalid_or_crossed_quote");
  assert.equal(assessCandidate({ market: { ...market, bid_depth_quote: 10 }, primary, higher, nowMs: now, costs }).reason, "top50_orderbook_depth_unavailable_or_low");
  assert.equal(assessCandidate({ market: { ...market, book_retrieved_at_ms: now - 20000 }, primary, higher, nowMs: now, costs }).reason, "orderbook_snapshot_retrieval_stale_or_missing");
  assert.equal(assessCandidate({ market: { ...market, book_retrieved_at_ms: undefined }, primary, higher, nowMs: now, costs }).reason, "orderbook_snapshot_retrieval_stale_or_missing");
  assert.equal(assessCandidate({ market: { ...market, book_retrieved_at_ms: now + 2000 }, primary, higher, nowMs: now, costs }).reason, "orderbook_snapshot_retrieval_stale_or_missing");
  assert.equal(assessCandidate({ market: { ...market, ticker_time: new Date(now - 180000).toISOString() }, primary, higher, nowMs: now, costs }).reason, "ticker_stale_or_timestamp_invalid");
  assert.equal(assessCandidate({ market: { ...market, ask: 101 }, primary, higher, nowMs: now, costs }).reason, "spread_too_wide");
});

test("candidate gate reports at least 1:1 net reward/risk after fees, slippage and spread", () => {
  const now = Date.now();
  const market = {
    status: "live", market_data_provider: "coinbase_exchange",
    ticker_time: new Date(now).toISOString(), quote_received_at_ms: now - 1000,
    bid: 100, ask: 100.01, last: 100,
    quote_volume_usd: 5000000, bid_depth_quote: 10000, ask_depth_quote: 10000,
    book_retrieved_at_ms: now - 1000
  };
  const primary = {
    signal: "BUY_CANDIDATE", score: 90, regime: "UPTREND",
    last_closed_candle_ms: now - 3600000, atr_pct: 2, rsi14: 55,
    adx14: 30, plus_di14: 40, minus_di14: 10
  };
  const higher = { regime: "UPTREND", last_closed_candle_ms: now - 21600000 };
  const result = assessCandidate({
    market, primary, higher, nowMs: now,
    costs: { feeBpsPerSide: 15, slippageBps: 10 },
    stopLossPct: 1,
    minimumNetRewardRisk: 1
  });
  assert.equal(result.eligible, true);
  assert.ok(result.dynamic_take_profit_bps >= result.round_trip_cost_bps + 100 + result.round_trip_cost_bps);
  assert.ok(result.net_reward_risk_ratio >= 1);
  assert.equal(result.minimum_net_reward_risk, 1);
});

test("candidate gate rejects an unreachable net reward/risk target instead of opening the trade", () => {
  const now = Date.now();
  const market = {
    status: "live", market_data_provider: "coinbase_exchange",
    ticker_time: new Date(now).toISOString(), quote_received_at_ms: now - 1000,
    bid: 100, ask: 100.01, last: 100,
    quote_volume_usd: 5000000, bid_depth_quote: 10000, ask_depth_quote: 10000,
    book_retrieved_at_ms: now - 1000
  };
  const primary = {
    signal: "BUY_CANDIDATE", score: 90, regime: "UPTREND",
    last_closed_candle_ms: now - 3600000, atr_pct: 4.9, rsi14: 55,
    adx14: 30, plus_di14: 40, minus_di14: 10
  };
  const higher = { regime: "UPTREND", last_closed_candle_ms: now - 21600000 };
  const result = assessCandidate({
    market, primary, higher, nowMs: now,
    costs: { feeBpsPerSide: 50, slippageBps: 25 },
    stopLossPct: 4.5
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "dynamic_target_outside_safe_bounds");
});

test("candidate gate rejects stale timeframe candles and invalid execution assumptions", () => {
  const now = Date.now();
  const market = { status: "live", market_data_provider: "coinbase_exchange", ticker_time: new Date(now).toISOString(), bid: 100, ask: 100.01,
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
  const market = { status: "live", market_data_provider: "coinbase_exchange", ticker_time: new Date(now).toISOString(), bid: 100, ask: 100.01,
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
    equity: 120, closedPnl: 0, unmarkedPositions: 0, tradeCount: 4
  });
  assert.equal(existing.initialized, true);
  assert.equal(existing.shouldPersist, false);
  assert.equal(existing.baseline, 97.5);
});

test("an empty paper ledger re-anchors a stale same-period risk baseline", () => {
  const reset = resolveRiskBaseline({
    periodKey: "2026-11-09", storedPeriodKey: "2026-11-09", storedBaseline: 9.85,
    equity: 10, closedPnl: 0, unmarkedPositions: 0, tradeCount: 0
  });
  assert.deepEqual(reset, { baseline: 10, initialized: true, shouldPersist: true });
});

test("an empty paper ledger initializes a new UTC period at current equity", () => {
  const reset = resolveRiskBaseline({
    periodKey: "2026-11-09", storedPeriodKey: "2026-11-08", storedBaseline: 9.5,
    equity: 10, closedPnl: 0, unmarkedPositions: 0, tradeCount: 0
  });
  assert.deepEqual(reset, { baseline: 10, initialized: true, shouldPersist: true });
});

test("an empty-ledger baseline still waits when an open position is unmarked", () => {
  const waiting = resolveRiskBaseline({
    periodKey: "2026-11-09", storedPeriodKey: "2026-11-09", storedBaseline: 9,
    equity: 10, closedPnl: 0, unmarkedPositions: 1, tradeCount: 0
  });
  assert.deepEqual(waiting, { baseline: null, initialized: false, shouldPersist: false });
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
    status: "live", market_data_provider: "coinbase_exchange",
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


test("PAPER position bid marks stay on the provider recorded at entry", () => {
  const now = Date.now();
  const coinbase = {
    symbol: "SOL/USD", status: "live", market_data_provider: "coinbase_exchange",
    quote_received_at_ms: now - 1000,
    ticker_time: new Date(now - 60 * 1000).toISOString(),
    bid: 100, ask: 100.01
  };
  const bitstamp = {
    ...coinbase,
    market_data_provider: "bitstamp_spot",
    bid: 99.9, ask: 100
  };

  const coinbaseLocked = buildFreshBidMarks(
    [bitstamp], now, 120000, new Map([["SOL/USD", "coinbase_exchange"]])
  );
  assert.equal(coinbaseLocked.has("SOL/USD"), false);

  const bitstampLocked = buildFreshBidMarks(
    [bitstamp], now, 120000, new Map([["SOL/USD", "bitstamp_spot"]])
  );
  assert.deepEqual([...bitstampLocked.entries()], [["SOL/USD", 99.9]]);

  const legacyDefault = buildFreshBidMarks(
    [coinbase], now, 120000, new Map([["SOL/USD", "coinbase_exchange"]])
  );
  assert.deepEqual([...legacyDefault.entries()], [["SOL/USD", 100]]);
});


test("engine persists entry venue and locks automatic and manual PAPER exits to it", () => {
  const engineSource = readFileSync(new URL("../src/engine.js", import.meta.url), "utf8");
  assert.match(engineSource, /market_data_provider: market\.market_data_provider/);
  assert.match(engineSource, /buildPositionLockedBidMarks\(markets, Date\.now\(\)\)/);
  assert.match(engineSource, /same_entry_provider_quote_required/);
  assert.match(engineSource, /close_market_data_provider/);
});


test("market regime classifier recognises directional trend without authorising a trade", () => {
  const now = Date.now();
  const lastClosed = Math.floor(now / 3600000) * 3600000 - 3600000;
  const candles = Array.from({ length: 240 }, (_, index) => {
    const close = 100 + index * 0.2 + Math.sin(index / 7) * 0.03;
    return {
      time: lastClosed - ((239 - index) * 3600000),
      open: close - 0.04,
      high: close + 0.08,
      low: close - 0.08,
      close,
      volume: 1000 + (index % 5) * 10
    };
  });
  const audit = auditCandles(candles, 3600000, now, 150);
  const result = classifyMarketRegime(audit, 3600000);
  assert.equal(result.status, "classified");
  assert.equal(result.regime, "TRENDING_UP");
  assert.equal(result.direction, "UP");
  assert.ok(result.directional_efficiency_24 > 0.8);
  assert.ok(result.evidence.includes("adx_directional_strength"));
  assert.equal(result.method, "rule_based_closed_ohlcv_regime_v1");
  assert.ok(result.caveat.includes("not forecasts"));
});

test("market regime classifier distinguishes quiet choppy/range conditions from volatility expansion", () => {
  const now = Date.now();
  const lastClosed = Math.floor(now / 3600000) * 3600000 - 3600000;
  const flat = Array.from({ length: 240 }, (_, index) => {
    const close = 100 + Math.sin(index * 1.7) * 0.08;
    return {
      time: lastClosed - ((239 - index) * 3600000),
      open: close - 0.01,
      high: close + 0.1,
      low: close - 0.1,
      close,
      volume: 1000
    };
  });
  const flatAudit = auditCandles(flat, 3600000, now, 150);
  const flatResult = classifyMarketRegime(flatAudit);
  assert.ok(["CHOPPY", "RANGING"].includes(flatResult.regime));

  const volatile = flat.map((bar, index) => index > 225 ? {
    ...bar,
    high: bar.close + 2.5,
    low: bar.close - 2.5
  } : bar);
  const volatileAudit = auditCandles(volatile, 3600000, now, 150);
  const volatileResult = classifyMarketRegime(volatileAudit);
  assert.equal(volatileResult.regime, "HIGH_VOLATILITY");
  assert.ok(volatileResult.atr_percentile_lookback >= 90 ||
    volatileResult.atr_expansion_ratio >= 1.8);
});

test("market regime classifier fails closed for missing, invalid and discontinuous candle data", () => {
  assert.equal(classifyMarketRegime(null).regime, "UNCLASSIFIED");
  const now = Date.now();
  const broken = makeCandles(100, 3600000, now - (101 * 3600000));
  broken.splice(25, 1);
  const result = classifyMarketRegime(auditCandles(broken, 3600000, now, 80));
  assert.equal(result.status, "unavailable");
  assert.equal(result.regime, "UNCLASSIFIED");
});


test("BTC-led market context requires fresh breadth and blocks risk-off regimes", () => {
  const now = Date.now();
  const row = (symbol, oneHour, sixHour, age = 1000) => ({
    symbol, status: "live", market_data_provider: "coinbase_exchange", ticker_time: new Date(now - age).toISOString(),
    primary: { regime: oneHour }, higher: { regime: sixHour }
  });
  const riskOn = assessCrossMarketContext([
    row("BTC/USD", "UPTREND", "UPTREND"),
    row("ETH/USD", "UPTREND", "RANGE_OR_TRANSITION"),
    row("SOL/USD", "RANGE_OR_TRANSITION", "UPTREND")
  ], now);
  assert.equal(riskOn.status, "verified");
  assert.equal(riskOn.mode, "RISK_ON");
  assert.equal(riskOn.allowed_for_long_entries, true);
  assert.equal(riskOn.breadth_1h.uptrend, 2);
  assert.equal(riskOn.breadth_6h.uptrend, 2);

  const riskOff = assessCrossMarketContext([
    row("BTC/USD", "UPTREND", "DOWNTREND"),
    row("ETH/USD", "UPTREND", "UPTREND"),
    row("SOL/USD", "UPTREND", "UPTREND")
  ], now);
  assert.equal(riskOff.mode, "RISK_OFF");
  assert.equal(riskOff.allowed_for_long_entries, false);

  const isolatedAltVolatility = assessCrossMarketContext([
    row("BTC/USD", "UPTREND", "UPTREND"),
    row("ETH/USD", "UPTREND", "HIGH_VOLATILITY"),
    row("SOL/USD", "UPTREND", "UPTREND")
  ], now);
  assert.equal(isolatedAltVolatility.mode, "RISK_ON");
  assert.equal(isolatedAltVolatility.allowed_for_long_entries, true);

  const broadVolatility = assessCrossMarketContext([
    row("BTC/USD", "UPTREND", "UPTREND"),
    row("ETH/USD", "HIGH_VOLATILITY", "UPTREND"),
    row("SOL/USD", "UPTREND", "HIGH_VOLATILITY")
  ], now);
  assert.equal(broadVolatility.mode, "RISK_OFF");
  assert.equal(broadVolatility.reason, "market_volatility_expansion");

  const stale = assessCrossMarketContext([
    row("BTC/USD", "UPTREND", "UPTREND"),
    row("ETH/USD", "UPTREND", "UPTREND", 180000),
    row("SOL/USD", "UPTREND", "UPTREND")
  ], now);
  assert.equal(stale.status, "unavailable");
  assert.equal(stale.mode, "BLOCKED");
  assert.equal(stale.allowed_for_long_entries, false);
});


test("legacy Bitstamp exit snapshots cannot influence cross-market entry context", () => {
  const now = Date.now();
  const rows = [
    { symbol: "BTC/USD", status: "live", market_data_provider: "coinbase_exchange",
      ticker_time: new Date(now - 1000).toISOString(), primary: { regime: "UPTREND" }, higher: { regime: "UPTREND" } },
    { symbol: "ETH/USD", status: "live", market_data_provider: "coinbase_exchange",
      ticker_time: new Date(now - 1000).toISOString(), primary: { regime: "UPTREND" }, higher: { regime: "UPTREND" } },
    { symbol: "SOL/USD", status: "live", market_data_provider: "bitstamp_spot",
      ticker_time: new Date(now - 1000).toISOString(), primary: { regime: "UPTREND" }, higher: { regime: "UPTREND" } }
  ];
  const result = assessCrossMarketContext(rows, now);
  assert.equal(result.status, "unavailable");
  assert.equal(result.mode, "BLOCKED");
  assert.deepEqual(result.missing_symbols, ["SOL/USD"]);
  assert.equal(result.allowed_for_long_entries, false);
});

test("production candidate gate enforces BTC-led market context when supplied", () => {
  const now = Date.now();
  const market = {
    status: "live", market_data_provider: "coinbase_exchange", ticker_time: new Date(now).toISOString(), quote_received_at_ms: now - 1000,
    bid: 100, ask: 100.01, last: 100, quote_volume_usd: 5000000,
    bid_depth_quote: 10000, ask_depth_quote: 10000, book_retrieved_at_ms: now - 1000
  };
  const primary = {
    signal: "BUY_CANDIDATE", score: 90, regime: "UPTREND",
    last_closed_candle_ms: now - 3600000, atr_pct: 2, rsi14: 55,
    adx14: 30, plus_di14: 40, minus_di14: 10
  };
  const higher = { regime: "UPTREND", last_closed_candle_ms: now - 21600000 };
  const costs = { feeBpsPerSide: 15, slippageBps: 10 };
  const cautious = { status: "verified", mode: "CAUTIOUS", allowed_for_long_entries: false };
  const riskOn = { status: "verified", mode: "RISK_ON", allowed_for_long_entries: true };
  const blocked = { status: "unavailable", mode: "BLOCKED", allowed_for_long_entries: false };
  assert.equal(assessCandidate({ market, primary, higher, nowMs: now, costs, marketContext: cautious }).reason,
    "cross_market_regime_cautious");
  assert.equal(assessCandidate({ market, primary, higher, nowMs: now, costs, marketContext: blocked }).reason,
    "cross_market_context_unavailable");
  assert.equal(assessCandidate({ market, primary, higher, nowMs: now, costs, marketContext: riskOn }).eligible, true);
});


test("live timeframe analysis reacts to ATR percentile expansion before the absolute 8% threshold", () => {
  const interval = 3600000;
  const now = Date.now();
  const lastClosed = Math.floor(now / interval) * interval - interval;
  const candles = Array.from({ length: 220 }, (_, index) => {
    const close = 100 + index * 0.05;
    const range = index < 190 ? 0.12 : 1.1;
    return {
      time: lastClosed - ((219 - index) * interval),
      open: close - 0.01,
      high: close + range,
      low: close - range,
      close,
      volume: 1000 + (index % 5) * 10
    };
  });
  const audit = auditCandles(candles, interval, now, 150);
  assert.equal(audit.ok, true);
  const result = analyzeTimeframe(audit);
  assert.ok(result.atr_pct < 8, "test must remain below the absolute emergency threshold");
  assert.equal(result.regime, "HIGH_VOLATILITY");
  assert.equal(result.volatility_expanded, true);
  assert.ok(result.atr_expansion_ratio >= 1.8 || result.atr_percentile_lookback >= 90);
});
