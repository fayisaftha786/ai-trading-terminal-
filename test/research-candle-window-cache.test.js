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

test("successful Coinbase and legacy provider archives refresh their own candle windows", () => {
  const coinbaseStart = engine.indexOf("  archiveClosedCandles(");
  const coinbaseEnd = engine.indexOf("  archiveProviderCandles(", coinbaseStart);
  const coinbase = engine.slice(coinbaseStart, coinbaseEnd);
  const providerStart = coinbaseEnd;
  const providerEnd = engine.indexOf("  researchTournament()", providerStart);
  const provider = engine.slice(providerStart, providerEnd);
  assert.ok(coinbase.includes('this.cacheResearchCandleWindow("coinbase_exchange"'));
  assert.ok(provider.includes("this.cacheResearchCandleWindow(exchange"));
  assert.ok(engine.includes('const key = "research_candle_window:" + exchange + ":" + product + ":" + timeframeSeconds'));
  assert.ok(engine.includes("audit.rows.slice(-150)"));
});
