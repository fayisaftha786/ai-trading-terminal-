import { auditCandles } from "./strategy.js";

const BASE_URL = "https://api.exchange.coinbase.com";
const MIN_PUBLIC_REQUEST_GAP_MS = 350;
const MAX_RETRY_ATTEMPTS = 3;
// Avoid sleeping through most of a scheduled scan when a provider asks for a long cooldown.
const MAX_INLINE_COOLDOWN_WAIT_MS = 30000;
const DEFAULT_REQUEST_STATE = { lastPublicRequestAt: 0, publicCooldownUntilMs: 0 };

export function createCoinbaseRequestState() {
  return { lastPublicRequestAt: 0, publicCooldownUntilMs: 0 };
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

export async function fetchProductSnapshot({ symbol, product }, nowMs = Date.now(), cachedCandles = {}, requestState = DEFAULT_REQUEST_STATE) {
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

  const [oneHourResult, sixHourResult] = await Promise.all([
    loadCandleHistory({
      product, timeframeSeconds: 3600, intervalMs: 3600000,
      cachedRows: cachedOneHour, cachedAudit: cachedOneHourAudit,
      requestState, nowMs, maxStaleMs: 5400000
    }),
    loadCandleHistory({
      product, timeframeSeconds: 21600, intervalMs: 21600 * 1000,
      cachedRows: cachedSixHour, cachedAudit: cachedSixHourAudit,
      requestState, nowMs, maxStaleMs: 25200000
    })
  ]);

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
