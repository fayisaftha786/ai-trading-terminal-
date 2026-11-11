import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const engine = readFileSync(new URL("../src/engine.js", import.meta.url), "utf8");

test("full scheduled scan records fresh entry-book timestamps before evaluating entry gates", () => {
  const fetchStart = engine.indexOf("const finalBookRequestState = createCoinbaseRequestState();");
  const gateStart = engine.indexOf("market.entry_gate = assessCandidate(", fetchStart);
  const fetchFlow = engine.slice(fetchStart, gateStart);
  assert.ok(fetchStart >= 0 && gateStart > fetchStart);
  assert.ok(fetchFlow.includes("market.entry_scan_book_retrieved_at_ms"));
  assert.ok(fetchFlow.includes('market.entry_scan_book_status = "available"'));
  assert.ok(fetchFlow.includes('market.entry_scan_book_status = "provider_error"'));
  assert.ok(fetchFlow.includes("lastEntryBookRetrievedAtMs"));
});

test("full-scan entry-book telemetry is separate from position-exit L2 refresh telemetry", () => {
  const automationStart = engine.indexOf("  automationStatus() {");
  const automationEnd = engine.indexOf("  dashboard() {", automationStart);
  const automation = engine.slice(automationStart, automationEnd);
  assert.ok(automation.includes("last_entry_scan_book_at_ms"));
  assert.ok(automation.includes("last_entry_scan_book_age_ms"));
  assert.ok(automation.includes("last_entry_scan_book_status"));
  assert.ok(automation.includes("position_exit_book_refresh_scope"));
  assert.ok(automation.includes("last_book_refresh_at_ms"));
  assert.ok(automation.includes("last_book_refresh_age_ms"));
});

test("scheduled scan runtime stores entry-book success, failure, and skip counts", () => {
  assert.ok(engine.includes("last_entry_scan_book_success_count: entryBookSuccessCount"));
  assert.ok(engine.includes("last_entry_scan_book_failed_count: entryBookFailedCount"));
  assert.ok(engine.includes("last_entry_scan_book_skipped_count: entryBookSkippedCount"));
});

test("invalid entry-book retrieval timestamps fail closed instead of receiving a fabricated fresh timestamp", () => {
  const start = engine.indexOf("const finalBookRequestState = createCoinbaseRequestState();");
  const end = engine.indexOf("market.entry_scan_book_status = \"available\"", start);
  const section = engine.slice(start, end);
  assert.ok(section.includes("invalid_entry_book_retrieval_timestamp"));
  assert.match(section, /!Number\.isFinite\(entryBookRetrievedAtMs\)/);
  assert.match(section, /entryBookRetrievedAtMs <= 0/);
  assert.match(section, /entryBookRetrievedAtMs > Date\.now\(\)/);
  assert.ok(section.indexOf("throw invalidTimestamp") < section.indexOf("Object.assign(market, freshBook)"));
  assert.doesNotMatch(section, /entryBookRetrievedAtMs : Date\.now\(\)/);
});
