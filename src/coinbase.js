import { auditCandles } from "./strategy.js";

const BASE_URL = "https://api.exchange.coinbase.com";
const MIN_PUBLIC_REQUEST_GAP_MS = 350;
const MAX_RETRY_ATTEMPTS = 3;
// Avoid sleeping through most of a scheduled scan when a provider asks for a long cooldown.
const MAX_INLINE_COOLDOWN_WAIT_MS = 30000;
const MAX_BITSTAMP_INLINE_RETRY_WAIT_MS = 1200;
const BITSTAMP_BASE_URL = "https://www.bitstamp.net/api/v2";
const BITSTAMP_PAIRS = {
  "BTC-USD": "btcusd",
  "ETH-USD": "ethusd",
  "SOL-USD": "solusd"
};
const DEFAULT_BITSTAMP_REQUEST_STATE = { lastPublicRequestAt: 0, publicCooldownUntilMs: 0 };
const DEFAULT_REQUEST_STATE = {
  lastPublicRequestAt: 0,
  publicCooldownUntilMs: 0,
  bitstamp: { ...DEFAULT_BITSTAMP_REQUEST_STATE }
};

export function createCoinbaseRequestState() {
  return {
    lastPublicRequestAt: 0,
    publicCooldownUntilMs: 0,
    bitstamp: { ...DEFAULT_BITSTAMP_REQUEST_STATE }
  };
}

export function parseRetryAfterMs(value, nowMs = Date.now()) {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  if (!text) return null;
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(text);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : null;
}
export const PRODUCTS = [
  { symbol: "BTC/USD", product: "BTC-USD" },
  { symbol: "ETH/USD", product: "ETH-USD" },
  { symbol: "SOL/USD", product: "SOL-USD" }
];

/**
 * Reuse a persisted snapshot until the next timeframe candle has closed.
 * Each row time is its candle-open timestamp; the next bar closes at
 * lastTime + 2 * intervalMs. Invalid or short histories force a refresh.
 */
export function shouldRefreshCandleHistory(rows, intervalMs, nowMs = Date.now(), minimumBars = 150) {
  if (!Array.isArray(rows) || !Number.isFinite(intervalMs) || intervalMs <= 0 ||
      !Number.isFinite(nowMs) || rows.length < minimumBars) return true;
  const lastTime = Number(rows[rows.length - 1]?.time);
  if (!Number.isFinite(lastTime) || lastTime % intervalMs !== 0) return true;
  return nowMs >= lastTime + (2 * intervalMs);
}

export async function getJson(path, requestState = DEFAULT_REQUEST_STATE) {
  const state = requestState && typeof requestState === "object" ? requestState : DEFAULT_REQUEST_STATE;
  for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt += 1) {
    const now = Date.now();
    const lastRequestAt = Number(state.lastPublicRequestAt) || 0;
    const cooldownUntil = Number(state.publicCooldownUntilMs) || 0;
    const pacingWait = Math.max(0, MIN_PUBLIC_REQUEST_GAP_MS - (now - lastRequestAt));
    const cooldownWait = Math.max(0, cooldownUntil - now);
    if (cooldownWait > MAX_INLINE_COOLDOWN_WAIT_MS) {
      const error = new Error("Coinbase public API cooldown active; request deferred");
      error.status = 429;
      error.retryAfterMs = cooldownWait;
      throw error;
    }
    const waitMs = Math.max(pacingWait, cooldownWait);
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    state.lastPublicRequestAt = Date.now();
    let response;
    try {
      response = await fetch(BASE_URL + path, {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "User-Agent": "AI-Trading-Terminal-Free-Paper/1.0"
        },
        signal: AbortSignal.timeout(10000)
      });
    } catch (cause) {
      if (attempt === MAX_RETRY_ATTEMPTS - 1) throw cause;
      const backoffMs = Math.min(8000, 1000 * (2 ** attempt)) + Math.floor(Math.random() * 250);
      state.publicCooldownUntilMs = Math.max(Number(state.publicCooldownUntilMs) || 0, Date.now() + backoffMs);
      continue;
    }
    if (response.ok) return response.json();
    const status = response.status;
    const retryable = status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
    if (retryable) {
      const canRetry = attempt < MAX_RETRY_ATTEMPTS - 1;
      const retryAfter = parseRetryAfterMs(response.headers.get("retry-after"));
      const backoffMs = retryAfter ?? (Math.min(8000, 1000 * (2 ** attempt)) + Math.floor(Math.random() * 250));
      // Preserve cooldown even when the final permitted attempt is rate-limited.
      state.publicCooldownUntilMs = Math.max(Number(state.publicCooldownUntilMs) || 0, Date.now() + backoffMs);
      if (backoffMs > MAX_INLINE_COOLDOWN_WAIT_MS || !canRetry) {
        const error = new Error(backoffMs > MAX_INLINE_COOLDOWN_WAIT_MS
          ? "Coinbase public API rate limit; retry deferred by provider cooldown"
          : "Coinbase public API retry attempts exhausted");
        error.status = status;
        error.retryAfterMs = backoffMs;
        throw error;
      }
      continue;
    }
    const error = new Error("Coinbase public API returned HTTP " + status);
    error.status = status;
    throw error;
  }
  throw new Error("Coinbase public API retry attempts exhausted");
}

function parseBookSide(levels) {
  if (!Array.isArray(levels)) return null;
  let total = 0;
  for (const level of levels.slice(0, 10)) {
    const price = Number(level?.[0]);
    const size = Number(level?.[1]);
    if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size < 0) return null;
    total += price * size;
  }
  return total;
}

/**
 * Refresh only the Coinbase L2 book after slower candle/history work has completed.
 * Keeps the strict 15s entry freshness gate without repeating ticker/candle requests.
 */
