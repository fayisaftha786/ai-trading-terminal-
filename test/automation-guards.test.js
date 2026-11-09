import test from "node:test";
import assert from "node:assert/strict";
import {
  assessMarketUniverse,
  advanceUnhealthyScanStreak,
  buildMarketDataProviderDiagnostics,
  assessAdaptiveRisk,
  assessLossCooldown,
  deriveSchedulerStatus,
  normalizeProviderFailureRows,
  normalizeScanIssueRows,
  parseScanIssueSummaries,
  runAfterActiveScan,
  shouldHaltPaperAutomation,
  summarizeCurrentProviderFailures,
  updateTrailingStop
} from "../src/automation-guards.js";

const NOW = Date.parse("2026-11-08T12:00:00.000Z");

function healthyMarket(symbol) {
  const interval = 3600000;
  return {
    symbol,
    status: "live",
    market_data_provider: "coinbase_exchange",
    ticker_time: new Date(NOW - 1000).toISOString(),
    bid: 100,
    ask: 100.01,
    last: 100,
    book_retrieved_at_ms: NOW - 1000,
    bid_depth_quote: 8000,
    ask_depth_quote: 9000,
    one_hour_audit_summary: {
      ok: true, valid_closed_bars: 300, issues: [], last_closed_candle_ms: NOW - (2 * 3600000)
    },
    six_hour_audit_summary: {
      ok: true, valid_closed_bars: 150, issues: [], last_closed_candle_ms: NOW - (2 * 21600000)
    },
    data_quality: {
      ticker_provider: "coinbase_exchange",
      book_provider: "coinbase_exchange",
      one_hour_provider: "coinbase_exchange",
      six_hour_provider: "coinbase_exchange"
    }
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

test("cost-aware trailing stop activates before the dynamic take-profit at realistic fee assumptions", () => {
  const roundTripCostBps = 165;
  const dormant = updateTrailingStop({
    entryPrice: 100, currentStop: 99, previousHighWater: 100,
    currentBid: 102.1, roundTripCostBps
  });
  assert.equal(dormant.ok, true);
  assert.equal(dormant.active, false);
  assert.equal(dormant.stopLoss, 99);

  const activated = updateTrailingStop({
    entryPrice: 100, currentStop: 99, previousHighWater: 100,
    currentBid: 102.4, roundTripCostBps
  });
  assert.equal(activated.active, true);
  assert.ok(activated.stopLoss > 101.65, "stop must exceed estimated round-trip cost break-even");
  assert.ok(activated.stopLoss < 102.4);

  const pullback = updateTrailingStop({
    entryPrice: 100, currentStop: activated.stopLoss,
    previousHighWater: activated.highWaterBid, currentBid: 100.5,
    roundTripCostBps
  });
  assert.equal(pullback.stopLoss, activated.stopLoss);
  assert.equal(pullback.highWaterBid, activated.highWaterBid);
});

test("trailing stop rejects invalid prices and cost assumptions", () => {
  assert.equal(updateTrailingStop({
    entryPrice: 0, currentStop: 99, currentBid: 100
  }).ok, false);
});


test("market-universe gate rejects missing, future and stale latest closed candles", () => {
  const symbols = ["BTC/USD"];
  const missing = healthyMarket("BTC/USD");
  delete missing.one_hour_audit_summary.last_closed_candle_ms;
  assert.ok(assessMarketUniverse([missing], symbols, NOW).issues[0].reason.includes("1h_latest_closed_candle_missing"));

  const future = healthyMarket("BTC/USD");
  future.six_hour_audit_summary.last_closed_candle_ms = NOW - 1000;
  assert.ok(assessMarketUniverse([future], symbols, NOW).issues[0].reason.includes("6h_latest_closed_candle_from_future"));

  const staleOneHour = healthyMarket("BTC/USD");
  staleOneHour.one_hour_audit_summary.last_closed_candle_ms = NOW - (3 * 3600000);
  assert.ok(assessMarketUniverse([staleOneHour], symbols, NOW).issues[0].reason.includes("1h_latest_closed_candle_stale"));

  const staleSixHour = healthyMarket("BTC/USD");
  staleSixHour.six_hour_audit_summary.last_closed_candle_ms = NOW - (15 * 3600000);
  assert.ok(assessMarketUniverse([staleSixHour], symbols, NOW).issues[0].reason.includes("6h_latest_closed_candle_stale"));
});


test("market-universe gate uses recent local quote receipt while preserving exchange timestamp validation", () => {
  const market = healthyMarket("BTC/USD");
  market.ticker_time = new Date(NOW - 5 * 60 * 1000).toISOString();
  market.quote_received_at_ms = NOW - 1000;
  const entryGate = assessMarketUniverse([market], ["BTC/USD"], NOW);
  assert.equal(entryGate.healthy, false);
  assert.ok(entryGate.issues[0].reason.includes("ticker_stale_or_timestamp_invalid"));

  const staleReceipt = { ...market, quote_received_at_ms: NOW - 121000 };
  assert.ok(assessMarketUniverse([staleReceipt], ["BTC/USD"], NOW).issues[0].reason.includes("ticker_stale"));

  const futureEvent = { ...market, ticker_time: new Date(NOW + 6000).toISOString() };
  assert.ok(assessMarketUniverse([futureEvent], ["BTC/USD"], NOW).issues[0].reason.includes("ticker_stale"));
});


test("provider snapshot failures report the provider reason and skip quote/order-book noise", () => {
  const failed = {
    symbol: "SOL/USD",
    status: "error",
    error_code: "provider_rate_limited",
    bid: null,
    ask: null,
    ticker_time: null
  };
  const result = assessMarketUniverse([failed], ["SOL/USD"], NOW);
  assert.equal(result.healthy, false);
  assert.deepEqual(result.issues, [
    { symbol: "SOL/USD", reason: "provider_unavailable:provider_rate_limited" }
  ]);
});


test("market-universe gate rejects mixed or missing data-provider provenance", () => {
  const symbol = "BTC/USD";
  const mixed = healthyMarket(symbol);
  mixed.data_quality.six_hour_provider = "bitstamp_spot";
  const mixedResult = assessMarketUniverse([mixed], [symbol], NOW);
  assert.ok(mixedResult.issues[0].reason.includes("market_data_provider_mismatch"));

  const missing = healthyMarket(symbol);
  delete missing.market_data_provider;
  const missingResult = assessMarketUniverse([missing], [symbol], NOW);
  assert.ok(missingResult.issues[0].reason.includes("market_data_provider_missing"));
});


test("scan diagnostics recover SOL provider issues from legacy stored summary strings", () => {
  const runtime = {
    last_scan_error: "SOL/USD: provider_unavailable,ticker_stale_or_timestamp_invalid,orderbook_snapshot_stale_or_missing,",
    last_scheduled_scan_error: "SOL/USD: provider_unavailable,ticker_stale_or_timestamp_invalid,orderbook_snapshot_stale_or_missing,"
  };
  const issues = normalizeScanIssueRows(runtime);
  assert.deepEqual(issues, [{
    symbol: "SOL/USD",
    reason: "provider_unavailable,ticker_stale_or_timestamp_invalid,orderbook_snapshot_stale_or_missing,"
  }]);
  assert.deepEqual(normalizeProviderFailureRows(runtime, issues), [{
    symbol: "SOL/USD",
    reason: "provider_unavailable,ticker_stale_or_timestamp_invalid,orderbook_snapshot_stale_or_missing,",
    primary_error_code: null,
    backup_error_code: null,
    inferred_from_scan_summary: true
  }]);
});

test("diagnostic parser handles multiple markets, deduplicates and respects real stored issue rows", () => {
  assert.deepEqual(parseScanIssueSummaries(
    "BTC/USD: spread_too_wide;SOL/USD: provider_unavailable",
    "SOL/USD: provider_unavailable;ETH/USD: orderbook_snapshot_stale_or_missing"
  ), [
    { symbol: "BTC/USD", reason: "spread_too_wide" },
    { symbol: "SOL/USD", reason: "provider_unavailable" },
    { symbol: "ETH/USD", reason: "orderbook_snapshot_stale_or_missing" }
  ]);

  assert.deepEqual(normalizeScanIssueRows({
    market_feed_issues: [{ symbol: "SOL/USD", reason: "provider_unavailable" }],
    last_scan_error: "BTC/USD: stale"
  }), [{ symbol: "SOL/USD", reason: "provider_unavailable" }]);
});


test("market-universe gate validates exchange-side Bitstamp book timestamp as well as retrieval time", () => {
  const market = healthyMarket("SOL/USD");
  market.market_data_provider = "bitstamp_spot";
  market.data_quality = {
    ticker_provider: "bitstamp_spot",
    book_provider: "bitstamp_spot",
    one_hour_provider: "bitstamp_spot",
    six_hour_provider: "bitstamp_spot"
  };
  market.book_event_time_ms = NOW - 16000;
  const stale = assessMarketUniverse([market], ["SOL/USD"], NOW);
  assert.ok(stale.issues[0].reason.includes("orderbook_exchange_timestamp_stale_or_missing"));

  market.book_event_time_ms = NOW - 1000;
  const fresh = assessMarketUniverse([market], ["SOL/USD"], NOW);
  assert.equal(fresh.healthy, true);

  delete market.book_event_time_ms;
  const missing = assessMarketUniverse([market], ["SOL/USD"], NOW);
  assert.ok(missing.issues[0].reason.includes("orderbook_exchange_timestamp_stale_or_missing"));
});


test("provider diagnostics are derived from current snapshots and preserve future timestamp evidence", () => {
  const market = healthyMarket("SOL/USD");
  market.market_data_provider = "bitstamp_spot";
  market.data_quality = {
    ticker_provider: "bitstamp_spot",
    book_provider: "bitstamp_spot",
    one_hour_provider: "bitstamp_spot",
    six_hour_provider: "bitstamp_spot",
    failover_used: true,
    primary_provider_error: "provider_rate_limited",
    book_status: "available",
    book_freshness_source: "local_retrieval_time"
  };
  market.quote_received_at_ms = NOW - 1000;
  market.book_retrieved_at_ms = NOW - 500;
  market.book_event_time_ms = NOW + 1000;
  market.one_hour_audit_summary.last_closed_candle_ms = NOW - 3600000;
  market.six_hour_audit_summary.last_closed_candle_ms = NOW - 21600000;

  const rows = buildMarketDataProviderDiagnostics([market], NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, "bitstamp_spot");
  assert.equal(rows[0].failover_used, true);
  assert.equal(rows[0].primary_provider_error, "provider_rate_limited");
  assert.equal(rows[0].quote_age_ms, 1000);
  assert.equal(rows[0].book_age_ms, 500);
  assert.equal(rows[0].book_event_age_ms, -1000, "future book event timestamps must remain visible");
  assert.equal(rows[0].one_hour_closed_age_ms, 0);
  assert.equal(rows[0].six_hour_closed_age_ms, 0);
  assert.equal(rows[0].market_candidate_eligible, false);

  const missing = healthyMarket("ETH/USD");
  delete missing.one_hour_audit_summary.last_closed_candle_ms;
  const missingRows = buildMarketDataProviderDiagnostics([missing], NOW);
  assert.equal(missingRows[0].one_hour_closed_age_ms, null);
});

test("current provider failure diagnostics include selected endpoint failures, not just scan errors", () => {
  const market = healthyMarket("SOL/USD");
  market.data_quality.book_status = "provider_error";
  market.data_quality.book_error = "provider_timeout";
  const failures = summarizeCurrentProviderFailures([market]);
  assert.deepEqual(failures, [{ symbol: "SOL/USD", reason: "provider_timeout" }]);

  market.status = "error";
  market.error_code = "all_market_data_providers_unavailable";
  market.primary_error_code = "provider_rate_limited";
  market.backup_error_code = "provider_server_error";
  assert.deepEqual(summarizeCurrentProviderFailures([market]), [
    {
      symbol: "SOL/USD",
      reason: "all_market_data_providers_unavailable",
      primary_error_code: "provider_rate_limited",
      backup_error_code: "provider_server_error"
    },
    { symbol: "SOL/USD", reason: "provider_timeout" }
  ]);
});


test("scheduled scan waits for in-flight manual scan instead of reusing it as a scheduled result", async () => {
  let releaseManual;
  let activeScan = null;
  const manualScan = new Promise((resolve) => { releaseManual = resolve; });
  activeScan = manualScan.finally(() => { activeScan = null; });
  let scheduledStarted = false;

  const scheduled = runAfterActiveScan(
    () => activeScan,
    () => {
      scheduledStarted = true;
      activeScan = null;
      return { source: "scheduled", market_feed: { healthy: true } };
    }
  );

  assert.equal(scheduledStarted, false);
  releaseManual({ source: "manual", market_feed: { healthy: true } });
  const result = await scheduled;
  assert.equal(scheduledStarted, true);
  assert.equal(result.source, "scheduled");
});

test("scheduled scan still runs after an in-flight manual scan rejects", async () => {
  let activeScan = null;
  const failedManualScan = Promise.reject(new Error("manual provider failure"));
  activeScan = failedManualScan.finally(() => { activeScan = null; });
  const result = await runAfterActiveScan(
    () => activeScan,
    () => {
      activeScan = null;
      return { source: "scheduled" };
    }
  );
  assert.deepEqual(result, { source: "scheduled" });
});


test("market-universe gate rejects unknown provider identifiers even when all fields agree", () => {
  const market = healthyMarket("BTC/USD");
  market.market_data_provider = "unknown_exchange";
  market.data_quality = {
    ticker_provider: "unknown_exchange",
    book_provider: "unknown_exchange",
    one_hour_provider: "unknown_exchange",
    six_hour_provider: "unknown_exchange"
  };
  const result = assessMarketUniverse([market], ["BTC/USD"], NOW);
  assert.ok(result.issues[0].reason.includes("market_data_provider_unsupported"));
});
