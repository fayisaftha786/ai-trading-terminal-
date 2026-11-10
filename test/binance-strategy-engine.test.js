import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const engine = readFileSync(new URL("../src/engine.js", import.meta.url), "utf8");
const strategy = readFileSync(new URL("../src/binance-strategy.js", import.meta.url), "utf8");

test("Binance strategy uses persistent closed-candle cache and current REST depth", () => {
  assert.ok(engine.includes("CREATE TABLE IF NOT EXISTS binance_strategy_candle_cache"));
  assert.ok(engine.includes("loadBinanceStrategyCandleCache"));
  assert.ok(engine.includes("saveBinanceStrategyCandleCache"));
  assert.ok(engine.includes("depth?symbol="));
  assert.ok(engine.includes('const tickerUrl = "https://data-api.binance.vision/api/v3/ticker/24hr";'));
  assert.ok(engine.includes('const base = "https://data-api.binance.vision/api/v3/";'));
  assert.equal(engine.includes("ticker/24hr?symbols="), false);
  assert.ok(engine.includes("requestedSymbols = new Set"));
  assert.ok(engine.includes("stale_fallback_timeframes"));
});

test("Binance strategy invalid-batch response matches the 50-symbol API limit", () => {
  assert.ok(engine.includes("maximum_symbols_per_batch: BINANCE_STRATEGY_BATCH_LIMIT"));
  assert.ok(engine.includes('expected: "one to fifty comma-separated Binance USDT Spot symbols"'));
});

test("Binance strategy is public-read-only and never enables an exchange order", () => {
  assert.ok(engine.includes("paper_orders_created: 0"));
  assert.ok(engine.includes("live_trading_enabled: false"));
  assert.ok(engine.includes("live_execution_locked: true"));
  assert.ok(strategy.includes("order_created: false"));
  assert.ok(strategy.includes("auto_entry_enabled_by_this_engine: false"));
  assert.equal(/submitBinance|cancelBinance|withdrawBinance/.test(engine), false);
});

test("Binance strategy filters thin ticker snapshots using 24h trade count", () => {
  assert.ok(strategy.includes("active_24h_trade_count"));
  assert.ok(strategy.includes("ticker?.count"));
  assert.equal(/recent_last_trade|tickerTime/.test(strategy), false);
});