export async function fetchCoinbaseOrderBook(product, requestState = DEFAULT_REQUEST_STATE) {
  const productId = typeof product === "string" ? product : product?.product;
  if (typeof productId !== "string" || !/^[A-Z0-9]+-[A-Z0-9]+$/.test(productId)) {
    const error = new Error("invalid_coinbase_product_for_order_book"); error.status = 400; throw error;
  }
  const book = await getJson("/products/" + encodeURIComponent(productId) + "/book?level=2", requestState);
  const bids = Array.isArray(book?.bids) ? book.bids : [];
  const asks = Array.isArray(book?.asks) ? book.asks : [];
  const bestBid = Number(bids[0]?.[0]);
  const bestAsk = Number(asks[0]?.[0]);
  const bidDepth = parseBookSide(bids);
  const askDepth = parseBookSide(asks);
  if (![bestBid, bestAsk, bidDepth, askDepth].every(Number.isFinite) || bestBid <= 0 || bestAsk < bestBid || bidDepth < 0 || askDepth < 0) {
    const error = new Error("coinbase_order_book_failed_validation"); error.status = 502; throw error;
  }
  return { bid: bestBid, ask: bestAsk, bid_depth_quote: bidDepth, ask_depth_quote: askDepth,
    book_retrieved_at_ms: Date.now(), book_age_ms: 0,
    book_sequence: book?.sequence == null || !Number.isSafeInteger(Number(book.sequence)) ? null : Number(book.sequence) };
}

/**
 * Refresh only a Bitstamp USD SPOT L2 book for a market whose selected
 * provider is already Bitstamp. Keep exchange event-time validation strict.
 */
export async function fetchBitstampOrderBook(product, requestState = DEFAULT_REQUEST_STATE) {
  const pair = BITSTAMP_PAIRS[product];
  if (!pair) {
    const error = new Error("invalid_bitstamp_product_for_order_book");
    error.code = "invalid_bitstamp_product_for_order_book";
    error.status = 400;
    throw error;
  }
  const state = bitstampRequestState(requestState);
  const book = await getBitstampJson("/order_book/" + pair + "/?group=1", state);
  const retrievedAtMs = Date.now();
  const eventTimeMs = Number(book?.timestamp) * 1000;
  const eventAgeMs = retrievedAtMs - eventTimeMs;
  if (!Number.isFinite(eventTimeMs) || eventTimeMs <= 0 ||
      eventAgeMs < -1000 || eventAgeMs > 15000) {
    const error = new Error("bitstamp_order_book_timestamp_invalid_or_stale");
    error.code = "provider_timestamp_invalid_or_stale";
    error.status = 502;
    throw error;
  }
  const bids = Array.isArray(book?.bids) ? book.bids : [];
  const asks = Array.isArray(book?.asks) ? book.asks : [];
  const bestBid = Number(bids[0]?.[0]);
  const bestAsk = Number(asks[0]?.[0]);
  const bidDepth = parseBookSide(bids);
  const askDepth = parseBookSide(asks);
  if (![bestBid, bestAsk, bidDepth, askDepth].every(Number.isFinite) ||
      bestBid <= 0 || bestAsk < bestBid || bidDepth < 0 || askDepth < 0) {
    const error = new Error("bitstamp_order_book_failed_validation");
    error.code = "order_book_failed_validation";
    error.status = 502;
    throw error;
  }
  return {
    bid: bestBid,
    ask: bestAsk,
    bid_depth_quote: bidDepth,
    ask_depth_quote: askDepth,
    book_retrieved_at_ms: retrievedAtMs,
    book_event_time_ms: eventTimeMs,
    book_age_ms: 0,
    book_sequence: null
  };
}

function convertCandles(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((row) => {
    if (!Array.isArray(row) || row.length < 6) return null;
    return {
      time: Number(row[0]) * 1000,
      low: Number(row[1]),
      high: Number(row[2]),
      open: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5])
    };
  }).filter(Boolean);
}

function providerErrorCode(error) {
  const status = Number(error?.status);
  if (status === 429) return "provider_rate_limited";
  if (Number.isFinite(status) && status >= 500) return "provider_server_error";
  if (Number.isFinite(status) && status >= 400) return "provider_http_error";
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "provider_timeout";
  return "provider_network_error";
}

function auditIsFresh(audit, intervalMs, nowMs, maxAgeMs) {
  const lastOpenMs = Number(audit?.rows?.at(-1)?.time);
  if (audit?.ok !== true || !Number.isFinite(lastOpenMs)) return false;
  const closeMs = lastOpenMs + intervalMs;
  const ageMs = nowMs - closeMs;
  return ageMs >= -1000 && ageMs <= maxAgeMs;
}

