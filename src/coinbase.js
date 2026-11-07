import { auditCandles } from "./strategy.js";

const BASE_URL = "https://api.exchange.coinbase.com";
const MIN_PUBLIC_REQUEST_GAP_MS = 350;
let lastPublicRequestAt = 0;
export const PRODUCTS = [
  { symbol: "BTC/USD", product: "BTC-USD" },
  { symbol: "ETH/USD", product: "ETH-USD" },
  { symbol: "SOL/USD", product: "SOL-USD" }
];

async function getJson(path) {
  const waitMs = Math.max(0, MIN_PUBLIC_REQUEST_GAP_MS - (Date.now() - lastPublicRequestAt));
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  lastPublicRequestAt = Date.now();
  const response = await fetch(BASE_URL + path, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "User-Agent": "AI-Trading-Terminal-Free-Paper/1.0"
    },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) {
    const error = new Error("Coinbase public API returned HTTP " + response.status);
    error.status = response.status;
    throw error;
  }
  return response.json();
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

export async function fetchProductSnapshot({ symbol, product }, nowMs = Date.now()) {
  const encoded = encodeURIComponent(product);
  // Public endpoint pacing: keep one shared request stream below Coinbase's documented rate.
  const ticker = await getJson("/products/" + encoded + "/ticker");
  const stats = await getJson("/products/" + encoded + "/stats");
  const book = await getJson("/products/" + encoded + "/book?level=2");
  const oneHourRaw = await getJson("/products/" + encoded + "/candles?granularity=3600");
  const sixHourRaw = await getJson("/products/" + encoded + "/candles?granularity=21600");
  const bid = Number(ticker.bid);
  const ask = Number(ticker.ask);
  const last = Number(ticker.price);
  const baseVolume = Number(stats.volume);
  const quoteVolume = baseVolume * last;
  const oneHour = convertCandles(oneHourRaw);
  const sixHour = convertCandles(sixHourRaw);
  const oneHourAudit = auditCandles(oneHour, 3600000, nowMs, 150);
  const sixHourAudit = auditCandles(sixHour, 21600000, nowMs, 150);
  const bidDepth = parseBookSide(book.bids);
  const askDepth = parseBookSide(book.asks);
  const tickerMs = Date.parse(ticker.time || "");
  const bookMs = Date.parse(book.time || "");
  const bookObservedAtMs = Date.now();
  return {
    symbol,
    product,
    status: "live",
    fetched_at_ms: nowMs,
    ticker_time: Number.isFinite(tickerMs) ? new Date(tickerMs).toISOString() : null,
    book_timestamp_ms: Number.isFinite(bookMs) ? bookMs : null,
    book_age_ms: Number.isFinite(bookMs) ? bookObservedAtMs - bookMs : null,
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
      book_timestamp_source: "local_retrieval_time"
    }
  };
}
