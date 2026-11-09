import test from "node:test";
import assert from "node:assert/strict";
import { createCoinbaseRequestState, fetchProductSnapshot, getJson, parseRetryAfterMs, shouldRefreshCandleHistory } from "../src/coinbase.js";

test("Retry-After parses seconds and HTTP dates without truncating the provider delay", () => {
  assert.equal(parseRetryAfterMs("2", 1000), 2000);
  assert.equal(parseRetryAfterMs("0", 1000), 0);
  assert.equal(parseRetryAfterMs("invalid", 1000), null);
  assert.equal(parseRetryAfterMs("120", 1000), 120000);
  assert.equal(parseRetryAfterMs(new Date(121000).toUTCString(), 1000), 120000);
});

test("Coinbase request retries a short 429 response and then succeeds", async () => {
  const originalFetch = globalThis.fetch;
  const state = createCoinbaseRequestState();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await getJson("/test-retry", state);
    assert.deepEqual(result, { ok: true });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the final retry attempt stores its Retry-After cooldown for subsequent requests", async () => {
  const originalFetch = globalThis.fetch;
  const state = createCoinbaseRequestState();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls < 3) return new Response("temporarily unavailable", {
      status: 503, headers: { "retry-after": "0" }
    });
    return new Response("rate limited", { status: 429, headers: { "retry-after": "120" } });
  };
  try {
    await assert.rejects(
      getJson("/test-final-retry", state),
      (error) => error.status === 429 && error.retryAfterMs >= 120000
    );
    assert.equal(calls, 3);
    await assert.rejects(
      getJson("/test-after-final-retry", state),
      (error) => error.status === 429 && error.message.includes("cooldown active")
    );
    assert.equal(calls, 3, "the next product request must respect the final-attempt cooldown");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("long Retry-After delays fail fast without retrying early or blocking the scan", async () => {
  const originalFetch = globalThis.fetch;
  const state = createCoinbaseRequestState();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("rate limited", { status: 429, headers: { "retry-after": "120" } });
  };
  try {
    const started = Date.now();
    await assert.rejects(
      getJson("/test-long-retry", state),
      (error) => error.status === 429 && error.retryAfterMs > 119000
    );
    assert.equal(calls, 1, "long provider cooldown must not be retried early");
    assert.ok(Date.now() - started < 1000, "a long cooldown must fail fast instead of holding a scheduled scan");
    await assert.rejects(
      getJson("/test-cooldown-active", state),
      (error) => error.status === 429 && error.message.includes("cooldown active")
    );
    assert.equal(calls, 1, "other product requests must respect the active provider cooldown");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("closed candle history refreshes only after the next bar has closed", () => {
  const makeRows = (count, intervalMs) => Array.from({ length: count }, (_, index) => ({
    time: index * intervalMs,
    open: 100, high: 101, low: 99, close: 100, volume: 10
  }));
  const oneHour = makeRows(150, 3600000);
  const oneHourNextClose = oneHour.at(-1).time + (2 * 3600000);
  assert.equal(shouldRefreshCandleHistory(oneHour, 3600000, oneHourNextClose - 1), false);
  assert.equal(shouldRefreshCandleHistory(oneHour, 3600000, oneHourNextClose), true);
  assert.equal(shouldRefreshCandleHistory(oneHour.slice(0, 149), 3600000, oneHourNextClose), true);
  assert.equal(shouldRefreshCandleHistory([{ ...oneHour.at(-1), time: 123 }], 3600000, oneHourNextClose), true);

  const sixHour = makeRows(150, 21600000);
  const sixHourNextClose = sixHour.at(-1).time + (2 * 21600000);
  assert.equal(shouldRefreshCandleHistory(sixHour, 21600000, sixHourNextClose - 1), false);
  assert.equal(shouldRefreshCandleHistory(sixHour, 21600000, sixHourNextClose), true);
});


function makeCoinbaseRows(intervalMs, lastOpenMs, count = 150) {
  return Array.from({ length: count }, (_, index) => {
    const time = lastOpenMs - ((count - 1 - index) * intervalMs);
    const close = 100 + index * 0.1;
    return [Math.floor(time / 1000), close - 0.5, close + 0.5, close - 0.1, close, 100];
  });
}

function makeBook() {
  return {
    sequence: 123456,
    bids: Array.from({ length: 10 }, (_, index) => [String(100 - index * 0.01), "10"]),
    asks: Array.from({ length: 10 }, (_, index) => [String(100.01 + index * 0.01), "10"])
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("snapshot uses ticker 24h volume and does not spend an extra request on stats", async () => {
  const originalFetch = globalThis.fetch;
  const now = Date.now();
  const tickerTime = new Date(now).toISOString();
  const calls = [];
  const interval1h = 3600000;
  const interval6h = 21600000;
  const last1h = Math.floor(now / interval1h) * interval1h - interval1h;
  const last6h = Math.floor(now / interval6h) * interval6h - interval6h;
  const candles1h = makeCoinbaseRows(interval1h, last1h);
  const candles6h = makeCoinbaseRows(interval6h, last6h);

  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname + new URL(String(url)).search;
    calls.push(path);
    if (path.endsWith("/ticker")) {
      return jsonResponse({
        bid: "100", ask: "100.01", price: "100",
        volume: "25000", time: tickerTime
      });
    }
    if (path.endsWith("/book?level=2")) return jsonResponse(makeBook());
    if (path.endsWith("granularity=3600")) return jsonResponse(candles1h);
    if (path.endsWith("granularity=21600")) return jsonResponse(candles6h);
    return jsonResponse({ error: "unexpected_endpoint" }, 404);
  };

  try {
    const snapshot = await fetchProductSnapshot(
      { symbol: "BTC/USD", product: "BTC-USD" },
      now,
      {},
      createCoinbaseRequestState()
    );
    assert.equal(snapshot.status, "live");
    assert.equal(snapshot.bid, 100);
    assert.equal(snapshot.ask, 100.01);
    assert.equal(snapshot.quote_volume_usd, 2500000);
    assert.equal(snapshot.data_quality.quote_volume_source, "ticker_24h_volume");
    assert.equal(snapshot.data_quality.book_status, "available");
    assert.equal(snapshot.one_hour_audit.ok, true);
    assert.equal(snapshot.six_hour_audit.ok, true);
    assert.ok(Number.isFinite(snapshot.quote_received_at_ms));
    assert.equal(calls.some((path) => path.endsWith("/stats")), false);
    assert.equal(calls.length, 4, "ticker, book and two sequential candle refreshes are sufficient");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("candle endpoint failure falls back to fresh archived candles without discarding the current quote", async () => {
  const originalFetch = globalThis.fetch;
  const interval1h = 3600000;
  const interval6h = 21600000;
  const now = Math.floor(Date.now() / interval6h) * interval6h;
  const cached1h = makeCoinbaseRows(interval1h, now - (2 * interval1h));
  const cached6h = makeCoinbaseRows(interval6h, now - (2 * interval6h));
  const cachedLastTrade = new Date(now).toISOString();

  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname + parsed.search;
    if (path.endsWith("/ticker")) {
      return jsonResponse({
        bid: "100", ask: "100.01", price: "100",
        volume: "25000", time: cachedLastTrade
      });
    }
    if (path.endsWith("/book?level=2")) return jsonResponse(makeBook());
    if (path.includes("/candles?")) return jsonResponse({ message: "temporarily unavailable" }, 404);
    return jsonResponse({ error: "unexpected_endpoint" }, 404);
  };

  try {
    const snapshot = await fetchProductSnapshot(
      { symbol: "BTC/USD", product: "BTC-USD" },
      now,
      { one_hour: cached1h.map((row) => ({
        time: Number(row[0]) * 1000, low: row[1], high: row[2],
        open: row[3], close: row[4], volume: row[5]
      })), six_hour: cached6h.map((row) => ({
        time: Number(row[0]) * 1000, low: row[1], high: row[2],
        open: row[3], close: row[4], volume: row[5]
      })) },
      createCoinbaseRequestState()
    );
    assert.equal(snapshot.status, "live", "fresh ticker quotes must survive candle API failures");
    assert.equal(snapshot.bid, 100);
    assert.equal(snapshot.one_hour_audit.ok, true);
    assert.equal(snapshot.six_hour_audit.ok, true);
    assert.equal(snapshot.data_quality.one_hour_source, "durable_object_archive_fallback");
    assert.equal(snapshot.data_quality.six_hour_source, "durable_object_archive_fallback");
    assert.equal(snapshot.data_quality.one_hour_refresh_status, "provider_error_cache_fallback");
    assert.equal(snapshot.data_quality.six_hour_refresh_status, "provider_error_cache_fallback");
    assert.equal(snapshot.data_quality.one_hour_refresh_error, "provider_http_error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("book failure preserves a fresh bid for paper exits and uses stats only as a volume fallback", async () => {
  const originalFetch = globalThis.fetch;
  const interval1h = 3600000;
  const interval6h = 21600000;
  const now = Math.floor(Date.now() / interval6h) * interval6h + (3 * interval1h);
  const tickerTime = new Date(now - 5 * 60 * 1000).toISOString();
  const cached1h = makeCoinbaseRows(interval1h, Math.floor(now / interval1h) * interval1h - interval1h);
  const cached6h = makeCoinbaseRows(interval6h, Math.floor(now / interval6h) * interval6h - interval6h);
  const cached = (rows) => rows.map((row) => ({
    time: Number(row[0]) * 1000, low: row[1], high: row[2],
    open: row[3], close: row[4], volume: row[5]
  }));

  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname + parsed.search;
    if (path.endsWith("/ticker")) {
      return jsonResponse({ bid: "100", ask: "100.01", price: "100", time: tickerTime });
    }
    if (path.endsWith("/stats")) return jsonResponse({ volume: "25000" });
    if (path.endsWith("/book?level=2")) return jsonResponse({ message: "book unavailable" }, 404);
    return jsonResponse({ error: "unexpected_endpoint" }, 404);
  };

  try {
    const snapshot = await fetchProductSnapshot(
      { symbol: "BTC/USD", product: "BTC-USD" },
      now,
      { one_hour: cached(cached1h), six_hour: cached(cached6h) },
      createCoinbaseRequestState()
    );
    assert.equal(snapshot.status, "live");
    assert.equal(snapshot.bid, 100);
    assert.equal(snapshot.quote_volume_usd, 2500000);
    assert.equal(snapshot.data_quality.quote_volume_source, "product_stats_fallback");
    assert.equal(snapshot.data_quality.book_status, "provider_error");
    assert.equal(snapshot.book_retrieved_at_ms, null);
    assert.equal(snapshot.one_hour_audit.ok, true);
    assert.equal(snapshot.six_hour_audit.ok, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