async function loadCandleHistory({
  product,
  timeframeSeconds,
  intervalMs,
  cachedRows,
  cachedAudit,
  requestState,
  nowMs,
  maxStaleMs
}) {
  const useCache = cachedAudit?.ok === true &&
    !shouldRefreshCandleHistory(cachedRows, intervalMs, nowMs, 150);
  if (useCache) {
    return {
      audit: cachedAudit,
      source: "durable_object_archive",
      refresh_status: "cache_reused",
      refresh_error: null
    };
  }

  try {
    const raw = await getJson(
      "/products/" + encodeURIComponent(product) + "/candles?granularity=" + timeframeSeconds,
      requestState
    );
    const rows = convertCandles(raw);
    const audit = auditCandles(rows, intervalMs, nowMs, 150);
    if (audit.ok) {
      return {
        audit,
        source: "coinbase_exchange_rest",
        refresh_status: "refreshed",
        refresh_error: null
      };
    }

    // Do not throw away the last known-good candles merely because a newly
    // fetched response is malformed. Reuse them only while their close age is
    // inside the strategy's explicit stale-data tolerance.
    if (auditIsFresh(cachedAudit, intervalMs, nowMs, maxStaleMs)) {
      return {
        audit: cachedAudit,
        source: "durable_object_archive_fallback",
        refresh_status: "invalid_refresh_cache_fallback",
        refresh_error: "candle_integrity_failed"
      };
    }
    return {
      audit,
      source: "coinbase_exchange_rest",
      refresh_status: "refresh_rejected",
      refresh_error: "candle_integrity_failed"
    };
  } catch (error) {
    const canUseCache = cachedAudit?.ok === true &&
      auditIsFresh(cachedAudit, intervalMs, nowMs, maxStaleMs);
    return {
      audit: cachedAudit || auditCandles([], intervalMs, nowMs, 150),
      source: canUseCache ? "durable_object_archive_fallback" : "durable_object_archive_stale",
      refresh_status: canUseCache ? "provider_error_cache_fallback" : "provider_error_no_fresh_cache",
      refresh_error: providerErrorCode(error)
    };
  }
}

async function fetchCoinbaseProductSnapshot({ symbol, product }, nowMs = Date.now(), cachedCandles = {}, requestState = DEFAULT_REQUEST_STATE) {
  const encoded = encodeURIComponent(product);

  // The ticker is the minimum required input for valuing an existing PAPER
  // position. Capture its local response time separately from the embedded
  // timestamp, which describes the last trade and can legitimately be older
  // than a fresh best-bid/best-ask snapshot.
  const ticker = await getJson("/products/" + encoded + "/ticker", requestState);
  const quoteReceivedAtMs = Date.now();
  const bid = Number(ticker?.bid);
  const ask = Number(ticker?.ask);
  const last = Number(ticker?.price);
  const tickerMs = Date.parse(ticker?.time || "");

  // Coinbase's ticker already includes 24-hour base volume. Use it first so
  // every scan does not need an additional /stats request. Fetch /stats only
  // as a compatibility fallback when that field is absent or malformed.
  let baseVolume = Number(ticker?.volume);
  let volumeSource = "ticker_24h_volume";
  let volumeStatus = Number.isFinite(baseVolume) && baseVolume >= 0 ? "available" : "unavailable";
  if (volumeStatus === "unavailable") {
    try {
      const stats = await getJson("/products/" + encoded + "/stats", requestState);
      baseVolume = Number(stats?.volume);
      volumeStatus = Number.isFinite(baseVolume) && baseVolume >= 0 ? "available" : "invalid";
      volumeSource = "product_stats_fallback";
    } catch (error) {
      baseVolume = Number.NaN;
      volumeStatus = "unavailable";
      volumeSource = "unavailable";
    }
  }
  const quoteVolume = Number.isFinite(baseVolume) && Number.isFinite(last) && last > 0
    ? baseVolume * last : Number.NaN;

  // Book and candle endpoints are strategy-entry inputs, not prerequisites for
  // marking or closing an already-open PAPER position. Keep the book request
  // until after all sequential candle refreshes so the 15s entry-freshness
  // window is measured from a snapshot captured immediately before evaluation.

  const cachedOneMinute = Array.isArray(cachedCandles.one_minute) ? cachedCandles.one_minute : [];
  const cachedFiveMinute = Array.isArray(cachedCandles.five_minute) ? cachedCandles.five_minute : [];
  const cachedOneHour = Array.isArray(cachedCandles.one_hour) ? cachedCandles.one_hour : [];
  const cachedSixHour = Array.isArray(cachedCandles.six_hour) ? cachedCandles.six_hour : [];
  const cachedOneMinuteAudit = cachedOneMinute.length ? auditCandles(cachedOneMinute, 60000, nowMs, 150) : null;
  const cachedFiveMinuteAudit = cachedFiveMinute.length ? auditCandles(cachedFiveMinute, 300000, nowMs, 150) : null;
  const cachedOneHourAudit = cachedOneHour.length
    ? auditCandles(cachedOneHour, 3600000, nowMs, 150) : null;
  const cachedSixHourAudit = cachedSixHour.length
    ? auditCandles(cachedSixHour, 21600 * 1000, nowMs, 150) : null;

  // Keep provider requests sequential: getJson shares one pacing/cooldown
  // state, and parallel timeframe refreshes could bypass the 350ms request gap.
  const oneMinuteResult = await loadCandleHistory({
    product, timeframeSeconds: 60, intervalMs: 60000,
    cachedRows: cachedOneMinute, cachedAudit: cachedOneMinuteAudit,
    requestState, nowMs, maxStaleMs: 180000
  });
  const fiveMinuteResult = await loadCandleHistory({
    product, timeframeSeconds: 300, intervalMs: 300000,
    cachedRows: cachedFiveMinute, cachedAudit: cachedFiveMinuteAudit,
    requestState, nowMs, maxStaleMs: 420000
  });
  const oneHourResult = await loadCandleHistory({
    product, timeframeSeconds: 3600, intervalMs: 3600000,
    cachedRows: cachedOneHour, cachedAudit: cachedOneHourAudit,
    requestState, nowMs, maxStaleMs: 5400000
  });
  const sixHourResult = await loadCandleHistory({
    product, timeframeSeconds: 21600, intervalMs: 21600 * 1000,
    cachedRows: cachedSixHour, cachedAudit: cachedSixHourAudit,
    requestState, nowMs, maxStaleMs: 25200000
  });

  let book = null;
  let bookError = null;
  let bookRetrievedAtMs = null;
  try {
    book = await getJson("/products/" + encoded + "/book?level=2", requestState);
    bookRetrievedAtMs = Date.now();
  } catch (error) {
    bookError = providerErrorCode(error);
  }

  const oneMinuteAudit = oneMinuteResult.audit;
  const fiveMinuteAudit = fiveMinuteResult.audit;
  const oneHourAudit = oneHourResult.audit;
  const sixHourAudit = sixHourResult.audit;
  const bidDepth = book ? parseBookSide(book.bids) : null;
  const askDepth = book ? parseBookSide(book.asks) : null;
  const spreadBps = Number.isFinite(bid) && Number.isFinite(ask) && ask >= bid && ask + bid > 0
    ? ((ask - bid) / ((ask + bid) / 2)) * 10000 : null;
  const bookSequence = book?.sequence == null || !Number.isSafeInteger(Number(book.sequence))
    ? null : Number(book.sequence);

  return {
    symbol,
    product,
    status: "live",
    market_data_provider: "coinbase_exchange",
    fetched_at_ms: nowMs,
    quote_received_at_ms: quoteReceivedAtMs,
    ticker_time: Number.isFinite(tickerMs) ? new Date(tickerMs).toISOString() : null,
    book_retrieved_at_ms: bookRetrievedAtMs,
    book_age_ms: bookRetrievedAtMs === null ? null : Math.max(0, Date.now() - bookRetrievedAtMs),
    book_sequence: bookSequence,
    bid,
    ask,
    last,
    spread_bps: spreadBps,
    quote_volume_usd: Number.isFinite(quoteVolume) && quoteVolume >= 0 ? quoteVolume : null,
    bid_depth_quote: bidDepth,
    ask_depth_quote: askDepth,
    one_minute_audit: oneMinuteAudit,
    five_minute_audit: fiveMinuteAudit,
    one_hour_audit: oneHourAudit,
    six_hour_audit: sixHourAudit,
    data_quality: {
      market_data_provider: "coinbase_exchange",
      ticker_provider: "coinbase_exchange",
      book_provider: "coinbase_exchange",
      one_minute_provider: "coinbase_exchange",
      five_minute_provider: "coinbase_exchange",
      one_hour_provider: "coinbase_exchange",
      six_hour_provider: "coinbase_exchange",
      ticker_status: "available",
      quote_freshness_source: "local_ticker_response_time_for_exit_marking",
      ticker_event_time_source: "last_trade_timestamp_for_entry_eligibility",
      quote_volume_status: volumeStatus,
      quote_volume_source: volumeSource,
      book_status: bookError ? "provider_error" : (bidDepth === null || askDepth === null ? "invalid_or_missing" : "available"),
      book_error: bookError,
      one_minute: { ok: oneMinuteAudit.ok, issues: oneMinuteAudit.issues, bars: oneMinuteAudit.valid_closed_bars },
      five_minute: { ok: fiveMinuteAudit.ok, issues: fiveMinuteAudit.issues, bars: fiveMinuteAudit.valid_closed_bars },
      one_hour: {
        ok: oneHourAudit.ok,
        issues: oneHourAudit.issues,
        bars: oneHourAudit.valid_closed_bars
      },
      six_hour: {
        ok: sixHourAudit.ok,
        issues: sixHourAudit.issues,
        bars: sixHourAudit.valid_closed_bars
      },
      one_minute_source: oneMinuteResult.source,
      five_minute_source: fiveMinuteResult.source,
      one_minute_refresh_status: oneMinuteResult.refresh_status,
      five_minute_refresh_status: fiveMinuteResult.refresh_status,
      one_minute_refresh_error: oneMinuteResult.refresh_error,
      five_minute_refresh_error: fiveMinuteResult.refresh_error,
      one_hour_source: oneHourResult.source,
      six_hour_source: sixHourResult.source,
      one_hour_refresh_status: oneHourResult.refresh_status,
      six_hour_refresh_status: sixHourResult.refresh_status,
      one_hour_refresh_error: oneHourResult.refresh_error,
      six_hour_refresh_error: sixHourResult.refresh_error,
      book_freshness_source: "local_retrieval_time",
      book_sequence_available: bookSequence !== null
    }
  };
}


