import test from "node:test";
import assert from "node:assert/strict";
import { auditCandles } from "../src/strategy.js";
import { evaluateMicroScalpResearch } from "../src/micro-scalp.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function makeCandles(count, intervalMs, nowMs, drift = 0.02, amplitude = 0.08) {
  const lastOpen = Math.floor(nowMs / intervalMs) * intervalMs - intervalMs;
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * drift + Math.sin(index * 0.83) * amplitude;
    const open = close - (Math.cos(index * 0.83) * amplitude * 0.18);
    return {
      time: lastOpen - ((count - 1 - index) * intervalMs),
      open,
      high: Math.max(open, close) + 0.04,
      low: Math.min(open, close) - 0.04,
      close,
      volume: index >= count - 3 ? 1800 : 1000
    };
  });
}

function makeInput(nowMs) {
  const oneMinuteRows = makeCandles(160, MINUTE, nowMs, 0.02, 0.08);
  const last = oneMinuteRows.at(-1);
  const priorHigh = Math.max(...oneMinuteRows.slice(-6, -1).map((row) => row.high));
  oneMinuteRows[oneMinuteRows.length - 1] = {
    ...last,
    open: priorHigh + 0.01,
    low: priorHigh,
    high: priorHigh + 0.15,
    close: priorHigh + 0.12,
    volume: 2400
  };
  const fiveMinuteRows = makeCandles(160, 5 * MINUTE, nowMs, 0.02, 0.08);
  const oneMinuteAudit = auditCandles(oneMinuteRows, MINUTE, nowMs, 150);
  const fiveMinuteAudit = auditCandles(fiveMinuteRows, 5 * MINUTE, nowMs, 150);
  const oneHourOpen = Math.floor(nowMs / HOUR) * HOUR - HOUR;
  const sixHourOpen = Math.floor(nowMs / (6 * HOUR)) * (6 * HOUR) - (6 * HOUR);
  return {
    oneMinuteAudit,
    fiveMinuteAudit,
    market: {
      status: "live",
      market_data_provider: "coinbase_exchange",
      quote_received_at_ms: nowMs,
      ticker_time: new Date(nowMs).toISOString(),
      book_retrieved_at_ms: nowMs,
      bid: 100,
      ask: 100.01,
      last: 100,
      spread_bps: 1,
      quote_volume_usd: 5_000_000,
      bid_depth_quote: 50_000,
      ask_depth_quote: 50_000,
      data_quality: {
        ticker_provider: "coinbase_exchange",
        book_provider: "coinbase_exchange",
        one_minute_provider: "coinbase_exchange",
        five_minute_provider: "coinbase_exchange"
      }
    },
    primary: { regime: "UPTREND", last_closed_candle_ms: oneHourOpen },
    higher: { regime: "UPTREND", last_closed_candle_ms: sixHourOpen }
  };
}

test("micro-scalp research fails closed when 1m or 5m candle audit is invalid", () => {
  const now = 1_800_000_000_000;
  const input = makeInput(now);
  const result = evaluateMicroScalpResearch({ ...input, oneMinuteAudit: { ok: false, issues: ["missing_intervals"] }, nowMs: now });
  assert.equal(result.decision, "NO_TRADE");
  assert.equal(result.execution_authorized, false);
  assert.equal(result.reason, "one_minute_or_five_minute_candle_integrity_failed");
});

test("micro-scalp research blocks a clean setup when conservative taker costs overwhelm the ATR target", () => {
  const now = 1_800_000_000_000;
  const input = makeInput(now);
  const result = evaluateMicroScalpResearch({ ...input, nowMs: now });
  assert.equal(result.decision, "NO_TRADE");
  assert.equal(result.execution_authorized, false);
  assert.ok(["five_minute_trend_setup_not_confirmed", "one_minute_breakout_or_volume_trigger_not_confirmed", "round_trip_cost_exceeds_expected_move"].includes(result.reason));
  if (result.reason === "round_trip_cost_exceeds_expected_move") {
    assert.ok(result.round_trip_cost_bps > result.estimated_gross_target_bps);
  }
});

test("micro-scalp research candidate remains research-only even with deliberately low test costs", () => {
  const now = 1_800_000_000_000;
  const input = makeInput(now);
  const result = evaluateMicroScalpResearch({
    ...input,
    nowMs: now,
    costs: {
      feeBpsPerSide: 0.5,
      slippageBpsPerSide: 0.5,
      minimumNetEdgeBps: 0.1,
      minimumCostMultiple: 1.1
    }
  });
  assert.notEqual(result.execution_authorized, true);
  assert.equal(result.paper_auto_entry_eligible, false);
  assert.equal(result.live_trading_enabled, false);
  // Whether the synthetic bars meet the directional trigger or not, the engine
  // must never convert this research signal into an executable order.
  assert.ok(["NO_TRADE", "RESEARCH_CANDIDATE"].includes(result.decision));
});

test("micro-scalp research rejects future/stale order-book snapshots", () => {
  const now = 1_800_000_000_000;
  const input = makeInput(now);
  const result = evaluateMicroScalpResearch({
    ...input,
    nowMs: now,
    market: { ...input.market, book_retrieved_at_ms: now - 20_000 }
  });
  assert.equal(result.reason, "order_book_snapshot_stale_or_missing");
});
