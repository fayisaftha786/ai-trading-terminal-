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

export async function fetchProductSnapshot({ symbol, product }, nowMs = Date.now(), cachedCandles = {}, requestState = DEFAULT_REQUEST_STATE) {
  const encoded = encodeURIComponent(product);
  // Public endpoint pacing: keep one shared request stream below Coinbase's documented rate.
  const ticker = await getJson("/products/" + encoded + "/ticker", requestState);
  const stats = await getJson("/products/" + encoded + "/stats", requestState);
  const book = await getJson("/products/" + encoded + "/book?level=2", requestState);
  // Coinbase Exchange L2 REST snapshots expose sequence/bids/asks, not a reliable
  // exchange event timestamp. Record when this response was received locally.
  const bookRetrievedAtMs = Date.now();
  const cachedOneHour = Array.isArray(cachedCandles.one_hour) ? cachedCandles.one_hour : [];
  const cachedSixHour = Array.isArray(cachedCandles.six_hour) ? cachedCandles.six_hour : [];
  const cachedOneHourAudit = cachedOneHour.length
    ? auditCandles(cachedOneHour, 3600000, nowMs, 150) : null;
  const cachedSixHourAudit = cachedSixHour.length
    ? auditCandles(cachedSixHour, 21600000, nowMs, 150) : null;
  const useCachedOneHour = !!cachedOneHourAudit?.ok &&
    !shouldRefreshCandleHistory(cachedOneHour, 3600000, nowMs, 150);
  const useCachedSixHour = !!cachedSixHourAudit?.ok &&
    !shouldRefreshCandleHistory(cachedSixHour, 21600000, nowMs, 150);
  const oneHourRaw = useCachedOneHour ? null
    : await getJson("/products/" + encoded + "/candles?granularity=3600", requestState);
  const sixHourRaw = useCachedSixHour ? null
    : await getJson("/products/" + encoded + "/candles?granularity=21600", requestState);
  const bid = Number(ticker.bid);
  const ask = Number(ticker.ask);
  const last = Number(ticker.price);
  const baseVolume = Number(stats.volume);
  const quoteVolume = baseVolume * last;
  const oneHour = useCachedOneHour ? cachedOneHour : convertCandles(oneHourRaw);
  const sixHour = useCachedSixHour ? cachedSixHour : convertCandles(sixHourRaw);
  const oneHourAudit = useCachedOneHour ? cachedOneHourAudit : auditCandles(oneHour, 3600000, nowMs, 150);
  const sixHourAudit = useCachedSixHour ? cachedSixHourAudit : auditCandles(sixHour, 21600000, nowMs, 150);
  const bidDepth = parseBookSide(book.bids);
  const askDepth = parseBookSide(book.asks);
  const tickerMs = Date.parse(ticker.time || "");
  const bookObservedAtMs = Date.now();
  return {
    symbol,
    product,
    status: "live",
    fetched_at_ms: nowMs,
    ticker_time: Number.isFinite(tickerMs) ? new Date(tickerMs).toISOString() : null,
    book_retrieved_at_ms: bookRetrievedAtMs,
    book_age_ms: Math.max(0, bookObservedAtMs - bookRetrievedAtMs),
    book_sequence: book.sequence == null || !Number.isSafeInteger(Number(book.sequence)) ? null : Number(book.sequence),
    bid,
    ask,
    last,
    spread_bps: Number.isFinite(bid) && Number.isFinite(ask) && ask >= bid && ask + bid > 0
      ? ((ask - bid) / ((ask + bid) / 2)) * 10000 : null,
    quote_volume_usd: Number.isFinite(quoteVolume) && quoteVolume >= 0 ? quoteVolume : null,
    bid_depth_quote: bidDepth,
    ask_depth_quote: askDepth,
    one_hour_audit: oneHourAudit,
    six_hour_audit: sixHourAudit,
    data_quality: {
      one_hour: { ok: oneHourAudit.ok, issues: oneHourAudit.issues, bars: oneHourAudit.valid_closed_bars },
      six_hour: { ok: sixHourAudit.ok, issues: sixHourAudit.issues, bars: sixHourAudit.valid_closed_bars },
      one_hour_source: useCachedOneHour ? "durable_object_archive" : "coinbase_exchange_rest",
      six_hour_source: useCachedSixHour ? "durable_object_archive" : "coinbase_exchange_rest",
      book_freshness_source: "local_retrieval_time",
      book_sequence_available: book.sequence != null && Number.isSafeInteger(Number(book.sequence))
    }
  };
}