function bitstampRequestState(requestState) {
  if (requestState && typeof requestState === "object") {
    if (!requestState.bitstamp || typeof requestState.bitstamp !== "object") {
      requestState.bitstamp = { ...DEFAULT_BITSTAMP_REQUEST_STATE };
    }
    return requestState.bitstamp;
  }
  return DEFAULT_BITSTAMP_REQUEST_STATE;
}

async function getBitstampJson(path, requestState = DEFAULT_BITSTAMP_REQUEST_STATE) {
  const state = requestState && typeof requestState === "object"
    ? requestState : DEFAULT_BITSTAMP_REQUEST_STATE;
  const maxAttempts = 2;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const nowMs = Date.now();
    const pacingWait = Math.max(
      0,
      MIN_PUBLIC_REQUEST_GAP_MS - (nowMs - (Number(state.lastPublicRequestAt) || 0))
    );
    const cooldownWait = Math.max(0, (Number(state.publicCooldownUntilMs) || 0) - nowMs);
    if (cooldownWait > MAX_INLINE_COOLDOWN_WAIT_MS) {
      const error = new Error("Bitstamp public API cooldown active; retry deferred");
      error.status = 429;
      error.retryAfterMs = cooldownWait;
      throw error;
    }
    const waitMs = Math.max(pacingWait, cooldownWait);
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    state.lastPublicRequestAt = Date.now();

    let response;
    try {
      response = await fetch(BITSTAMP_BASE_URL + path, {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "User-Agent": "AI-Trading-Terminal-Paper-Market-Data/1.0"
        },
        signal: AbortSignal.timeout(8000)
      });
    } catch (cause) {
      if (attempt === maxAttempts - 1) throw cause;
      await new Promise((resolve) => setTimeout(resolve, 400));
      continue;
    }

    if (response.ok) {
      try {
        return await response.json();
      } catch {
        const error = new Error("Bitstamp public API returned invalid JSON");
        error.status = 502;
        throw error;
      }
    }

    const status = response.status;
    const retryable = status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
    if (!retryable || attempt === maxAttempts - 1) {
      const error = new Error("Bitstamp public API returned HTTP " + status);
      error.status = status;
      throw error;
    }

    const retryAfter = parseRetryAfterMs(response.headers.get("retry-after"));
    const delayMs = retryAfter ?? 500;
    state.publicCooldownUntilMs = Math.max(
      Number(state.publicCooldownUntilMs) || 0,
      Date.now() + delayMs
    );
    if (delayMs > MAX_BITSTAMP_INLINE_RETRY_WAIT_MS) {
      const error = new Error("Bitstamp public API retry deferred by provider cooldown");
      error.status = status;
      error.retryAfterMs = delayMs;
      throw error;
    }
  }

  throw new Error("Bitstamp public API retry attempts exhausted");
}

