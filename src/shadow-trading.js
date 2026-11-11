const MAX_LEVELS = 25;
const EPSILON = 1e-12;

function validRate(value, maximum = 1000) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= maximum ? number : null;
}

export function normalizeShadowBookLevels(levels, side = "asks", maxLevels = MAX_LEVELS) {
  if (!Array.isArray(levels) || levels.length === 0 ||
      (side !== "asks" && side !== "bids")) return null;
  const limit = Math.max(1, Math.min(MAX_LEVELS, Math.trunc(Number(maxLevels) || MAX_LEVELS)));
  const normalized = [];
  let previousPrice = side === "asks" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  for (const row of levels.slice(0, limit)) {
    const price = Number(Array.isArray(row) ? row[0] : row?.price);
    const size = Number(Array.isArray(row) ? row[1] : row?.size);
    if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size <= 0) return null;
    if (side === "asks" ? price < previousPrice : price > previousPrice) return null;
    normalized.push({ price, size });
    previousPrice = price;
  }
  return normalized.length ? normalized : null;
}

function buildFill({ side, levels, quantity, quoteBudget, feeBpsPerSide, extraSlippageBps }) {
  const feeBps = validRate(feeBpsPerSide);
  const slippageBps = validRate(extraSlippageBps);
  const requestedQuantity = quantity == null ? null : Number(quantity);
  const requestedQuote = quoteBudget == null ? null : Number(quoteBudget);
  if (feeBps === null || slippageBps === null ||
      (side === "BUY" && (!Number.isFinite(requestedQuote) || requestedQuote <= 0)) ||
      (side === "SELL" && (!Number.isFinite(requestedQuantity) || requestedQuantity <= 0))) {
    return { ok: false, reason: "invalid_shadow_fill_request" };
  }
  const normalized = normalizeShadowBookLevels(levels, side === "BUY" ? "asks" : "bids");
  if (!normalized) return { ok: false, reason: "shadow_order_book_invalid_or_empty" };

  let remaining = side === "BUY" ? requestedQuote : requestedQuantity;
  let filledBase = 0;
  let bookQuote = 0;
  let levelsUsed = 0;
  for (const level of normalized) {
    if (remaining <= EPSILON) break;
    const available = side === "BUY" ? level.price * level.size : level.size;
    const consumed = Math.min(remaining, available);
    if (consumed <= EPSILON) continue;
    const base = side === "BUY" ? consumed / level.price : consumed;
    const quote = base * level.price;
    filledBase += base;
    bookQuote += quote;
    remaining -= consumed;
    levelsUsed += 1;
  }

  if (!(filledBase > 0) || !(bookQuote > 0)) {
    return { ok: false, reason: "shadow_order_book_has_no_executable_depth" };
  }
  const bookVwap = bookQuote / filledBase;
  const adverseMultiplier = side === "BUY" ? 1 + slippageBps / 10000 : 1 - slippageBps / 10000;
  if (!(adverseMultiplier > 0)) return { ok: false, reason: "shadow_slippage_invalid" };
  const effectiveVwap = bookVwap * adverseMultiplier;
  const effectiveQuote = filledBase * effectiveVwap;
  const feeUsd = effectiveQuote * feeBps / 10000;
  const targetBase = side === "BUY" ? requestedQuote / normalized[0].price : requestedQuantity;
  const fillRatio = Math.max(0, Math.min(1, filledBase / targetBase));
  const complete = remaining <= Math.max(EPSILON, (side === "BUY" ? requestedQuote : requestedQuantity) * 1e-9);
  return {
    ok: true,
    side,
    status: complete && fillRatio >= 0.999 ? "filled" : "partial",
    requested_quote_usd: side === "BUY" ? requestedQuote : null,
    requested_base_quantity: side === "SELL" ? requestedQuantity : targetBase,
    filled_base_quantity: filledBase,
    book_quote_usd: bookQuote,
    effective_quote_usd: effectiveQuote,
    book_vwap_price: bookVwap,
    effective_vwap_price: effectiveVwap,
    fee_bps_per_side: feeBps,
    fee_usd: feeUsd,
    extra_slippage_bps: slippageBps,
    fill_ratio: fillRatio,
    unfilled_quote_usd: side === "BUY" ? Math.max(0, requestedQuote - bookQuote) : null,
    unfilled_base_quantity: side === "SELL" ? Math.max(0, requestedQuantity - filledBase) : Math.max(0, targetBase - filledBase),
    levels_used: levelsUsed,
    best_book_price: normalized[0].price
  };
}

export function simulateShadowMarketBuy({ quoteBudget, asks, feeBpsPerSide = 0, extraSlippageBps = 0 } = {}) {
  return buildFill({ side: "BUY", levels: asks, quoteBudget, feeBpsPerSide, extraSlippageBps });
}

export function simulateShadowMarketSell({ baseQuantity, bids, feeBpsPerSide = 0, extraSlippageBps = 0 } = {}) {
  return buildFill({ side: "SELL", levels: bids, quantity: baseQuantity, feeBpsPerSide, extraSlippageBps });
}

export function isFreshShadowBook(market, nowMs = Date.now(), maxAgeMs = 15000) {
  if (!market || market.status !== "live" || market.market_data_provider !== "coinbase_exchange") return false;
  const retrievedAt = Number(market.book_retrieved_at_ms);
  if (!Number.isFinite(retrievedAt) || retrievedAt <= 0 || !Number.isFinite(nowMs) ||
      !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return false;
  const age = nowMs - retrievedAt;
  if (age < -1000 || age > maxAgeMs) return false;
  return normalizeShadowBookLevels(market.book_asks, "asks") !== null &&
    normalizeShadowBookLevels(market.book_bids, "bids") !== null;
}
