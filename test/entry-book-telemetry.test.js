import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const engine = readFileSync(new URL("../src/engine.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("full scheduled scan records a validated entry-book timestamp before entry gates", () => {
  const fetchStart = engine.indexOf("const finalBookRequestState = createCoinbaseRequestState();");
  const gateStart = engine.indexOf("market.entry_gate = assessCandidate(", fetchStart);
  const fetchFlow = engine.slice(fetchStart, gateStart);
  assert.ok(fetchStart >= 0 && gateStart > fetchStart);
  assert.ok(fetchFlow.includes("validateEntryBookRetrievalTimestamp"));
  assert.ok(fetchFlow.includes("market.entry_scan_book_retrieved_at_ms"));
  assert.ok(fetchFlow.includes('market.entry_scan_book_status = "available"'));
  assert.ok(fetchFlow.includes('market.entry_scan_book_status = "provider_error"'));
  assert.ok(fetchFlow.includes("lastEntryBookRetrievedAtMs"));
  assert.ok(fetchFlow.indexOf("validateEntryBookRetrievalTimestamp") <
    fetchFlow.indexOf("Object.assign(market, freshBook)"));
});

test("entry-scan and position-exit book telemetry remain separate in engine response", () => {
  const start = engine.indexOf("  automationStatus() {");
  const end = engine.indexOf("  dashboard() {", start);
  const automation = engine.slice(start, end);
  for (const key of [
    "last_entry_scan_book_at_ms", "last_entry_scan_book_age_ms",
    "last_entry_scan_book_status", "last_entry_scan_book_success_count",
    "last_entry_scan_book_failed_count", "last_entry_scan_book_skipped_count",
    "position_exit_book_refresh_scope", "last_book_refresh_at_ms", "last_book_refresh_age_ms"
  ]) assert.ok(automation.includes(key), "missing automation telemetry field " + key);
});

test("scheduled scan records counts for successful, failed and skipped order books", () => {
  assert.ok(engine.includes("last_entry_scan_book_success_count: entryBookSuccessCount"));
  assert.ok(engine.includes("last_entry_scan_book_failed_count: entryBookFailedCount"));
  assert.ok(engine.includes("last_entry_scan_book_skipped_count: entryBookSkippedCount"));
});

test("dashboard makes the fresh per-scan entry book distinct from 10-second exit L2 refresh", () => {
  assert.match(html, /Entry-scan book \(fresh per full scan\)/);
  assert.match(html, /Position-exit L2 refresh \(10s while positions are open\)/);
});