function convertBitstampCandles(payload) {
  const rows = payload?.data?.ohlc;
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    time: Number(row?.timestamp) * 1000,
    open: Number(row?.open),
    high: Number(row?.high),
    low: Number(row?.low),
    close: Number(row?.close),
    volume: Number(row?.volume)
  }));
}

/**
 * Fetch a bounded historical research window from the explicitly verified
 * Bitstamp USD SPOT market. Uses the documented 1,000-candle maximum and pages
 * backwards with the `end` timestamp. This function is research-only: it does
 * not supply the live ticker, order book, or PAPER entry/exit path.
 */
export async function fetchBitstampResearchHistory({
  product,
  nowMs = Date.now(),
  oneHourBars = 3500,
  sixHourBars = 600,
  requestState = DEFAULT_REQUEST_STATE
} = {}) {
  const pair = BITSTAMP_PAIRS[product];
  if (!pair || !Number.isFinite(nowMs) || nowMs <= 0 ||
      !Number.isSafeInteger(oneHourBars) || oneHourBars < 150 || oneHourBars > 4320 ||
      !Number.isSafeInteger(sixHourBars) || sixHourBars < 150 || sixHourBars > 1440) {
    const error = new Error("invalid Bitstamp research backfill request");
    error.code = "invalid_research_backfill_request";
    error.status = 400;
    throw error;
  }

  const state = bitstampRequestState(requestState);
  const markets = await getBitstampJson("/markets/", state);
  const market = Array.isArray(markets)
    ? markets.find((row) => String(row?.market_symbol || "").toLowerCase() === pair)
    : null;
  const expectedPair = product.toUpperCase().replace("-", "/");
  if (!market || String(market.market_type || "").toUpperCase() !== "SPOT" ||
      String(market.counter_currency || "").toUpperCase() !== "USD" ||
      String(market.trading || "").toLowerCase() !== "enabled") {
    const error = new Error("Bitstamp historical market is not an enabled USD SPOT pair");
    error.code = "research_backfill_market_not_enabled_spot";
    error.status = 409;
    throw error;
  }

  async function fetchHistory(timeframeSeconds, targetBars) {
    const intervalMs = timeframeSeconds * 1000;
    const collected = new Map();
    let endSeconds = Math.floor(nowMs / 1000);
    let requests = 0;
    const maximumRequests = Math.ceil(targetBars / 1000) + 2;

    while (collected.size < targetBars && requests < maximumRequests) {
      const pageLimit = Math.min(1000, targetBars - collected.size);
      const payload = await getBitstampJson(
        "/ohlc/" + pair + "/?step=" + timeframeSeconds +
          "&limit=" + pageLimit + "&end=" + endSeconds +
          "&exclude_current_candle=true",
        state
      );
      requests += 1;
      const responsePair = String(payload?.data?.pair || "").toUpperCase().replace(/\\s+/g, "");
      if (responsePair !== expectedPair) {
        const error = new Error("Bitstamp historical OHLC response pair mismatch");
        error.code = "research_backfill_pair_mismatch";
        error.status = 502;
        throw error;
      }

      const rows = convertBitstampCandles(payload);
      if (!rows.length) break;
      let oldestSeconds = Number.POSITIVE_INFINITY;
      for (const row of rows) {
        if (!Number.isFinite(row.time) || row.time + intervalMs > nowMs) continue;
        const timestampSeconds = Math.floor(row.time / 1000);
        oldestSeconds = Math.min(oldestSeconds, timestampSeconds);
        if (!collected.has(row.time)) collected.set(row.time, row);
      }
      if (!Number.isFinite(oldestSeconds)) break;
      if (oldestSeconds >= endSeconds) {
        const error = new Error("Bitstamp historical OHLC pagination did not move backwards");
        error.code = "research_backfill_pagination_stalled";
        error.status = 502;
        throw error;
      }
      endSeconds = oldestSeconds - 1;
    }

    const orderedRows = [...collected.values()].sort((a, b) => a.time - b.time);
    const audit = auditCandles(orderedRows, intervalMs, nowMs, targetBars);
    if (!audit.ok || audit.valid_closed_bars < targetBars) {
      const error = new Error(
        "Bitstamp historical " + timeframeSeconds + "s candle history failed integrity or sample-size checks"
      );
      error.code = "research_backfill_candle_integrity_failed";
      error.status = 422;
      error.issues = audit.issues;
      error.valid_closed_bars = audit.valid_closed_bars;
      error.expected_bars = targetBars;
      throw error;
    }
    return { audit, requests };
  }

  const oneHour = await fetchHistory(3600, oneHourBars);
  const sixHour = await fetchHistory(21600, sixHourBars);
  return {
    product,
    symbol: product.replace("-", "/"),
    provider: "bitstamp_spot",
    market_type: "SPOT",
    quote_currency: "USD",
    fetched_at_ms: Date.now(),
    one_hour: oneHour.audit,
    six_hour: sixHour.audit,
    requests: {
      markets: 1,
      one_hour: oneHour.requests,
      six_hour: sixHour.requests
    }
  };
}

