import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  runStrategyTournament, runWalkForwardResearch, evaluateWalkForwardEvidence, resolveLongBarExit,
  runTradeOrderMonteCarlo, runRecursiveWarmupAnalysis
} from "../src/strategy-tournament.js";

function makeSeries(count, intervalMs, start, drift = 0.02, wave = 0.8) {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * drift + Math.sin(index / 5) * wave;
    return {
      time: start + index * intervalMs,
      open: close - 0.1,
      high: close + 0.5,
      low: close - 0.5,
      close,
      volume: 1000 + (index % 9) * 50
    };
  });
}

test("tournament rejects insufficient or discontinuous candle history", () => {
  const oneHour = makeSeries(149, 3600000, 0);
  const sixHour = makeSeries(60, 21600000, 0);
  assert.equal(runStrategyTournament({ candles1h: oneHour, candles6h: sixHour }).reason,
    "insufficient_clean_history");
  const broken = makeSeries(160, 3600000, 0);
  broken.splice(80, 1);
  const discontinuous = runStrategyTournament({ candles1h: broken, candles6h: sixHour });
  assert.equal(discontinuous.reason, "invalid_candle_history");
  assert.ok(discontinuous.issues_1h.includes("missing_intervals"));
});

test("tournament rejects malformed, duplicated and off-grid raw candles", () => {
  const oneHour = makeSeries(160, 3600000, 0);
  const sixHour = makeSeries(60, 21600000, 0);

  const malformed = oneHour.slice();
  malformed[30] = { ...malformed[30], volume: null };
  const malformedResult = runStrategyTournament({ candles1h: malformed, candles6h: sixHour });
  assert.equal(malformedResult.reason, "invalid_candle_history");
  assert.ok(malformedResult.issues_1h.includes("invalid_ohlcv"));

  const duplicated = oneHour.slice();
  duplicated[30] = { ...duplicated[30], time: duplicated[29].time };
  const duplicateResult = runStrategyTournament({ candles1h: duplicated, candles6h: sixHour });
  assert.equal(duplicateResult.reason, "invalid_candle_history");
  assert.ok(duplicateResult.issues_1h.includes("duplicate_timestamp"));

  const offGrid = oneHour.slice();
  offGrid[30] = { ...offGrid[30], time: offGrid[30].time + 1 };
  const offGridResult = runStrategyTournament({ candles1h: offGrid, candles6h: sixHour });
  assert.equal(offGridResult.reason, "invalid_candle_history");
  assert.ok(offGridResult.issues_1h.includes("off_grid_timestamp"));

  const negativePrice = oneHour.slice();
  negativePrice[30] = { ...negativePrice[30], close: -1, low: -2 };
  const negativeResult = runStrategyTournament({ candles1h: negativePrice, candles6h: sixHour });
  assert.equal(negativeResult.reason, "invalid_candle_history");
  assert.ok(negativeResult.issues_1h.includes("invalid_ohlcv"));
});

test("tournament uses next-bar fills and reports cost assumptions", () => {
  const oneHour = makeSeries(420, 3600000, 0, 1, 0.2).map((bar, index) => ({
    ...bar, volume: index > 300 ? 2200 : 1000
  }));
  const sixHour = makeSeries(100, 21600000, 0, 5, 0.5);
  const result = runStrategyTournament({
    candles1h: oneHour, candles6h: sixHour, startIndex: 100,
    options: { includeMonteCarlo: true, monteCarloIterations: 100 }
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "offline_research_only");
  assert.equal(result.assumptions.next_bar_open_fills, true);
  assert.equal(result.assumptions.fee_bps_per_side, 60);
  assert.equal(result.assumptions.slippage_bps_per_side, 10);
  assert.equal(result.assumptions.intrabar_stop_target_conflict, "stop_first");
  assert.deepEqual(Object.keys(result.strategies).sort(), [
    "breakout_continuation", "range_mean_reversion", "trend_continuation"
  ]);
  assert.deepEqual(result.cash_no_trade, { net_pnl: 0, net_return_pct: 0 });
  for (const strategy of Object.values(result.strategies)) {
    assert.ok(Number.isFinite(strategy.net_return_pct));
    assert.ok(Number.isFinite(strategy.max_drawdown_pct));
    assert.ok(strategy.trade_count >= 0);
  }
  const breakout = result.strategies.breakout_continuation;
  const breakoutTrades = breakout.trades;
  assert.ok(breakoutTrades.length > 0, "rising breakout fixture should produce trades");
  assert.ok(Date.parse(breakoutTrades[0].entry_time) > Date.parse(breakoutTrades[0].signal_time),
    "a signal at candle close must fill on a later bar");
  assert.ok(breakoutTrades.every((trade) =>
    Number.isFinite(trade.net_return_on_entry_equity_pct) &&
    Number.isFinite(trade.entry_equity_usd)
  ));
  assert.ok(breakout.monte_carlo, "exploratory run should include a Monte Carlo research diagnostic");
  assert.equal(breakout.monte_carlo.status,
    breakout.trade_count >= 30 ? "research_only" : "insufficient_trade_sample");
  assert.ok(Number.isFinite(breakout.intrabar_stop_target_conflict_rate_pct));
});

test("walk-forward evaluation is chronological and includes a final untouched holdout", () => {
  const oneHour = makeSeries(3000, 3600000, 0, 0.03, 1.5);
  const sixHour = makeSeries(500, 21600000, 0, 0.15, 2);
  const result = runWalkForwardResearch({ candles1h: oneHour, candles6h: sixHour });
  assert.equal(result.ok, true);
  assert.equal(result.validation, "chronological_non_overlapping_folds_no_random_shuffle");
  assert.equal(result.folds.length, 4);
  assert.ok(result.approximate_test_days_per_fold >= 28);
  assert.equal(result.folds[3].name, "untouched_holdout");
  assert.equal(result.strategy_samples.trend_continuation.non_overlapping_test_folds, 4);
  assert.equal(result.cost_stress.length, 3);
  assert.deepEqual(result.cost_stress.map((row) => row.cost_multiplier), [1, 1.5, 2]);
  assert.ok(result.folds[0].end_index_exclusive <= result.folds[1].start_index);
});

test("walk-forward refuses history too short for four approximately 28-day test folds", () => {
  const oneHour = makeSeries(2999, 3600000, 0);
  const sixHour = makeSeries(500, 21600000, 0);
  const result = runWalkForwardResearch({ candles1h: oneHour, candles6h: sixHour });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "need_at_least_3000_clean_1h_and_500_clean_6h_bars_for_four_28d_folds");

  const shortHigher = runWalkForwardResearch({
    candles1h: makeSeries(3000, 3600000, 0),
    candles6h: makeSeries(499, 21600000, 0)
  });
  assert.equal(shortHigher.ok, false);
  assert.equal(shortHigher.reason, "need_at_least_3000_clean_1h_and_500_clean_6h_bars_for_four_28d_folds");
});

