import test from "node:test";
import assert from "node:assert/strict";
import { buildResearchHistorySummary, countMissingArchiveBars, selectNewClosedCandles } from "../src/research.js";

const HOUR = 60 * 60 * 1000;

test("archive selector stores only aligned, new, fully closed candles", () => {
  const rows = [
    { time: 0 }, { time: HOUR }, { time: 2 * HOUR },
    { time: 3 * HOUR }, { time: 3 * HOUR + 1 }, { time: 9 * HOUR }
  ];
  const selected = selectNewClosedCandles(rows, 0, HOUR, 3.5 * HOUR);
  assert.deepEqual(selected.map((row) => row.time), [HOUR, 2 * HOUR]);
});

test("archive gap counter distinguishes contiguous and skipped intervals", () => {
  assert.equal(countMissingArchiveBars(10 * HOUR, [{ time: 11 * HOUR }], HOUR), 0);
  assert.equal(countMissingArchiveBars(10 * HOUR, [{ time: 13 * HOUR }], HOUR), 2);
  assert.equal(countMissingArchiveBars(10 * HOUR, [{ time: 11 * HOUR + 1 }], HOUR), null);
  assert.equal(countMissingArchiveBars(null, [{ time: 11 * HOUR }], HOUR), 0);
});

test("history summary reports coverage, retained gaps, cumulative gaps and freshness", () => {
  const now = 10 * HOUR;
  const [summary] = buildResearchHistorySummary([{
    product: "BTC-USD",
    timeframe_seconds: 3600,
    bars_count: 3,
    first_candle_ms: 0,
    last_candle_ms: 3 * HOUR,
    cumulative_missing_intervals: 2,
    last_quality_status: "clean",
    last_quality_check_at_ms: now,
    last_ingested_at_ms: now - 100
  }], now);
  assert.equal(summary.symbol, "BTC/USD");
  assert.equal(summary.timeframe, "1H");
  assert.equal(summary.bars_count, 3);
  assert.equal(summary.coverage_days, 1 / 6);
  assert.equal(summary.retained_missing_intervals, 1);
  assert.equal(summary.cumulative_missing_intervals, 2);
  assert.equal(summary.latest_age_minutes, 60);
  assert.equal(summary.last_quality_status, "clean");
});

test("history summary flags misaligned archive boundaries", () => {
  const [summary] = buildResearchHistorySummary([{
    product: "ETH-USD",
    timeframe_seconds: 21600,
    bars_count: 5,
    first_candle_ms: 0,
    last_candle_ms: 6 * HOUR + 1,
    cumulative_missing_intervals: 0,
    last_quality_status: "clean"
  }], 20 * HOUR);
  assert.equal(summary.last_quality_status, "archive_integrity_error");
  assert.equal(summary.retained_missing_intervals, null);
});

test("empty SQL archive fields remain null instead of becoming epoch timestamps", () => {
  const [summary] = buildResearchHistorySummary([{
    product: "SOL-USD",
    timeframe_seconds: 3600,
    bars_count: 0,
    first_candle_ms: null,
    last_candle_ms: null,
    cumulative_missing_intervals: 0,
    last_quality_check_at_ms: null,
    last_ingested_at_ms: null,
    last_quality_status: "audit_rejected:missing_intervals"
  }], 100 * HOUR);
  assert.equal(summary.first_candle_ms, null);
  assert.equal(summary.last_candle_ms, null);
  assert.equal(summary.latest_closed_at_ms, null);
  assert.equal(summary.last_quality_check_at_ms, null);
  assert.equal(summary.last_ingested_at_ms, null);
  assert.equal(summary.coverage_days, 0);
  assert.equal(summary.last_quality_status, "audit_rejected:missing_intervals");
});

test("empty and invalid history inputs are safe", () => {
  assert.deepEqual(buildResearchHistorySummary([], 123), []);
  assert.deepEqual(buildResearchHistorySummary(null, 123), []);
  assert.deepEqual(selectNewClosedCandles(null, null, HOUR, 123), []);
});
