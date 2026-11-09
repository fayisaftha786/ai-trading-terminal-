import test from "node:test";
import assert from "node:assert/strict";
import { summarizePaperExecution } from "../src/execution-audit.js";

test("execution audit reports only available spread and modeled cost samples", () => {
  const result = summarizePaperExecution([
    { status: "CLOSED", metadata: { entry_quote_bid: 99.9, entry_quote_ask: 100.1, entry_slippage_bps: 10, exit_slippage_bps: 10, round_trip_cost_bps: 142 } },
    { status: "OPEN", metadata: { spread_bps: 4, slippage_bps: 12, round_trip_cost_bps: 150 } }
  ]);
  assert.equal(result.scope_count, 2);
  assert.equal(result.sample_count, 2);
  assert.equal(result.entry_spread_sample_count, 2);
  assert.equal(result.average_entry_spread_bps, 12);
  assert.equal(result.average_entry_slippage_bps, 11);
  assert.equal(result.average_exit_slippage_bps, 10);
  assert.equal(result.average_estimated_round_trip_cost_bps, 146);
  assert.match(result.note, /no exchange order fills/);
});

test("execution audit keeps missing legacy metrics null rather than inventing them", () => {
  const result = summarizePaperExecution([
    { status: "CLOSED", metadata: {} },
    { status: "OPEN", metadata_json: "invalid-json" },
    { status: "CLOSED", metadata: { entry_slippage_bps: null, exit_slippage_bps: null, round_trip_cost_bps: null, spread_bps: null } },
    null
  ]);
  assert.equal(result.scope_count, 2);
  assert.equal(result.average_entry_spread_bps, null);
  assert.equal(result.average_entry_slippage_bps, null);
  assert.equal(result.average_exit_slippage_bps, null);
  assert.equal(result.average_estimated_round_trip_cost_bps, null);
  assert.equal(result.entry_spread_sample_count, 0);
  assert.equal(result.entry_slippage_sample_count, 0);
  assert.equal(result.exit_slippage_sample_count, 0);
  assert.equal(result.round_trip_cost_sample_count, 0);
});

test("execution audit safely handles empty and malformed input", () => {
  assert.equal(summarizePaperExecution(null).scope_count, 0);
  assert.equal(summarizePaperExecution([]).average_entry_spread_bps, null);
});
