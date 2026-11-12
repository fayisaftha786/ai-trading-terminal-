import test from "node:test";
import assert from "node:assert/strict";
import { refreshCoinbaseShadowBooks } from "../src/shadow-book-refresh.js";

function market(symbol, provider = "coinbase_exchange") {
  return {
    symbol,
    product: symbol.replace("/", "-"),
    status: "live",
    market_data_provider: provider,
    bid_depth_quote: 12000,
    ask_depth_quote: 15000,
    book_retrieved_at_ms: 1_800_000_000_000,
    shadow_bid: 0,
    shadow_ask: 0,
    shadow_book_status: "waiting"
  };
}

test("Shadow books refresh before primary-book pass without mutating primary liquidity or freshness", async () => {
  const btc = market("BTC/USD");
  const eth = market("ETH/USD");
  let calls = 0;
  const requestState = { isolated: true };
  const result = await refreshCoinbaseShadowBooks([btc, eth], {
    requestState,
    fetchBook: async (product, state) => {
      calls += 1;
      assert.equal(state, requestState);
      return {
        bid: product === "BTC-USD" ? 100 : 50,
        ask: product === "BTC-USD" ? 101 : 51,
        bid_depth_quote: 25000,
        ask_depth_quote: 26000,
        book_bids: [[99, 2]],
        book_asks: [[102, 2]],
        book_retrieved_at_ms: 1_800_000_000_100,
        book_event_time_ms: null,
        book_age_ms: 0,
        book_source: "coinbase_advanced_trade_public",
        last: 100.5
      };
    }
  });

  assert.equal(calls, 2);
  assert.deepEqual(result, { refreshed: 2, failed: 0, issues: [] });
  assert.equal(btc.shadow_book_status, "available");
  assert.equal(btc.shadow_bid, 100);
  assert.equal(eth.shadow_ask, 51);
  assert.equal(btc.bid_depth_quote, 12000);
  assert.equal(btc.ask_depth_quote, 15000);
  assert.equal(btc.book_retrieved_at_ms, 1_800_000_000_000);
});

test("Shadow book failure is isolated and leaves primary Coinbase book intact", async () => {
  const sol = market("SOL/USD");
  const result = await refreshCoinbaseShadowBooks([sol], {
    requestState: {},
    fetchBook: async () => {
      const error = new Error("provider_timeout");
      error.code = "provider_timeout";
      throw error;
    }
  });

  assert.equal(result.refreshed, 0);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.issues, [{ symbol: "SOL/USD", reason: "provider_timeout" }]);
  assert.equal(sol.shadow_book_status, "provider_error");
  assert.equal(sol.shadow_book_error, "provider_timeout");
  assert.equal(sol.shadow_bid, null);
  assert.equal(sol.bid_depth_quote, 12000);
  assert.equal(sol.ask_depth_quote, 15000);
  assert.equal(sol.book_retrieved_at_ms, 1_800_000_000_000);
});

test("non-Coinbase legacy providers never receive a Shadow book fetch", async () => {
  const bitstamp = market("BTC/USD", "bitstamp_spot");
  let calls = 0;
  const result = await refreshCoinbaseShadowBooks([bitstamp], {
    fetchBook: async () => { calls += 1; throw new Error("must_not_call"); }
  });

  assert.equal(calls, 0);
  assert.deepEqual(result, { refreshed: 0, failed: 0, issues: [] });
  assert.equal(bitstamp.shadow_book_status, "unsupported_market_source");
  assert.equal(bitstamp.shadow_book_error, "coinbase_exchange_market_data_required");
  assert.equal(bitstamp.shadow_bid, null);
});
