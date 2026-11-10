import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeBinanceMultiTimeframeMarket,
  normalizeBinanceKlines,
  shouldRefreshBinanceCandleCache,
  BINANCE_STRATEGY_BATCH_LIMIT
} from "../src/binance-strategy.js";

function candles(intervalMs, nowMs, count = 180) {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const close = 100 + (index * 0.08) + (Math.sin(index * 0.7) * 0.6);
    rows.push([
      Math.floor(nowMs / intervalMs) * intervalMs - ((count - index) * intervalMs),
      String(close - 0.1),
      String(close + 0.45),
      String(close - 0.45),
      String(close),
      String(1000 + (index > 150 ? 700 : 0))
    ]);
  }
  return rows;
}

function validInput(nowMs = 1_800_000_000_000) {
  return {
    symbol: "BTCUSDT",
    ticker: {
      lastPrice: "114.3",
      bidPrice: "114.29",
      askPrice: "114.31",
      quoteVolume: "25000000",
      count: 1200,
      closeTime: nowMs - 1000
    },
    depth: {
      bids: Array.from({ length: 20 }, (_, index) => ["114.29", String(10 - index * 0.1)]),
      asks: Array.from({ length: 20 }, (_, index) => ["114.31", String(10 - index * 0.1)])
    },
    candlesByInterval: {
      "15m": candles(900_000, nowMs),
      "1h": candles(3_600_000, nowMs),
      "4h": candles(14_400_000, nowMs)
    },
    nowMs,
    costs: { feeBpsPerSide: 10, slippageBps: 5 }
  };
}

test("normalizes Binance kline arrays into OHLCV records", () => {
  assert.deepEqual(normalizeBinanceKlines([[60000, "10", "12", "9", "11", "100"]]), [
    { time: 60000, open: 10, high: 12, low: 9, close: 11, volume: 100 }
  ]);
  assert.deepEqual(normalizeBinanceKlines([["bad"], null]), []);
});

test("rejects malformed symbols before any market analysis", () => {
  const result = analyzeBinanceMultiTimeframeMarket({
    ...validInput(),
    symbol: "BTCUSDT;DROP"
  });
  assert.equal(result.signal, "HOLD");
  assert.deepEqual(result.block_reasons, ["invalid_spot_symbol"]);
});

test("requires valid closed history, quotes and liquidity for a candidate", () => {
  const result = analyzeBinanceMultiTimeframeMarket(validInput());
  assert.equal(result.binance_symbol, "BTCUSDT");
  assert.equal(result.status, "analyzed");
  assert.equal(result.paper_trade.order_created, false);
  assert.equal(result.paper_trade.requires_owner_confirmation, true);
  assert.ok(["LONG_CANDIDATE", "HOLD"].includes(result.signal));
  assert.equal(result.score_is_probability, false);
  assert.ok(result.risk_check.block_reasons.every((reason) => typeof reason === "string"));
});

test("24h trade count blocks thin markets without misreading the rolling ticker closeTime", () => {
  const input = validInput();
  input.ticker.count = 42;
  input.ticker.closeTime = input.nowMs - (10 * 60_000);
  const result = analyzeBinanceMultiTimeframeMarket(input);
  assert.equal(result.risk_check.data_checks.active_24h_trade_count, false);
  assert.ok(result.risk_check.block_reasons.includes("active_24h_trade_count"));
  assert.equal(result.paper_trade.status, "BLOCKED");
});

test("portfolio risk failures are propagated as paper-trade blocks", () => {
  const result = analyzeBinanceMultiTimeframeMarket({
    ...validInput(),
    portfolioBlockReasons: ["max_open_positions", "daily_loss_limit"]
  });
  assert.ok(result.risk_check.block_reasons.includes("max_open_positions"));
  assert.ok(result.risk_check.block_reasons.includes("daily_loss_limit"));
  assert.equal(result.paper_trade.order_created, false);
});

test("gapped candle history fails audit and cannot produce a ready review", () => {
  const input = validInput();
  input.candlesByInterval["1h"].splice(90, 1);
  const result = analyzeBinanceMultiTimeframeMarket(input);
  assert.equal(result.multi_timeframe["1h"].audit_ok, false);
  assert.equal(result.paper_trade.status, "BLOCKED");
});

test("25-symbol analysis batches reduce sequential request waves", () => {
  assert.equal(BINANCE_STRATEGY_BATCH_LIMIT, 50);
});

test("closed-candle cache is reused until the next candle closes", () => {
  const nowMs = 1_800_000_000_000;
  const rows = candles(900_000, nowMs);
  assert.equal(shouldRefreshBinanceCandleCache(rows, 900_000, nowMs), false);
  assert.equal(shouldRefreshBinanceCandleCache(rows, 900_000, nowMs + 900_000), true);
});

test("candle cache refreshes for missing, insufficient or gapped history", () => {
  const nowMs = 1_800_000_000_000;
  const rows = candles(900_000, nowMs);
  assert.equal(shouldRefreshBinanceCandleCache(rows.slice(0, 80), 900_000, nowMs), true);
  rows.splice(85, 1);
  assert.equal(shouldRefreshBinanceCandleCache(rows, 900_000, nowMs), true);
});

test("eight specialist votes are explicit and volume confirmation can veto an otherwise bullish setup", () => {
  const input = validInput();
  const result = analyzeBinanceMultiTimeframeMarket(input);
  assert.equal(result.strategy_committee.total_votes, 8);
  assert.equal(result.strategy_committee.votes.length, 8);
  assert.equal(result.strategy_committee.mode, "transparent_deterministic_specialist_consensus");
  assert.equal(result.score_is_probability, false);

  const weakVolume = validInput();
  for (const row of weakVolume.candlesByInterval["15m"].slice(-20)) row[5] = "400";
  const blocked = analyzeBinanceMultiTimeframeMarket(weakVolume);
  const volumeVote = blocked.strategy_committee.votes.find((vote) => vote.id === "volume");
  assert.equal(volumeVote.approved, false);
  assert.equal(blocked.signal, "HOLD");
  assert.ok(blocked.risk_check.block_reasons.includes("trigger_15m_participation"));
});