async function loadBitstampCandleHistory({
  symbol,
  pair,
  timeframeSeconds,
  intervalMs,
  cachedRows,
  cachedAudit,
  requestState,
  nowMs,
  maxStaleMs
}) {
  const useCache = cachedAudit?.ok === true &&
    !shouldRefreshCandleHistory(cachedRows, intervalMs, nowMs, 150);
  if (useCache) {
    return {
      audit: cachedAudit,
      source: "bitstamp_durable_object_archive",
      refresh_status: "cache_reused",
      refresh_error: null
    };
  }

  try {
    const payload = await getBitstampJson(
      "/ohlc/" + pair + "/?step=" + timeframeSeconds + "&limit=200&exclude_current_candle=true",
      requestState
    );
    const responsePair = String(payload?.data?.pair || "").toUpperCase().replace(/\s+/g, "");
    const expectedPair = symbol.toUpperCase().replace(/\s+/g, "");
    if (responsePair !== expectedPair) {
      const error = new Error("Bitstamp OHLC response pair mismatch");
      error.status = 502;
      throw error;
    }

    const rows = convertBitstampCandles(payload);
    const audit = auditCandles(rows, intervalMs, nowMs, 150);
    if (audit.ok) {
      return {
        audit,
        source: "bitstamp_spot_rest",
        refresh_status: "refreshed",
        refresh_error: null
      };
    }

    if (auditIsFresh(cachedAudit, intervalMs, nowMs, maxStaleMs)) {
      return {
        audit: cachedAudit,
        source: "bitstamp_durable_object_archive_fallback",
        refresh_status: "invalid_refresh_cache_fallback",
        refresh_error: "candle_integrity_failed"
      };
    }
    return {
      audit,
      source: "bitstamp_spot_rest",
      refresh_status: "refresh_rejected",
      refresh_error: "candle_integrity_failed"
    };
  } catch (error) {
    const canUseCache = cachedAudit?.ok === true &&
      auditIsFresh(cachedAudit, intervalMs, nowMs, maxStaleMs);
    return {
      audit: cachedAudit || auditCandles([], intervalMs, nowMs, 150),
      source: canUseCache ? "bitstamp_durable_object_archive_fallback" : "bitstamp_durable_object_archive_stale",
      refresh_status: canUseCache ? "provider_error_cache_fallback" : "provider_error_no_fresh_cache",
      refresh_error: providerErrorCode(error)
    };
  }
}

