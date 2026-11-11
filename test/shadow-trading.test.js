import test from "node:test";
import assert from "node:assert/strict";
import {
  isFreshShadowBook,
  normalizeShadowBookLevels,
  simulateShadowMarketBuy,
  simulateShadowMarketSell
} from "../src/shadow-trading.js";

test("normalizes only ordered, positive L2 levels", () => {
  assert.deepEqual(normalizeShadowBookLevels([["101", "2"], ["102", "3"]], "asks"), [
    { price: 101, size: 2 }, { price: 102, size: 3 }
  ]);
  assert.equal(normalizeShadowBookLevels([[101, 1], [100, 1]], "asks"), null);
  assert.equal(normalizeShadowBookLevels([[100, 1], [101, 0]], "asks"), null);
});

test("BUY walks ask depth and applies fee plus adverse slippage", () => {
  const fill = simulateShadowMarketBuy({
    quoteBudget: 150,
    asks: [[100, 1], [110, 1]],
    feeBpsPerSide: 10,
    extraSlippageBps: 5
  });
  assert.equal(fill.ok, true);
  assert.equal(fill.status, "filled");
  assert.ok(Math.abs(fill.filled_base_quantity - (1 + 50 / 110)) < 1e-10);
  assert.ok(fill.effective_vwap_price > fill.book_vwap_price);
  assert.ok(fill.fee_usd > 0);
  assert.equal(fill.levels_used, 2);
});

test("BUY reports partial depth instead of pretending the full quote budget filled", () => {
  const fill = simulateShadowMarketBuy({
    quoteBudget: 300,
    asks: [[100, 1]],
    feeBpsPerSide: 10
  });
  assert.equal(fill.ok, true);
  assert.equal(fill.status, "partial");
  assert.equal(fill.filled_base_quantity, 1);
  assert.equal(fill.unfilled_quote_usd, 200);
});

test("SELL walks bid depth and reports any quantity that could not be filled", () => {
  const fill = simulateShadowMarketSell({
    baseQuantity: 2,
    bids: [[100, 1], [90, 0.5]],
    feeBpsPerSide: 10,
    extraSlippageBps: 10
  });
  assert.equal(fill.ok, true);
  assert.equal(fill.status, "partial");
  assert.equal(fill.filled_base_quantity, 1.5);
  assert.ok(fill.effective_quote_usd < fill.book_quote_usd);
  assert.equal(fill.unfilled_base_quantity, 0.5);
});

test("freshness guard rejects stale, non-Coinbase or incomplete books", () => {
  const now = 100000;
  const market = {
    status: "live",
    market_data_provider: "coinbase_exchange",
    book_retrieved_at_ms: now - 1000,
    book_asks: [[101, 1]],
    book_bids: [[100, 1]]
  };
  assert.equal(isFreshShadowBook(market, now), true);
  assert.equal(isFreshShadowBook({ ...market, book_retrieved_at_ms: now - 16000 }, now), false);
  assert.equal(isFreshShadowBook({ ...market, market_data_provider: "bitstamp_spot" }, now), false);
  assert.equal(isFreshShadowBook({ ...market, book_asks: [] }, now), false);
});
