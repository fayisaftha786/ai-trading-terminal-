import test from "node:test";
import assert from "node:assert/strict";
import { buildLiveFillReport } from "../src/live-ledger.js";

const fill = (overrides = {}) => ({
  entry_id: "buy-1", product_id: "BTC-USD", side: "BUY",
  trade_time: "2026-11-10T10:00:00.000Z", price: "10000",
  size: "0.01", size_in_quote: false, commission: "1",
  commission_currency: "USD", ...overrides
});

test("FIFO P&L includes only explicit quote-currency Coinbase fees", () => {
  const report = buildLiveFillReport([
    fill(),
    fill({ entry_id: "sell-1", side: "SELL", trade_time: "2026-11-10T11:00:00.000Z",
      price: "11000", size: "0.004", commission: "0.44" })
  ], 1794308400000);
  assert.equal(report.fill_count, 2);
  assert.equal(report.products[0].matched_sell_base, "0.004");
  assert.equal(report.products[0].remaining_bot_inventory_base, "0.006");
  assert.equal(report.products[0].realized_pnl_quote, "3.16");
  assert.equal(report.totals.accounting_complete, true);
  assert.equal(report.totals.realized_pnl_quote, 3.16);
});

test("unknown or non-quote fee currency fails closed instead of overstating P&L", () => {
  const report = buildLiveFillReport([fill({ commission_currency: null })]);
  assert.equal(report.products[0].accounting_status, "incomplete_unknown_fee_currency");
  assert.equal(report.totals.accounting_complete, false);
  assert.equal(report.totals.realized_pnl_quote, null);
});

test("unmatched sells and mixed quote currencies never produce a global P&L", () => {
  const unmatched = buildLiveFillReport([fill({ side: "SELL", commission: "0" })]);
  assert.equal(unmatched.products[0].unmatched_sell_base, "0.01");
  assert.equal(unmatched.totals.realized_pnl_quote, null);
  const mixed = buildLiveFillReport([
    fill({ commission: "0" }),
    fill({ entry_id: "eth-1", product_id: "ETH-EUR", commission: "0", commission_currency: null })
  ]);
  assert.equal(mixed.totals.mixed_quote_currencies, true);
  assert.equal(mixed.totals.realized_pnl_quote, null);
});