async function fetchBitstampProductSnapshot(
  { symbol, product },
  nowMs,
  cachedCandles,
  requestState
) {
  const pair = BITSTAMP_PAIRS[product];
  if (!pair) {
    const error = new Error("Bitstamp backup market is not configured for " + product);
    error.status = 404;
    throw error;
  }

  const bitstampState = bitstampRequestState(requestState);
  const ticker = await getBitstampJson("/ticker/" + pair + "/", bitstampState);
  const quoteReceivedAtMs = Date.now();
  const bid = Number(ticker?.bid);
  const ask = Number(ticker?.ask);
  const last = Number(ticker?.last);
  const tickerTimestampMs = Number(ticker?.timestamp) * 1000;

  if (String(ticker?.market_type || "").toUpperCase() !== "SPOT" ||
      ![bid, ask, last, tickerTimestampMs].every(Number.isFinite) ||
      bid <= 0 || ask < bid || last <= 0 || tickerTimestampMs <= 0 ||
      tickerTimestampMs > Date.now() + 5000) {
    const error = new Error("Bitstamp ticker response failed quote validation");
    error.status = 502;
    throw error;
  }

  // Fetch the order book after candle refreshes so its strict 15s freshness
  // window is not consumed by sequential historical-data requests.
  let book = null;
  let bookError = null;
  let bookRetrievedAtMs = null;
  let bookEventTimeMs = null;

  const bitstampCache = cachedCandles?.bitstamp || {};
  const cachedOneMinute = Array.isArray(bitstampCache.one_minute) ? bitstampCache.one_minute : [];
  const cachedFiveMinute = Array.isArray(bitstampCache.five_minute) ? bitstampCache.five_minute : [];
  const cachedOneHour = Array.isArray(bitstampCache.one_hour) ? bitstampCache.one_hour : [];
  const cachedSixHour = Array.isArray(bitstampCache.six_hour) ? bitstampCache.six_hour : [];
  const cachedOneMinuteAudit = cachedOneMinute.length ? auditCandles(cachedOneMinute, 60000, nowMs, 150) : null;
  const cachedFiveMinuteAudit = cachedFiveMinute.length ? auditCandles(cachedFiveMinute, 300000, nowMs, 150) : null;
  const cachedOneHourAudit = cachedOneHour.length
    ? auditCandles(cachedOneHour, 3600000, nowMs, 150) : null;
  const cachedSixHourAudit = cachedSixHour.length
    ? auditCandles(cachedSixHour, 21600 * 1000, nowMs, 150) : null;

  const oneMinuteResult = await loadBitstampCandleHistory({
    symbol, pair, timeframeSeconds: 60, intervalMs: 60000,
    cachedRows: cachedOneMinute, cachedAudit: cachedOneMinuteAudit,
    requestState: bitstampState, nowMs, maxStaleMs: 180000
  });
  const fiveMinuteResult = await loadBitstampCandleHistory({
    symbol, pair, timeframeSeconds: 300, intervalMs: 300000,
    cachedRows: cachedFiveMinute, cachedAudit: cachedFiveMinuteAudit,
    requestState: bitstampState, nowMs, maxStaleMs: 420000
  });
  const oneHourResult = await loadBitstampCandleHistory({
    symbol, pair, timeframeSeconds: 3600, intervalMs: 3600000,
    cachedRows: cachedOneHour, cachedAudit: cachedOneHourAudit,
    requestState: bitstampState, nowMs, maxStaleMs: 5400000
  });
  const sixHourResult = await loadBitstampCandleHistory({
    symbol, pair, timeframeSeconds: 21600, intervalMs: 21600 * 1000,
    cachedRows: cachedSixHour, cachedAudit: cachedSixHourAudit,
    requestState: bitstampState, nowMs, maxStaleMs: 25200000
  });

  try {
    book = await getBitstampJson("/order_book/" + pair + "/?group=1", bitstampState);
    bookRetrievedAtMs = Date.now();
    bookEventTimeMs = Number(book?.timestamp) * 1000;
    const bookEventAgeMs = bookRetrievedAtMs - bookEventTimeMs;
    if (!Number.isFinite(bookEventTimeMs) || bookEventTimeMs <= 0 ||
        bookEventAgeMs < -1000 || bookEventAgeMs > 15000) {
      bookError = "provider_timestamp_invalid_or_stale";
    }
  } catch (error) {
    bookError = providerErrorCode(error);
  }

  const bidDepth = book ? parseBookSide(book.bids) : null;
  const askDepth = book ? parseBookSide(book.asks) : null;
  const spreadBps = ((ask - bid) / ((ask + bid) / 2)) * 10000;
  const quoteVolume = Number(ticker?.volume) * last;

  return {
    symbol,
    product,
    status: "live",
    market_data_provider: "bitstamp_spot",
    fetched_at_ms: nowMs,
    quote_received_at_ms: quoteReceivedAtMs,
    ticker_time: new Date(tickerTimestampMs).toISOString(),
    book_retrieved_at_ms: bookRetrievedAtMs,
    book_event_time_ms: bookEventTimeMs,
    book_age_ms: bookRetrievedAtMs === null ? null : Math.max(0, Date.now() - bookRetrievedAtMs),
    book_sequence: null,
    bid,
    ask,
    last,
    spread_bps: Number.isFinite(spreadBps) ? spreadBps : null,
    quote_volume_usd: Number.isFinite(quoteVolume) && quoteVolume >= 0 ? quoteVolume : null,
    bid_depth_quote: bidDepth,
    ask_depth_quote: askDepth,
    one_minute_audit: oneMinuteResult.audit,
    five_minute_audit: fiveMinuteResult.audit,
    one_hour_audit: oneHourResult.audit,
    six_hour_audit: sixHourResult.audit,
    data_quality: {
      market_data_provider: "bitstamp_spot",
      ticker_provider: "bitstamp_spot",
      book_provider: "bitstamp_spot",
      one_minute_provider: "bitstamp_spot",
      five_minute_provider: "bitstamp_spot",
      one_hour_provider: "bitstamp_spot",
      six_hour_provider: "bitstamp_spot",
      ticker_status: "available",
      quote_freshness_source: "local_ticker_response_time_for_exit_marking",
      ticker_event_time_source: "bitstamp_ticker_timestamp",
      quote_volume_status: Number.isFinite(Number(ticker?.volume)) && Number(ticker.volume) >= 0
        ? "available" : "unavailable",
      quote_volume_source: "bitstamp_ticker_24h_base_volume_times_last_price",
      book_status: bookError ? "provider_error" : (bidDepth === null || askDepth === null ? "invalid_or_missing" : "available"),
      book_error: bookError,
      one_minute: { ok: oneMinuteResult.audit.ok, issues: oneMinuteResult.audit.issues, bars: oneMinuteResult.audit.valid_closed_bars },
      five_minute: { ok: fiveMinuteResult.audit.ok, issues: fiveMinuteResult.audit.issues, bars: fiveMinuteResult.audit.valid_closed_bars },
      one_hour: {
        ok: oneHourResult.audit.ok,
        issues: oneHourResult.audit.issues,
        bars: oneHourResult.audit.valid_closed_bars
      },
      six_hour: {
        ok: sixHourResult.audit.ok,
        issues: sixHourResult.audit.issues,
        bars: sixHourResult.audit.valid_closed_bars
      },
      one_minute_source: oneMinuteResult.source,
      five_minute_source: fiveMinuteResult.source,
      one_minute_refresh_status: oneMinuteResult.refresh_status,
      five_minute_refresh_status: fiveMinuteResult.refresh_status,
      one_minute_refresh_error: oneMinuteResult.refresh_error,
      five_minute_refresh_error: fiveMinuteResult.refresh_error,
      one_hour_source: oneHourResult.source,
      six_hour_source: sixHourResult.source,
      one_hour_refresh_status: oneHourResult.refresh_status,
      six_hour_refresh_status: sixHourResult.refresh_status,
      one_hour_refresh_error: oneHourResult.refresh_error,
      six_hour_refresh_error: sixHourResult.refresh_error,
      book_freshness_source: "local_retrieval_time",
      book_event_time_source: "bitstamp_order_book_timestamp",
      book_sequence_available: false,
      failover_used: true
    }
  };
}

