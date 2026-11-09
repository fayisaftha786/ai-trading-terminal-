const PRECISION = 24n;
const SCALE = 10n ** PRECISION;

function fixed(value) {
  if (typeof value !== "string" || value.length > 48 ||
      !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > Number(PRECISION)) return null;
  return BigInt(whole) * SCALE + BigInt((fraction + "0".repeat(Number(PRECISION))).slice(0, Number(PRECISION)));
}

function formatFixed(value) {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = (absolute / SCALE).toString();
  const fraction = (absolute % SCALE).toString().padStart(Number(PRECISION), "0").replace(/0+$/, "");
  return (negative ? "-" : "") + whole + (fraction ? "." + fraction : "");
}

function add(a, b) { return a + b; }
function sub(a, b) { return a - b; }
function mul(a, b) { return (a * b) / SCALE; }
function div(a, b) { return b === 0n ? null : (a * SCALE) / b; }
function min(a, b) { return a < b ? a : b; }

function safeTime(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : 0;
}

/**
 * Builds a FIFO realized-P&L view from Coinbase fills belonging to locally
 * recorded bot orders only. Unknown inventory is deliberately not assigned a
 * cost basis; unmatched sells are exposed rather than counted as profit.
 */
export function buildLiveFillReport(fills, syncedAtMs = null) {
  const rows = Array.isArray(fills) ? fills.slice() : [];
  const valid = rows.filter((fill) =>
    fill && typeof fill === "object" &&
    typeof fill.entry_id === "string" && fill.entry_id.length > 0 &&
    typeof fill.product_id === "string" && /^[A-Z0-9-]{3,48}$/.test(fill.product_id) &&
    (fill.side === "BUY" || fill.side === "SELL") &&
    fixed(String(fill.base_size || "")) !== null &&
    fixed(String(fill.price || "")) !== null &&
    fixed(String(fill.quote_value || "")) !== null &&
    fixed(String(fill.commission || "0")) !== null &&
    fixed(String(fill.commission || "0")) >= 0n
  ).sort((a, b) => safeTime(a.trade_time) - safeTime(b.trade_time) ||
    String(a.entry_id).localeCompare(String(b.entry_id)));

  const unique = [];
  const seen = new Set();
  for (const fill of valid) {
    const key = fill.entry_id;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(fill);
  }

  const byProduct = new Map();
  for (const fill of unique) {
    if (!byProduct.has(fill.product_id)) {
      byProduct.set(fill.product_id, {
        product_id: fill.product_id,
        quote_currency: typeof fill.quote_currency === "string" ? fill.quote_currency : null,
        base_currency: typeof fill.base_currency === "string" ? fill.base_currency : null,
        lots: [],
        buy_base: 0n,
        sell_base: 0n,
        quote_volume: 0n,
        fees_quote: 0n,
        realized_pnl_quote: 0n,
        matched_sell_base: 0n,
        unmatched_sell_base: 0n,
        fill_count: 0
      });
    }
    const group = byProduct.get(fill.product_id);
    const baseSize = fixed(String(fill.base_size));
    const quoteValue = fixed(String(fill.quote_value));
    const fee = fixed(String(fill.commission || "0"));
    const price = fixed(String(fill.price));
    if (baseSize === null || quoteValue === null || fee === null || price === null ||
        baseSize <= 0n || quoteValue <= 0n || price <= 0n) continue;

    group.fill_count += 1;
    group.quote_volume = add(group.quote_volume, quoteValue);
    group.fees_quote = add(group.fees_quote, fee);
    if (fill.side === "BUY") {
      group.buy_base = add(group.buy_base, baseSize);
      const totalCost = add(quoteValue, fee);
      const unitCost = div(totalCost, baseSize);
      if (unitCost !== null) group.lots.push({ remaining_base: baseSize, unit_cost_quote: unitCost });
      continue;
    }

    group.sell_base = add(group.sell_base, baseSize);
    const netProceeds = sub(quoteValue, fee);
    const unitProceeds = div(netProceeds, baseSize);
    if (unitProceeds === null) {
      group.unmatched_sell_base = add(group.unmatched_sell_base, baseSize);
      continue;
    }
    let remaining = baseSize;
    while (remaining > 0n && group.lots.length) {
      const lot = group.lots[0];
      const matched = min(remaining, lot.remaining_base);
      const allocatedCost = mul(matched, lot.unit_cost_quote);
      const allocatedProceeds = mul(matched, unitProceeds);
      group.realized_pnl_quote = add(group.realized_pnl_quote, sub(allocatedProceeds, allocatedCost));
      group.matched_sell_base = add(group.matched_sell_base, matched);
      lot.remaining_base = sub(lot.remaining_base, matched);
      remaining = sub(remaining, matched);
      if (lot.remaining_base === 0n) group.lots.shift();
    }
    if (remaining > 0n) group.unmatched_sell_base = add(group.unmatched_sell_base, remaining);
  }

  const products = [...byProduct.values()].map((group) => {
    const inventory = group.lots.reduce((sum, lot) => add(sum, lot.remaining_base), 0n);
    return {
      product_id: group.product_id,
      base_currency: group.base_currency,
      quote_currency: group.quote_currency,
      fill_count: group.fill_count,
      buy_base_filled: formatFixed(group.buy_base),
      sell_base_filled: formatFixed(group.sell_base),
      remaining_bot_inventory_base: formatFixed(inventory),
      quote_volume: formatFixed(group.quote_volume),
      fees_quote: formatFixed(group.fees_quote),
      realized_pnl_quote: formatFixed(group.realized_pnl_quote),
      matched_sell_base: formatFixed(group.matched_sell_base),
      unmatched_sell_base: formatFixed(group.unmatched_sell_base),
      accounting_status: group.unmatched_sell_base > 0n ? "incomplete_unmatched_inventory" : "matched_bot_fills_only"
    };
  }).sort((a, b) => a.product_id.localeCompare(b.product_id));

  const totals = products.reduce((sum, row) => {
    if (row.quote_currency && row.quote_currency === sum.quote_currency) {
      sum.realized_pnl_quote += Number(row.realized_pnl_quote);
      sum.fees_quote += Number(row.fees_quote);
      sum.quote_volume += Number(row.quote_volume);
    } else if (!sum.quote_currency && row.quote_currency) {
      sum.quote_currency = row.quote_currency;
      sum.realized_pnl_quote = Number(row.realized_pnl_quote);
      sum.fees_quote = Number(row.fees_quote);
      sum.quote_volume = Number(row.quote_volume);
    } else if (row.quote_currency !== sum.quote_currency) {
      sum.mixed_quote_currencies = true;
    }
    if (row.accounting_status !== "matched_bot_fills_only") sum.accounting_complete = false;
    return sum;
  }, { quote_currency: null, realized_pnl_quote: 0, fees_quote: 0, quote_volume: 0, mixed_quote_currencies: false, accounting_complete: true });

  return {
    mode: "coinbase_exchange_verified_bot_fills",
    status: unique.length ? "fills_available" : "no_bot_fills",
    fill_count: unique.length,
    synced_at_ms: Number.isFinite(syncedAtMs) ? syncedAtMs : null,
    products,
    totals: {
      quote_currency: totals.mixed_quote_currencies ? null : totals.quote_currency,
      realized_pnl_quote: totals.mixed_quote_currencies ? null : Number(totals.realized_pnl_quote.toFixed(8)),
      fees_quote: totals.mixed_quote_currencies ? null : Number(totals.fees_quote.toFixed(8)),
      quote_volume: totals.mixed_quote_currencies ? null : Number(totals.quote_volume.toFixed(8)),
      mixed_quote_currencies: totals.mixed_quote_currencies,
      accounting_complete: totals.accounting_complete
    },
    scope: "Only fills linked to this app's recorded Coinbase orders. Deposits, withdrawals, manual exchange trades and opening inventory are excluded.",
    warning: "Realized P&L uses FIFO matching of known bot BUY fills against bot SELL fills. Unmatched sells are excluded from profit; quote-denominated commissions and provider-reported fill values are used. Tax accounting and external wallet inventory are not included."
  };
}
