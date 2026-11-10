import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeResearchCandleWindow } from "../src/research.js";

const engine = readFileSync(new URL("../src/engine.js", import.meta.url), "utf8");

function candle(time, close = 100) {
  return {
    time,
    open: close - 1,
    high: close + 2,
    low: close - 2,
    close,
    volume: 10
  };
}

test("persistent candle window accepts a chronological 150-row OHLCV history", () => {
  const rows = Array.from({ length: 150 }, (_, index) => candle(index * 60_000));
  const normalized = normalizeResearchCandleWindow(rows);
  assert.equal(normalized.length, 150);
  assert.equal(normalized[0].time, 0);
  assert.equal(normalized.at(-1).time, 149 * 60_000);
  assert.deepEqual(normalized[0], rows[0]);
});

test("persistent candle window rejects more than 150 rows and non-chronological history", () => {
  assert.equal(normalizeResearchCandleWindow(Array.from({ length: 151 }, (_, i) => candle(i))), null);
  assert.equal(normalizeResearchCandleWindow([candle(60_000), candle(0)]), null);
  assert.equal(normalizeResearchCandleWindow([candle(0), candle(0)]), null);
});

test("persistent candle window rejects malformed OHLCV and impossible price ranges", () => {
  assert.equal(normalizeResearchCandleWindow([{ ...candle(0), close: Number.NaN }]), null);
  assert.equal(normalizeResearchCandleWindow([{ ...candle(0), volume: -1 }]), null);
  assert.equal(normalizeResearchCandleWindow([{ ...candle(0), high: 50 }]), null);
  assert.equal(normalizeResearchCandleWindow([{ ...candle(0), low: 150 }]), null);
  assert.equal(normalizeResearchCandleWindow([{ ...candle(0), time: "invalid" }]), null);
});

test("candle cache checks one persistent state row before querying 150 archive rows", () => {
  const start = engine.indexOf("  loadResearchCandleCache(product, timeframeSeconds");
  const end = engine.indexOf("  async ensureAlarm()", start);
  const method = engine.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.ok(method.indexOf("this.getState(cacheKey)") < method.indexOf("FROM research_candles"));
  assert.ok(method.includes("if (rows && cached.rows.length <= 150) return rows;"));
  assert.ok(method.includes("LIMIT 150"));
  assert.ok(method.includes("this.setState(cacheKey"));
});

test("successful provider snapshots refresh isolated 150-candle windows before archive maintenance", () => {
  const snapshotStart = engine.indexOf("const snapshot = await fetchProductSnapshot(");
  const snapshotEnd = engine.indexOf("const primary = analyzeTimeframe", snapshotStart);
  const snapshotFlow = engine.slice(snapshotStart, snapshotEnd);
  const archiveStart = engine.indexOf("  archiveClosedCandles(");
  const archiveEnd = engine.indexOf("  archiveProviderCandles(", archiveStart);
  const providerStart = archiveEnd;
  const providerEnd = engine.indexOf("  researchTournament()", providerStart);
  const archiveMethods = engine.slice(archiveStart, providerEnd);
  assert.ok(snapshotStart >= 0 && snapshotEnd > snapshotStart);
  assert.ok(snapshotFlow.includes("this.cacheResearchCandleWindow("));
  assert.ok(snapshotFlow.includes('const snapshotExchange = snapshot.market_data_provider || "coinbase_exchange"'));
  assert.ok(snapshotFlow.includes('snapshotExchange === "bitstamp_spot"'));
  assert.ok(snapshotFlow.includes("cachedCandles.bitstamp?.[key]"));
  assert.ok(snapshotFlow.includes("[60, \"one_minute\", snapshot.one_minute_audit]"));
  assert.ok(snapshotFlow.includes("[300, \"five_minute\", snapshot.five_minute_audit]"));
  assert.ok(snapshotFlow.includes("[3600, \"one_hour\", snapshot.one_hour_audit]"));
  assert.ok(snapshotFlow.includes("[21600, \"six_hour\", snapshot.six_hour_audit]"));
  assert.ok(archiveMethods.includes("this.archiveClosedCandles(") === false);
  assert.ok(!archiveMethods.includes("cacheResearchCandleWindow("));
  assert.ok(engine.includes('const key = "research_candle_window:" + exchange + ":" + product + ":" + timeframeSeconds'));
  assert.ok(engine.includes("audit.rows.slice(-150)"));
});
