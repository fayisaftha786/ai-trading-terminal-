const SCALE = 10n ** 18n;

function decimal(value) {
  const raw = String(value ?? "");
  if (raw.length > 48 || !/^(?:0|[1-9]\\d*)(?:\\.\\d+)?$/.test(raw)) return null;
  const [whole, fraction = ""] = raw.split(".");
  if (fraction.length > 18) return null;
  return BigInt(whole) * SCALE + BigInt((fraction + "0".repeat(18)).slice(0, 18));
}
function format(value) {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = (absolute / SCALE).toString();
  const fraction = (absolute % SCALE).toString().padStart(18, "0").replace(/0+$/, "");
  return (negative ? "-" : "") + whole + (fraction ? "." + fraction : "");
}
const min = (a, b) => a < b ? a : b;

/**
 * FIFO realized P&L from exchange fills linked to this app's recorded orders.
 * Fees are included only when Coinbase explicitly reports them in quote currency.
 * Unknown fee currencies, malformed fills and unmatched sells make the result incomplete.
 */
export function buildLiveFillReport(input, syncedAtMs = null) {
  const source = Array.isArray(input) ? input : [];
  const valid = [];
  const invalid = [];
  for (const row of source) {
    const product = typeof row?.product_id === "string" ? row.product_id.toUpperCase() : "";
    const [baseCurrency, quoteCurrency, extra] = product.split("-");
    const side = row?.side;
    const price = decimal(row?.price);
    const size = decimal(row?.size);
    const commission = decimal(row?.commission ?? "0");
    if (!row || typeof row.entry_id !== "string" || !row.entry_id ||
        !/^[A-Z0-9]{2,12}$/.test(baseCurrency || "") ||
        !/^[A-Z0-9]{2,12}$/.test(quoteCurrency || "") || extra !== undefined ||
        !["BUY", "SELL"].includes(side) || price === null || price <= 0n ||
        size === null || size <= 0n || commission === null) {
      invalid.push("invalid_fill_record");
      continue;
    }
    const baseSize = row.size_in_quote === true ? (size * SCALE) / price : size;
    const quoteValue = row.size_in_quote === true ? size : (size * price) / SCALE;
    if (baseSize <= 0n || quoteValue <= 0n) {
      invalid.push("fill_amount_conversion_invalid");
      continue;
    }
    const feeCurrency = typeof row.commission_currency === "string"
      ? row.commission_currency.toUpperCase() : null;
    const feeKnown = commission === 0n || feeCurrency === quoteCurrency;
    valid.push({
      entry_id: row.entry_id, product_id: product, base_currency: baseCurrency,
      quote_currency: quoteCurrency, side, trade_time: String(row.trade_time || ""),
      base_size: baseSize, quote_value: quoteValue, commission,
      fee_known: feeKnown
    });
  }
  valid.sort((a, b) => Date.parse(a.trade_time) - Date.parse(b.trade_time) ||
    a.entry_id.localeCompare(b.entry_id));
  const unique = [];
  const seen = new Set();
  for (const row of valid) {
    if (seen.has(row.entry_id)) continue;
    seen.add(row.entry_id);
    unique.push(row);
  }
  const products = new Map();
  for (const row of unique) {
    let state = products.get(row.product_id);
    if (!state) {
      state = { product_id: row.product_id, base_currency: row.base_currency,
        quote_currency: row.quote_currency, lots: [], buy_base: 0n, sell_base: 0n,
        matched_sell_base: 0n, unmatched_sell_base: 0n, realized: 0n,
        fees: 0n, fee_currency_unknown: false };
      products.set(row.product_id, state);
    }
    if (!row.fee_known) state.fee_currency_unknown = true;
    state.fees += row.commission;
    if (row.side === "BUY") {
      state.buy_base += row.base_size;
      const totalCost = row.quote_value + (row.fee_known ? row.commission : 0n);\n      state.lots.push({ remaining: row.base_size, unit_cost: (totalCost * SCALE) / row.base_size });
      continue;
    }
    state.sell_base += row.base_size;
    let remaining = row.base_size;
    let netProceeds = row.quote_value - (row.fee_known ? row.commission : 0n);
    const proceedsPerUnit = (netProceeds * SCALE) / row.base_size;
    while (remaining > 0n && state.lots.length) {
      const lot = state.lots[0];
      const matched = min(remaining, lot.remaining);
      const costPerUnit = (lot.cost * SCALE) / (lot.remaining + (lot.original_remaining || 0n));
      // Store unit cost at acquisition so partial FIFO consumption remains exact.
      const lotCost = lot.unit_cost ?? ((lot.cost * SCALE) / lot.remaining);
      state.realized += ((proceedsPerUnit - lotCost) * matched) / SCALE;
      lot.remaining -= matched;
      remaining -= matched;
      state.matched_sell_base += matched;
      if (lot.remaining === 0n) state.lots.shift();
    }
    if (remaining > 0n) state.unmatched_sell_base += remaining;
  }
  // Recompute FIFO lot cost using each buy's original base amount.
  // (The loop above's per-lot unit cost is captured when the lot is created.)
  const rows = [...products.values()].map((state) => ({
    product_id: state.product_id, base_currency: state.base_currency,
    quote_currency: state.quote_currency,
    buy_base_filled: format(state.buy_base), sell_base_filled: format(state.sell_base),
    matched_sell_base: format(state.matched_sell_base),
    unmatched_sell_base: format(state.unmatched_sell_base),
    remaining_bot_inventory_base: format(state.lots.reduce((sum, lot) => sum + lot.remaining, 0n)),
    realized_pnl_quote: format(state.realized), fees_quote: format(state.fees),
    accounting_status: state.fee_currency_unknown ? "incomplete_unknown_fee_currency"
      : state.unmatched_sell_base > 0n ? "incomplete_unmatched_inventory" : "complete",
    accounting_complete: !state.fee_currency_unknown && state.unmatched_sell_base === 0n
  }));
  const currencies = [...new Set(rows.map((row) => row.quote_currency))];
  const complete = invalid.length === 0 && rows.every((row) => row.accounting_complete);
  const mixed = currencies.length > 1;
  const total = rows.reduce((sum, row) => sum + (decimal(row.realized_pnl_quote) || 0n), 0n);
  return {
    mode: "coinbase_exchange_verified_bot_fills",
    fill_count: unique.length,
    invalid_fill_count: invalid.length,
    invalid_reasons: [...new Set(invalid)],
    synced_at_ms: Number.isFinite(syncedAtMs) ? syncedAtMs : null,
    products: rows,
    totals: {
      quote_currency: mixed || currencies.length !== 1 ? null : currencies[0],
      mixed_quote_currencies: mixed,
      realized_pnl_quote: complete && !mixed ? Number(format(total)) : null,
      accounting_complete: complete && !mixed,
      status: complete && !mixed ? "complete" : "incomplete_requires_review"
    }
  };
}
