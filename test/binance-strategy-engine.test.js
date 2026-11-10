import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const engine = readFileSync(new URL("../src/engine.js", import.meta.url), "utf8");
const strategy = readFileSync(new URL("../src/binance-strategy.js", import.meta.url), "utf8");

test("Binance strategy uses persistent closed-candle cache and current REST depth", () => {
  assert.match(engine, /CREATE TABLE IF NOT EXISTS binance_strategy_candle_cache/);
  assert.match(engine, /loadBinanceStrategyCandleCache/);
  assert.match(engine, /saveBinanceStrategyCandleCache/);
  assert.match(engine, /depth\?symbol=/);
  assert.match(engine, /ticker\/24hr\?symbols=/);
  assert.match(engine, /stale_fallback_timeframes/);
});

test("Binance strategy is public-read-only and never enables an exchange order", () => {
  assert.match(engine, /paper_orders_created: 0/);
  assert.match(engine, /live_trading_enabled: false/);
  assert.match(engine, /live_execution_locked: true/);
  assert.match(strategy, /order_created: false/);
  assert.match(strategy, /auto_entry_enabled_by_this_engine: false/);
  assert.doesNotMatch(engine, /submitBinance|cancelBinance|withdrawBinance/);
});

test("Binance strategy filters thin ticker snapshots using 24h trade count", () => {
  assert.match(strategy, /active_24h_trade_count/);
  assert.match(strategy, /ticker\?\.count/);
  assert.doesNotMatch(strategy, /recent_last_trade|tickerTime/);
});