test("backtest refuses leverage-like allocation and invalid costs", () => {
  const oneHour = makeSeries(320, 3600000, 0);
  const sixHour = makeSeries(80, 21600000, 0);
  const result = runStrategyTournament({
    candles1h: oneHour, candles6h: sixHour,
    options: { allocationPct: 0.5 }
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_backtest_options");
});


test("final forced liquidation costs are reflected in max drawdown", () => {
  const oneHour = makeSeries(420, 3600000, 0, 1, 0.2).map((bar, index) => ({
    ...bar, volume: index > 300 ? 2200 : 1000
  }));
  const sixHour = makeSeries(100, 21600000, 0, 5, 0.5);
  const result = runStrategyTournament({
    candles1h: oneHour,
    candles6h: sixHour,
    startIndex: 100,
    options: { feeBpsPerSide: 1000, slippageBps: 500 }
  });
  assert.equal(result.ok, true);
  const stressed = result.strategies.breakout_continuation;
  assert.ok(stressed.trade_count > 0);
  assert.ok(stressed.net_return_pct < 0);
  assert.ok(stressed.max_drawdown_pct + 0.0001 >= Math.abs(stressed.net_return_pct));
});

test("same-bar stop and target collision resolves to stop first", () => {
  const result = resolveLongBarExit({
    open: 100, high: 106, low: 94, close: 101
  }, 95, 105);
  assert.deepEqual(result, { price: 95, reason: "stop", conflict: true });
  assert.deepEqual(resolveLongBarExit({
    open: 93, high: 101, low: 92, close: 96
  }, 95, 105), { price: 93, reason: "stop_gap", conflict: false });
  assert.deepEqual(resolveLongBarExit({
    open: 106, high: 108, low: 104, close: 107
  }, 95, 105), { price: 105, reason: "target_gap", conflict: false });
});


test("Monte Carlo trade-order and moving-block analysis is deterministic and sample-gated", () => {
  const returns = Array.from({ length: 40 }, (_, index) =>
    index % 5 === 0 ? -0.35 : 0.18
  );
  const options = { iterations: 200, seed: 12345, blockLength: 3, initialEquity: 100 };
  const first = runTradeOrderMonteCarlo(returns, options);
  const second = runTradeOrderMonteCarlo(returns, options);
  assert.equal(first.status, "research_only");
  assert.deepEqual(first, second);
  assert.equal(first.sample_size, 40);
  assert.equal(first.iterations, 200);
  assert.ok(Number.isFinite(first.trade_order_shuffle.p95_max_drawdown_pct));
  assert.ok(Number.isFinite(first.moving_block_bootstrap.p05_net_return_pct));
  assert.ok(Number.isFinite(first.moving_block_bootstrap.probability_of_loss_pct));

  const smallSample = runTradeOrderMonteCarlo(returns.slice(0, 29), options);
  assert.equal(smallSample.status, "insufficient_trade_sample");
  assert.equal(smallSample.iterations, 0);
});

test("invalid Monte Carlo inputs fail closed", () => {
  assert.equal(runTradeOrderMonteCarlo([0.1, Number.NaN], {}).status, "invalid_inputs");
  assert.equal(runTradeOrderMonteCarlo(Array(30).fill(0.1), { iterations: 20 }).status, "invalid_inputs");
});


test("backtest results at a fixed cutoff are invariant to candles that occur later", () => {
  const short1h = makeSeries(700, 3600000, 0, 0.04, 1.1);
  const short6h = makeSeries(120, 21600000, 0, 0.2, 1.7);
  const full1h = makeSeries(1100, 3600000, 0, 0.04, 1.1);
  const full6h = makeSeries(190, 21600000, 0, 0.2, 1.7);

  const prefix = runStrategyTournament({
    candles1h: short1h, candles6h: short6h, startIndex: 100
  });
  const withFutureData = runStrategyTournament({
    candles1h: full1h, candles6h: full6h, startIndex: 100, endIndex: 700
  });

  assert.equal(prefix.ok, true);
  assert.equal(withFutureData.ok, true);
  assert.deepEqual(withFutureData.strategies, prefix.strategies,
    "future OHLCV rows must not alter entries, exits or scores before the fixed cutoff");
  assert.deepEqual(withFutureData.benchmark, prefix.benchmark);
});

test("recursive warmup analysis compares final indicators and signal consistency across startup windows", () => {
  const oneHour = makeSeries(1100, 3600000, 0, 0.03, 1.4);
  const sixHour = makeSeries(240, 21600000, 0, 0.15, 1.9);
  const result = runRecursiveWarmupAnalysis({
    candles1h: oneHour,
    candles6h: sixHour
  });

  assert.equal(result.status, "research_only");
  assert.equal(result.configurations_tested, 5);
  assert.ok(Number.isFinite(result.max_price_indicator_deviation_pct));
  assert.ok(Number.isFinite(result.max_rsi_deviation_points));
  assert.equal(typeof result.signal_consistency, "boolean");
  assert.equal(result.comparisons.length, 4);
  assert.ok(result.reference_window.one_hour_bars > 0);
  assert.ok(result.caveat.includes("not proof"));
});

test("recursive warmup analysis remains inconclusive when fewer than two startup windows exist", () => {
  const result = runRecursiveWarmupAnalysis({
    candles1h: makeSeries(150, 3600000, 0),
    candles6h: makeSeries(50, 21600000, 0)
  });
  assert.equal(result.status, "insufficient_warmup_history");
  assert.equal(result.configurations_tested, 1);
});

test("dashboard walk-forward requirement matches the strict research implementation", () => {
  const dashboard = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(
    dashboard,
    /strict walk-forward validation requires at least 3,000 clean 1H bars and 500 clean 6H bars per asset/i
  );
  assert.match(dashboard, /four non-overlapping 28-day test folds/i);
  assert.match(dashboard, /separate final holdout/i);
  assert.doesNotMatch(dashboard, /requires at least 500 one-hour and 50 six-hour candles/i);
});


test("walk-forward evidence requires broad out-of-sample consistency and stressed costs", () => {
  const fold = (net, profitFactor = 1.4, drawdown = 3, trades = 10) => ({
    ok: true,
    results: {
      trend_continuation: {
        trade_count: trades,
        net_return_pct: net,
        profit_factor: profitFactor,
        max_drawdown_pct: drawdown,
        expectancy_per_trade: 0.2
      }
    }
  });
  const folds = [fold(1.2), fold(0.8), fold(1.1), fold(0.6)];
  const costStress = [
    { cost_multiplier: 1, result: { ok: true, strategies: { trend_continuation: { net_return_pct: 3 } } } },
    { cost_multiplier: 1.5, result: { ok: true, strategies: { trend_continuation: { net_return_pct: 0.5 } } } },
    { cost_multiplier: 2, result: { ok: true, strategies: { trend_continuation: { net_return_pct: -0.2 } } } }
  ];
  const result = evaluateWalkForwardEvidence({ folds, costStress, strategyNames: ["trend_continuation"] });
  const candidate = result.strategies.trend_continuation;
  assert.equal(result.status, "evaluated");
  assert.equal(candidate.eligible_for_shadow_paper_review, true);
  assert.equal(candidate.status, "evidence_positive_shadow_review_only");
  assert.equal(candidate.execution_authorized, false);
  assert.equal(candidate.paper_auto_entry_eligible, false);
  assert.equal(candidate.live_trading_enabled, false);

  const failedStress = evaluateWalkForwardEvidence({
    folds,
    costStress: [{ cost_multiplier: 1.5, result: { ok: true, strategies: { trend_continuation: { net_return_pct: -1 } } } }],
    strategyNames: ["trend_continuation"]
  });
  assert.equal(failedStress.strategies.trend_continuation.eligible_for_shadow_paper_review, false);
  assert.ok(failedStress.strategies.trend_continuation.failed_gates.includes("positive_after_1_5x_fee_and_slippage_stress"));

  const weakHoldout = evaluateWalkForwardEvidence({
    folds: [fold(1.2), fold(0.8), fold(1.1), fold(-0.5)],
    costStress,
    strategyNames: ["trend_continuation"]
  });
  assert.equal(weakHoldout.strategies.trend_continuation.eligible_for_shadow_paper_review, false);
  assert.ok(weakHoldout.strategies.trend_continuation.failed_gates.includes("untouched_holdout_positive"));
});
