import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const engine = readFileSync(new URL("../src/engine.js", import.meta.url), "utf8");

const snapshotStart = engine.indexOf("const snapshot = await fetchProductSnapshot(");
const snapshotEnd = engine.indexOf("const primary = analyzeTimeframe", snapshotStart);
const snapshotFlow = engine.slice(snapshotStart, snapshotEnd);
const cacheStart = engine.indexOf("  cacheResearchCandleWindow(");
const cacheEnd = engine.indexOf("  loadResearchCandleCache(", cacheStart);
const cacheMethod = engine.slice(cacheStart, cacheEnd);
const archiveStart = engine.indexOf("  archiveClosedCandles(");
const archiveEnd = engine.indexOf("  archiveProviderCandles(", archiveStart);
const archiveMethod = engine.slice(archiveStart, archiveEnd);

test("validated candle windows are cached immediately after provider snapshot and before SQL archive writes", () => {
  assert.ok(snapshotStart >= 0 && snapshotEnd > snapshotStart);
  assert.ok(snapshotFlow.indexOf("this.cacheResearchCandleWindow(") > snapshotFlow.indexOf("fetchProductSnapshot("));
  assert.ok(snapshotFlow.indexOf("this.cacheResearchCandleWindow(") < snapshotFlow.indexOf("candleArchives.push("));
  assert.ok(snapshotFlow.includes("[60, \"one_minute\", snapshot.one_minute_audit]"));
  assert.ok(snapshotFlow.includes("[300, \"five_minute\", snapshot.five_minute_audit]"));
  assert.ok(snapshotFlow.includes("[3600, \"one_hour\", snapshot.one_hour_audit]"));
  assert.ok(snapshotFlow.includes("[21600, \"six_hour\", snapshot.six_hour_audit]"));
});

test("candle cache writes are validated and skipped when the already-loaded window is unchanged", () => {
  assert.ok(cacheMethod.includes("normalizeResearchCandleWindow(audit.rows.slice(-150))"));
  assert.ok(cacheMethod.includes("normalizeResearchCandleWindow(previousRows)"));
  assert.ok(cacheMethod.includes("JSON.stringify(previous) === JSON.stringify(rows)"));
  assert.ok(cacheMethod.includes("if (previous && JSON.stringify(previous) === JSON.stringify(rows)) return true;"));
});

test("cache update failure is isolated from the market scan and does not falsify its snapshot", () => {
  assert.ok(snapshotFlow.includes("try {"));
  assert.ok(snapshotFlow.includes("this.cacheResearchCandleWindow("));
  assert.ok(snapshotFlow.includes("console.error(\"Research candle window cache update failed\""));
  assert.ok(snapshotFlow.includes("candleArchives.push("));
});

test("legacy Bitstamp candle cache stays isolated from Coinbase research windows", () => {
  assert.ok(snapshotFlow.includes('snapshotExchange === "bitstamp_spot"'));
  assert.ok(snapshotFlow.includes("cachedCandles.bitstamp?.[key]"));
  assert.ok(snapshotFlow.includes('const snapshotExchange = snapshot.market_data_provider || "coinbase_exchange"'));
});

test("archive maintenance no longer owns the strategy cache refresh", () => {
  assert.ok(archiveStart >= 0 && archiveEnd > archiveStart);
  assert.ok(!archiveMethod.includes("cacheResearchCandleWindow("));
  assert.ok(engine.includes("The research archive may be temporarily unreadable after a"));
});
