import { auditCandles } from "./strategy.js";

const BASE_URL = "https://api.exchange.coinbase.com";
const MIN_PUBLIC_REQUEST_GAP_MS = 350;
const MAX_RETRY_ATTEMPTS = 3;
// Avoid sleeping through most of a scheduled scan when a provider asks for a long cooldown.
const MAX_INLINE_COOLDOWN_WAIT_MS = 30000;
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
  // marking or closing an already-open PAPER position. A failure here must not
  // discard the valid bid captured above. All such failures still block new
  // entries through the full-universe quality gate.
  let book = null;
  let bookError = null;
  let bookRetrievedAtMs = null;
  try {
    book = await getJson("/products/" + encoded + "/book?level=2", requestState);
    bookRetrievedAtMs = Date.now();
  } catch (error) {
    bookError = providerErrorCode(error);
  }

  const cachedOneHour = Array.isArray(cachedCandles.one_hour) ? cachedCandles.one_hour : [];
  const cachedSixHour = Array.isArray(cachedCandles.six_hour) ? cachedCandles.six_hour : [];
  const cachedOneHourAudit = cachedOneHour.length
    ? auditCandles(cachedOneHour, 3600000, nowMs, 150) : null;
  const cachedSixHourAudit = cachedSixHour.length
    ? auditCandles(cachedSixHour, 21600 * 1000, nowMs, 150) : null;

  // Keep provider requests sequential: getJson shares one pacing/cooldown
  // state, and parallel timeframe refreshes could bypass the 350ms request gap.
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
    one_hour_audit: oneHourAudit,
    six_hour_audit: sixHourAudit,
    data_quality: {
      market_data_provider: "coinbase_exchange",
      ticker_provider: "coinbase_exchange",
      book_provider: "coinbase_exchange",
      one_hour_provider: "coinbase_exchange",
      six_hour_provider: "coinbase_exchange",
      ticker_status: "available",
      quote_freshness_source: "local_ticker_response_time_for_exit_marking",
      ticker_event_time_source: "last_trade_timestamp_for_entry_eligibility",
      quote_volume_status: volumeStatus,
      quote_volume_source: volumeSource,
      book_status: bookError ? "provider_error" : (bidDepth === null || askDepth === null ? "invalid_or_missing" : "available"),
      book_error: bookError,
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
    if (delayMs > MAX_INLINE_COOLDOWN_WAIT_MS) {
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
    const responsePair = String(payload?.data?.pair || "").toUpperCase().replace(/\\s+/g, "");
    const expectedPair = symbol.toUpperCase().replace(/\\s+/g, "");
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

  if (![bid, ask, last, tickerTimestampMs].every(Number.isFinite) ||
      bid <= 0 || ask < bid || last <= 0 || tickerTimestampMs <= 0 ||
      tickerTimestampMs > Date.now() + 5000) {
    const error = new Error("Bitstamp ticker response failed quote validation");
    error.status = 502;
    throw error;
  }

  let book = null;
  let bookError = null;
  let bookRetrievedAtMs = null;
  try {
    book = await getBitstampJson("/order_book/" + pair + "/?group=1", bitstampState);
    bookRetrievedAtMs = Date.now();
  } catch (error) {
    bookError = providerErrorCode(error);
  }

  const bitstampCache = cachedCandles?.bitstamp || {};
  const cachedOneHour = Array.isArray(bitstampCache.one_hour) ? bitstampCache.one_hour : [];
  const cachedSixHour = Array.isArray(bitstampCache.six_hour) ? bitstampCache.six_hour : [];
  const cachedOneHourAudit = cachedOneHour.length
    ? auditCandles(cachedOneHour, 3600000, nowMs, 150) : null;
  const cachedSixHourAudit = cachedSixHour.length
    ? auditCandles(cachedSixHour, 21600 * 1000, nowMs, 150) : null;

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
    book_age_ms: bookRetrievedAtMs === null ? null : Math.max(0, Date.now() - bookRetrievedAtMs),
    book_sequence: null,
    bid,
    ask,
    last,
    spread_bps: Number.isFinite(spreadBps) ? spreadBps : null,
    quote_volume_usd: Number.isFinite(quoteVolume) && quoteVolume >= 0 ? quoteVolume : null,
    bid_depth_quote: bidDepth,
    ask_depth_quote: askDepth,
    one_hour_audit: oneHourResult.audit,
    six_hour_audit: sixHourResult.audit,
    data_quality: {
      market_data_provider: "bitstamp_spot",
      ticker_provider: "bitstamp_spot",
      book_provider: "bitstamp_spot",
      one_hour_provider: "bitstamp_spot",
      six_hour_provider: "bitstamp_spot",
      ticker_status: "available",
      quote_freshness_source: "local_ticker_response_time_for_exit_marking",
      ticker_event_time_source: "bitstamp_ticker_timestamp",
      quote_volume_status: Number.isFinite(Number(ticker?.volume)) ? "available" : "unavailable",
      quote_volume_source: "bitstamp_ticker_24h_base_volume_times_last_price",
      book_status: bookError ? "provider_error" : (bidDepth === null || askDepth === null ? "invalid_or_missing" : "available"),
      book_error: bookError,
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
      one_hour_source: oneHourResult.source,
      six_hour_source: sixHourResult.source,
      one_hour_refresh_status: oneHourResult.refresh_status,
      six_hour_refresh_status: sixHourResult.refresh_status,
      one_hour_refresh_error: oneHourResult.refresh_error,
      six_hour_refresh_error: sixHourResult.refresh_error,
      book_freshness_source: "local_retrieval_time",
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
  const providers = [
    snapshot.data_quality.ticker_provider,
    snapshot.data_quality.book_provider,
    snapshot.data_quality.one_hour_provider,
    snapshot.data_quality.six_hour_provider
  ];
  return Number.isFinite(quoteReceivedAtMs) && quoteAgeMs >= -5000 && quoteAgeMs <= 120000 &&
    Number.isFinite(tickerTimeMs) && tickerAgeMs >= -5000 && tickerAgeMs <= 120000 &&
    Number.isFinite(bookRetrievedAtMs) && bookAgeMs >= -1000 && bookAgeMs <= 15000 &&
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
  requestState = DEFAULT_REQUEST_STATE
) {
  let primary = null;
  let primaryError = null;

  try {
    primary = await fetchCoinbaseProductSnapshot(productRef, nowMs, cachedCandles, requestState);
    if (snapshotIsEntryReady(primary)) return primary;
  } catch (error) {
    primaryError = error;
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
    backup.data_quality.failover_used = true;
    backup.data_quality.failover_reason = primaryError
      ? "primary_provider_request_failed"
      : "primary_snapshot_incomplete";
    if (snapshotIsEntryReady(backup)) return backup;
    if (!primary) return backup;
    // If the backup is also incomplete, retain the better fresh primary quote
    // for exit monitoring; entry readiness remains blocked by missing checks.
    if (Number.isFinite(primary.bid) && primary.bid > 0 &&
        Number.isFinite(primary.ask) && primary.ask >= primary.bid) {
      primary.data_quality.failover_attempted = true;
      primary.data_quality.failover_error = "backup_snapshot_incomplete";
      primary.data_quality.backup_provider = "bitstamp_spot";
      return primary;
    }
    return backup;
  } catch (backupError) {
    if (primary) {
      primary.data_quality.failover_attempted = true;
      primary.data_quality.failover_error = providerErrorCode(backupError);
      primary.data_quality.backup_provider = "bitstamp_spot";
      return primary;
    }
    const combined = new Error(
      "Primary Coinbase and secondary Bitstamp market-data requests failed"
    );
    combined.code = "all_market_data_providers_unavailable";
    combined.primary_error_code = primaryError ? providerErrorCode(primaryError) : "primary_snapshot_incomplete";
    combined.backup_error_code = providerErrorCode(backupError);
    combined.status = Number(backupError?.status) || Number(primaryError?.status) || 503;
    throw combined;
  }
}
