import test from "node:test";
import assert from "node:assert/strict";
import { buildLiveFillReport } from "../src/live-ledger.js";

function fill(overrides = {}) {
  return {
    entry_id: "entry-1",
    trade_id: "trade-1",
    order_id: "order-1",
    product_id: "BTC-USD",
    side: "BUY",
    trade_time: "2026-11-09T10:00:00.000Z",
    price: "10000",
    base_size: "0.01",
    quote_value: "100",
    commission: "1",
    quote_currency: "USD",
    base_currency: "BTC",
    ...overrides
  };
}

test("FIFO realized P&L uses verified bot BUY/SELL fills and actual reported fees", () => {
  const report = buildLiveFillReport([
    fill({ entry_id: "sell-1", trade_id: "trade-2", order_id: "order-2",
      side: "SELL", trade_time: "2026-11-09T11:00:00.000Z",
      price: "11000", base_size: "0.004", quote_value: "44", commission: "0.44" }),
    fill()
  ], 1794237600000);
  assert.equal(report.mode, "coinbase_exchange_verified_bot_fills");
  assert.equal(report.fill_count, 2);
  assert.equal(report.products[0].remaining_bot_inventory_base, "0.006");
  assert.equal(report.products[0].matched_sell_base, "0.004");
  assert.equal(report.products[0].unmatched_sell_base, "0");
  assert.equal(report.products[0].realized_pnl_quote, "3.16");
  assert.equal(report.products[0].fees_quote, "1.44");
  assert.equal(report.totals.quote_currency, "USD");
  assert.equal(report.totals.realized_pnl_quote, 3.16);
  assert.equal(report.totals.accounting_complete, true);
});

test("FIFO report excludes sells without known bot opening inventory instead of inventing profit", () => {
  const report = buildLiveFillReport([
    fill({ entry_id: "sell-unknown", side: "SELL", trade_time: "2026-11-09T10:00:00.000Z",
      base_size: "0.002", quote_value: "22", price: "11000", commission: "0.22" })
  ]);
  assert.equal(report.products[0].realized_pnl_quote, "0");
  assert.equal(report.products[0].unmatched_sell_base, "0.002");
  assert.equal(report.products[0].accounting_status, "incomplete_unmatched_inventory");
  assert.equal(report.totals.accounting_complete, false);
});

test("FIFO report deduplicates fills by Coinbase entry ID", () => {
  const same = fill();
  const report = buildLiveFillReport([same, same]);
  assert.equal(report.fill_count, 1);
  assert.equal(report.products[0].buy_base_filled, "0.01");
});

test("mixed quote currencies are not combined into a fictitious global P&L", () => {
  const report = buildLiveFillReport([
    fill(),
    fill({ entry_id: "eth-entry", order_id: "eth-order", product_id: "ETH-EUR",
      quote_currency: "EUR", base_currency: "ETH" })
  ]);
  assert.equal(report.totals.mixed_quote_currencies, true);
  assert.equal(report.totals.quote_currency, null);
  assert.equal(report.totals.realized_pnl_quote, null);
});