function snapshotIsEntryReady(snapshot, nowMs = Date.now()) {
  if (snapshot?.status !== "live" ||
      snapshot?.data_quality?.book_status !== "available" ||
      snapshot?.one_hour_audit?.ok !== true ||
      snapshot?.six_hour_audit?.ok !== true ||
      typeof snapshot.market_data_provider !== "string" ||
      !Number.isFinite(snapshot.bid) || snapshot.bid <= 0 ||
      !Number.isFinite(snapshot.ask) || snapshot.ask < snapshot.bid ||
      !Number.isFinite(snapshot.last) || snapshot.last <= 0) return false;

  const quoteReceivedAtMs = Number(snapshot.quote_received_at_ms);
  const quoteAgeMs = nowMs - quoteReceivedAtMs;
  const tickerTimeMs = Date.parse(snapshot.ticker_time || "");
  const tickerAgeMs = nowMs - tickerTimeMs;
  const bookRetrievedAtMs = Number(snapshot.book_retrieved_at_ms);
  const bookAgeMs = nowMs - bookRetrievedAtMs;
  const bookEventTimeMs = Number(snapshot.book_event_time_ms);
  const bookEventAgeMs = nowMs - bookEventTimeMs;
  const secondaryBookTimeValid = snapshot.market_data_provider !== "bitstamp_spot" ||
    (Number.isFinite(bookEventTimeMs) && bookEventAgeMs >= -1000 && bookEventAgeMs <= 15000);
  const providers = [
    snapshot.data_quality.ticker_provider,
    snapshot.data_quality.book_provider,
    snapshot.data_quality.one_hour_provider,
    snapshot.data_quality.six_hour_provider
  ];
  return Number.isFinite(quoteReceivedAtMs) && quoteAgeMs >= -5000 && quoteAgeMs <= 120000 &&
    Number.isFinite(tickerTimeMs) && tickerAgeMs >= -5000 && tickerAgeMs <= 120000 &&
    Number.isFinite(bookRetrievedAtMs) && bookAgeMs >= -1000 && bookAgeMs <= 15000 &&
    secondaryBookTimeValid &&
    Number.isFinite(snapshot.bid_depth_quote) && snapshot.bid_depth_quote >= 5000 &&
    Number.isFinite(snapshot.ask_depth_quote) && snapshot.ask_depth_quote >= 5000 &&
    providers.every((provider) => provider === snapshot.market_data_provider) &&
    auditIsFresh(snapshot.one_hour_audit, 3600000, nowMs, 5400000) &&
    auditIsFresh(snapshot.six_hour_audit, 21600000, nowMs, 25200000);
}

/**
 * Coinbase is the primary USD spot feed. If any required snapshot component is
 * unavailable or fails integrity checks, retry the whole market using Bitstamp
 * USD spot data so ticker, L2 book and both candle frames stay same-venue.
 * Never mix a Coinbase quote with Bitstamp candles (or vice versa).
 */
export async function fetchProductSnapshot(
  productRef,
  nowMs = Date.now(),
  cachedCandles = {},
  requestState = DEFAULT_REQUEST_STATE,
  { allowBitstampLegacyExit = false } = {}
) {
  let primary = null;
  let primaryError = null;

  try {
    primary = await fetchCoinbaseProductSnapshot(productRef, nowMs, cachedCandles, requestState);
    if (snapshotIsEntryReady(primary, Date.now())) return primary;
  } catch (error) {
    primaryError = error;
  }

  // New PAPER entries and all ordinary market monitoring are Coinbase-only.
  // Bitstamp may be queried only to continue marking an already-open legacy
  // PAPER position whose entry record explicitly names Bitstamp.
  if (allowBitstampLegacyExit !== true) {
    if (primary) {
      primary.data_quality.legacy_provider_fallback_skipped = true;
      primary.data_quality.entry_blocked_by_provider_policy =
        primary.market_data_provider !== "coinbase_exchange" ||
        primary.data_quality.book_status !== "available" ||
        primary.one_hour_audit?.ok !== true ||
        primary.six_hour_audit?.ok !== true;
      return primary;
    }
    throw primaryError || new Error("coinbase_market_data_unavailable");
  }

  try {
    const backup = await fetchBitstampProductSnapshot(
      productRef, nowMs, cachedCandles, requestState
    );
    backup.data_quality.primary_provider_error = primaryError
      ? providerErrorCode(primaryError)
      : (primary?.data_quality?.book_error ||
        primary?.data_quality?.one_hour_refresh_error ||
        primary?.data_quality?.six_hour_refresh_error ||
        "primary_snapshot_incomplete");
    backup.data_quality.legacy_exit_compatibility = true;
    backup.data_quality.failover_reason = primaryError
      ? "coinbase_unavailable_for_existing_bitstamp_position"
      : "coinbase_snapshot_incomplete_for_existing_bitstamp_position";
    if (snapshotIsEntryReady(backup, Date.now())) return backup;
    if (primary) {
      // Preserve a valid Coinbase quote for any Coinbase-entered position.
      if (Number.isFinite(primary.bid) && primary.bid > 0 &&
          Number.isFinite(primary.ask) && primary.ask >= primary.bid) {
        primary.data_quality.legacy_provider_fallback_attempted = true;
        primary.data_quality.legacy_provider_fallback_error = "bitstamp_snapshot_incomplete";
        return primary;
      }
    }
    return backup;
  } catch (backupError) {
    if (primary) {
      primary.data_quality.legacy_provider_fallback_attempted = true;
      primary.data_quality.legacy_provider_fallback_error = providerErrorCode(backupError);
      return primary;
    }
    const combined = new Error(
      "Coinbase market data is unavailable and legacy Bitstamp exit data could not be refreshed"
    );
    combined.code = "legacy_exit_market_data_unavailable";
    combined.primary_error_code = primaryError ? providerErrorCode(primaryError) : "coinbase_snapshot_incomplete";
    combined.backup_error_code = providerErrorCode(backupError);
    combined.status = Number(backupError?.status) || Number(primaryError?.status) || 503;
    throw combined;
  }
}
