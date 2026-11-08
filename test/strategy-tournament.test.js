import test from "node:test";
import assert from "node:assert/strict";
import { runStrategyTournament, runWalkForwardResearch } from "../src/strategy-tournament.js";

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
  assert.equal(runStrategyTournament({ candles1h: broken, candles6h: sixHour }).reason,
    "insufficient_clean_history");
});

test("tournament uses next-bar fills and reports cost assumptions", () => {
  const oneHour = makeSeries(360, 3600000, 0, 0.04, 1.2);
  const sixHour = makeSeries(100, 21600000, 0, 0.25, 1.5);
  const result = runStrategyTournament({
    candles1h: oneHour, candles6h: sixHour, startIndex: 100
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "offline_research_only");
  assert.equal(result.assumptions.next_bar_open_fills, true);
  assert.equal(result.assumptions.intrabar_stop_target_conflict, "stop_first");
  assert.deepEqual(Object.keys(result.strategies).sort(), [
    "breakout_continuation", "range_mean_reversion", "trend_continuation"
  ]);
  for (const strategy of Object.values(result.strategies)) {
    assert.ok(Number.isFinite(strategy.net_return_pct));
    assert.ok(Number.isFinite(strategy.max_drawdown_pct));
    assert.ok(strategy.trade_count >= 0);
  }
});

test("walk-forward evaluation is chronological and includes a final untouched holdout", () => {
  const oneHour = makeSeries(420, 3600000, 0, 0.03, 1.5);
  const sixHour = makeSeries(100, 21600000, 0, 0.15, 2);
  const result = runWalkForwardResearch({ candles1h: oneHour, candles6h: sixHour });
  assert.equal(result.ok, true);
  assert.equal(result.validation, "chronological_non_overlapping_folds_no_random_shuffle");
  assert.equal(result.folds.length, 4);
  assert.equal(result.folds[3].name, "untouched_holdout");
  assert.equal(result.cost_stress.length, 3);
  assert.deepEqual(result.cost_stress.map((row) => row.cost_multiplier), [1, 1.5, 2]);
  assert.ok(result.folds[0].end_index_exclusive <= result.folds[1].start_index);
});

test("walk-forward refuses a short current archive instead of overclaiming validation", () => {
  const oneHour = makeSeries(299, 3600000, 0);
  const sixHour = makeSeries(80, 21600000, 0);
  const result = runWalkForwardResearch({ candles1h: oneHour, candles6h: sixHour });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "need_at_least_300_clean_1h_and_50_clean_6h_bars");
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
