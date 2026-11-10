import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const engine = readFileSync(new URL("../src/engine.js", import.meta.url), "utf8");

test("Coinbase connection reports scheduled read-only reconciliation health", () => {
  assert.match(engine, /coinbaseBackgroundReconciliationStatus\(\)/);
  assert.match(engine, /background_reconciliation: this\.coinbaseBackgroundReconciliationStatus\(\)/);
  assert.match(engine, /scheduled_read_only_order_and_fill_reconciliation/);
  assert.match(engine, /live_order_submission_by_scheduler: false/);
});

test("scheduled Coinbase reconciliation includes open orders and retries incomplete terminal fill syncs", () => {
  assert.match(engine, /"SUBMITTING", "UNKNOWN", "PENDING", "OPEN", "QUEUED"/);
  assert.match(engine, /"FILLED", "CANCELLED", "CANCELED", "EXPIRED", "FAILED"/);
  assert.match(engine, /fillStatus === "complete" \|\| fillStatus === "proof_required"/);
  assert.match(engine, /nowMs - lastAttempt >= 5 \* 60 \* 1000/);
  assert.match(engine, /await this\.reconcileAndSyncLiveOrder\(record\)/);
});

test("scheduled reconciliation runs from the Durable Object alarm and cannot submit or cancel orders", () => {
  assert.match(engine, /await this\.reconcileOpenCoinbaseLiveOrders\("scheduled_alarm"\)/);
  assert.doesNotMatch(engine, /reconcileOpenCoinbaseLiveOrders[\s\S]{0,500}submitCoinbaseAdvancedLimitBuy/);
});

test("scheduled reconciliation prioritizes the oldest order check to avoid starvation", () => {
  assert.match(engine, /const lastAttemptAt = \(item\) =>/);
  assert.match(engine, /\.sort\(\(left, right\) => lastAttemptAt\(left\) - lastAttemptAt\(right\)\)\.slice\(0, 3\)/);
});
