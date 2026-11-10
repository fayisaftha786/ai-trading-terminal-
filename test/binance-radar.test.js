import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeBinanceRadarTicker,
  selectBinanceRadarMarkets,
  buildBinanceRadarStreamUrl,
  medianRadarSpread
} from "../public/binance-radar.js";

test("normalizes a Binance 24h REST ticker and calculates the quoted spread", () => {
  const row = normalizeBinanceRadarTicker({
    symbol: "BTCUSDT",
    lastPrice: "100000",
    bidPrice: "99990",
    askPrice: "100010",
    priceChangePercent: "2.5",
    quoteVolume: "123456789",
    count: 50000,
    closeTime: 1794000000000
  }, 1794000000100);
  assert.equal(row.symbol, "BTCUSDT");
  assert.equal(row.baseAsset, "BTC");
  assert.equal(row.last, 100000);
  assert.equal(row.changePct, 2.5);
  assert.equal(row.quoteVolume, 123456789);
  assert.equal(row.spreadBps, 2);
  assert.equal(row.receivedAt, 1794000000100);
});

test("normalizes a WebSocket ticker update with one-second event fields", () => {
  const row = normalizeBinanceRadarTicker({
    e: "24hrTicker", E: 1794000000100, s: "ETHUSDT",
    c: "2500", b: "2499", a: "2501", P: "-1.25", q: "25000000", n: 8000
  }, 1794000000200);
  assert.equal(row.symbol, "ETHUSDT");
  assert.equal(row.changePct, -1.25);
  assert.equal(row.spreadBps, 8);
  assert.equal(row.eventTime, 1794000000100);
});

test("selects the 50 highest-volume eligible USDT Spot markets and excludes stable/leveraged bases", () => {
  const tickers = [];
  for (let index = 0; index < 60; index += 1) {
    tickers.push({
      symbol: "COIN" + index + "USDT",
      lastPrice: "1",
      bidPrice: "0.999",
      askPrice: "1.001",
      priceChangePercent: "1",
      quoteVolume: String(100000000 - index * 100000),
      count: 10000
    });
  }
  tickers.push(
    { symbol: "USDCUSDT", lastPrice: "1", bidPrice: ".999", askPrice: "1.001", quoteVolume: "900000000", count: 100000 },
    { symbol: "BTCUPUSDT", lastPrice: "1", bidPrice: ".999", askPrice: "1.001", quoteVolume: "800000000", count: 100000 },
    { symbol: "BTCDOWNUSDT", lastPrice: "1", bidPrice: ".999", askPrice: "1.001", quoteVolume: "700000000", count: 100000 }
  );
  const selected = selectBinanceRadarMarkets(tickers);
  assert.equal(selected.length, 50);
  assert.equal(selected[0].symbol, "COIN0USDT");
  assert.ok(selected.every((row) => row.quoteVolume >= selected.at(-1).quoteVolume));
  assert.ok(selected.every((row) => !["USDC", "BTCUP", "BTCDOWN"].includes(row.baseAsset)));
});

test("market selection falls back to the liquid candidates when strict activity thresholds leave too few", () => {
  const selected = selectBinanceRadarMarkets([
    { symbol: "BTCUSDT", lastPrice: "100", bidPrice: "99", askPrice: "101", quoteVolume: "2000000", count: 50 },
    { symbol: "ETHUSDT", lastPrice: "10", bidPrice: "9.99", askPrice: "10.01", quoteVolume: "1000000", count: 25 }
  ]);
  assert.deepEqual(selected.map((row) => row.symbol), ["BTCUSDT", "ETHUSDT"]);
});

test("combined WebSocket URL is market-data-only, unique and capped at 50 USDT symbols", () => {
  const symbols = ["BTCUSDT", "ethusdt", "BTCUSDT", "DOGEUSDT", "invalid"];
  const url = buildBinanceRadarStreamUrl(symbols);
  assert.equal(
    url,
    "wss://data-stream.binance.vision/stream?streams=btcusdt@ticker/ethusdt@ticker/dogeusdt@ticker"
  );
  const many = Array.from({ length: 70 }, (_, index) => "COIN" + index + "USDT");
  assert.equal(buildBinanceRadarStreamUrl(many).split("@ticker").length - 1, 50);
  assert.throws(() => buildBinanceRadarStreamUrl([]), /at_least_one_valid_usdt_symbol_required/);
});

test("median spread ignores invalid values and supports even-sized samples", () => {
  assert.equal(medianRadarSpread([{ spreadBps: 2 }, { spreadBps: 4 }, { spreadBps: null }, { spreadBps: 8 }]), 4);
  assert.equal(medianRadarSpread([{ spreadBps: 1 }, { spreadBps: 5 }, { spreadBps: 10 }]), 5);
  assert.equal(medianRadarSpread([]), null);
});
