/**
 * Refresh Coinbase Advanced Trade public books used only by the independent
 * Shadow simulator. Call this before the final Coinbase Exchange book pass so
 * slow/retried Shadow requests cannot age the 15-second PAPER entry books.
 */
export async function refreshCoinbaseShadowBooks(
  markets,
  { fetchBook, requestState } = {}
) {
  const rows = Array.isArray(markets) ? markets : [];
  if (typeof fetchBook !== "function") {
    throw new TypeError("shadow_book_fetcher_required");
  }

  let refreshed = 0;
  let failed = 0;
  const issues = [];

  for (const market of rows) {
    if (!market || market.status !== "live") continue;
    if (market.market_data_provider !== "coinbase_exchange") {
      market.shadow_bid = null;
      market.shadow_ask = null;
      market.shadow_bid_depth_quote = null;
      market.shadow_ask_depth_quote = null;
      market.shadow_book_bids = null;
      market.shadow_book_asks = null;
      market.shadow_book_retrieved_at_ms = null;
      market.shadow_book_event_time_ms = null;
      market.shadow_book_age_ms = null;
      market.shadow_book_source = null;
      market.shadow_last = null;
      market.shadow_book_status = "unsupported_market_source";
      market.shadow_book_error = "coinbase_exchange_market_data_required";
      continue;
    }

    try {
      const book = await fetchBook(market.product, requestState);
      market.shadow_bid = book.bid;
      market.shadow_ask = book.ask;
      market.shadow_bid_depth_quote = book.bid_depth_quote;
      market.shadow_ask_depth_quote = book.ask_depth_quote;
      market.shadow_book_bids = book.book_bids;
      market.shadow_book_asks = book.book_asks;
      market.shadow_book_retrieved_at_ms = book.book_retrieved_at_ms;
      market.shadow_book_event_time_ms = book.book_event_time_ms;
      market.shadow_book_age_ms = book.book_age_ms;
      market.shadow_book_source = book.book_source;
      market.shadow_last = book.last;
      market.shadow_book_status = "available";
      market.shadow_book_error = null;
      refreshed += 1;
    } catch (error) {
      const rawCode = typeof error?.code === "string"
        ? error.code : String(error?.message || "advanced_public_book_failed");
      const errorCode = /^[a-z0-9_]{1,100}$/.test(rawCode)
        ? rawCode : "advanced_public_book_failed";
      market.shadow_bid = null;
      market.shadow_ask = null;
      market.shadow_bid_depth_quote = null;
      market.shadow_ask_depth_quote = null;
      market.shadow_book_bids = null;
      market.shadow_book_asks = null;
      market.shadow_book_retrieved_at_ms = null;
      market.shadow_book_event_time_ms = null;
      market.shadow_book_age_ms = null;
      market.shadow_book_source = null;
      market.shadow_last = null;
      market.shadow_book_status = "provider_error";
      market.shadow_book_error = errorCode;
      failed += 1;
      issues.push({
        symbol: typeof market.symbol === "string" ? market.symbol : null,
        reason: errorCode
      });
    }
  }

  return { refreshed, failed, issues };
}
