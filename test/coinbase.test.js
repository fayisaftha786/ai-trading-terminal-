import test from "node:test";
import assert from "node:assert/strict";
import { createCoinbaseRequestState, fetchBitstampResearchHistory, fetchBitstampOrderBook, fetchCoinbaseOrderBook, fetchProductSnapshot, getJson, parseRetryAfterMs, shouldRefreshCandleHistory } from "../src/coinbase.js";

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

test("final Coinbase order-book refresh returns fresh top-of-book and validated depth", async () => {
  const originalFetch = globalThis.fetch;
  let requested = "";
  globalThis.fetch = async (url) => {
    requested = String(url);
    return jsonResponse(makeBook());
  };
  try {
    const result = await fetchCoinbaseOrderBook("BTC-USD", createCoinbaseRequestState());
    assert.match(requested, /\/products\/BTC-USD\/book\?level=2$/);
    assert.equal(result.bid, 100);
    assert.equal(result.ask, 100.01);
    assert.equal(result.bid_depth_quote, 9995.5);
    assert.ok(Math.abs(result.ask_depth_quote - 10005.5) < 1e-8);
    assert.ok(Date.now() - result.book_retrieved_at_ms < 1000);
    assert.equal(result.book_sequence, 123456);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("final Coinbase order-book refresh rejects malformed or crossed books", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ bids: [["101", "2"]], asks: [["100", "2"]] });
  try {
    await assert.rejects(fetchCoinbaseOrderBook("BTC-USD", createCoinbaseRequestState()), (error) => error.message === "coinbase_order_book_failed_validation");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("Bitstamp order-book refresh returns fresh same-venue L2 evidence", async () => {
  const originalFetch = globalThis.fetch;
  let requested = "";
  globalThis.fetch = async (url) => {
    requested = String(url);
    const timestamp = Math.floor(Date.now() / 1000);
    return jsonResponse({
      timestamp,
      bids: [["100", "100"], ["99.99", "5"]],
      asks: [["100.1", "100"], ["100.11", "5"]]
    });
  };
  try {
    const result = await fetchBitstampOrderBook("BTC-USD", createCoinbaseRequestState());
    assert.match(requested, /\/api\/v2\/order_book\/btcusd\/\?group=1$/);
    assert.equal(result.bid, 100);
    assert.equal(result.ask, 100.1);
    assert.equal(result.bid_depth_quote, 14999.95);
    assert.equal(result.ask_depth_quote, 15000.65);
    assert.equal(result.book_sequence, null);
    assert.ok(Date.now() - result.book_retrieved_at_ms < 1000);
    assert.ok(Date.now() - result.book_event_time_ms < 2000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Bitstamp order-book refresh rejects stale exchange timestamps and crossed books", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({
    timestamp: Math.floor((Date.now() - 16000) / 1000),
    bids: [["100", "100"]],
    asks: [["100.1", "100"]]
  });
  try {
    await assert.rejects(
      fetchBitstampOrderBook("BTC-USD", createCoinbaseRequestState()),
      (error) => error.code === "provider_timestamp_invalid_or_stale"
    );
    globalThis.fetch = async () => jsonResponse({
      timestamp: Math.floor(Date.now() / 1000),
      bids: [["100.2", "100"]],
      asks: [["100.1", "100"]]
    });
    await assert.rejects(
      fetchBitstampOrderBook("BTC-USD", createCoinbaseRequestState()),
      (error) => error.code === "order_book_failed_validation"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

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
    assert.equal(snapshot.one_minute_audit.ok, false, "unmocked lower-timeframe data is rejected, not fabricated");
    assert.equal(snapshot.five_minute_audit.ok, false, "unmocked lower-timeframe data is rejected, not fabricated");
    assert.equal(snapshot.data_quality.one_minute_provider, "coinbase_exchange");
    assert.equal(snapshot.data_quality.five_minute_provider, "coinbase_exchange");
    assert.ok(Number.isFinite(snapshot.quote_received_at_ms));
    assert.equal(calls.some((path) => path.endsWith("/stats")), false);
    assert.equal(calls.length, 6, "ticker, book and four sequential timeframe refreshes are used");
    const bookCallIndex = calls.findIndex((path) => path.endsWith("/book?level=2"));
    const lastCandleCallIndex = Math.max(...calls.map((path, index) =>
      path.includes("/candles?") ? index : -1
    ));
    assert.ok(bookCallIndex > lastCandleCallIndex,
      "fetch the order book after sequential candle refreshes to preserve the 15s freshness window");
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


function makeBitstampRows(intervalMs, lastOpenMs, count = 160) {
  return Array.from({ length: count }, (_, index) => {
    const time = lastOpenMs - ((count - 1 - index) * intervalMs);
    const close = 100 + (index * 0.02);
    return {
      timestamp: String(Math.floor(time / 1000)),
      open: String(close - 0.1),
      high: String(close + 0.5),
      low: String(close - 0.5),
      close: String(close),
      volume: "1000"
    };
  });
}

function makeBitstampBook() {
  return {
    timestamp: String(Math.floor(Date.now() / 1000)),
    bids: Array.from({ length: 10 }, (_, index) => [
      String(100 - (index * 0.01)), "100"
    ]),
    asks: Array.from({ length: 10 }, (_, index) => [
      String(100.01 + (index * 0.01)), "100"
    ])
  };
}

test("Bitstamp failover provides a coherent SOL/USD ticker, book and closed 1H/6H candle set", async () => {
  const originalFetch = globalThis.fetch;
  const now = Date.now();
  const interval1h = 3600000;
  const interval6h = 21600000;
  const last1h = Math.floor(now / interval1h) * interval1h - interval1h;
  const last6h = Math.floor(now / interval6h) * interval6h - interval6h;
  const calls = [];

  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname + parsed.search;
    calls.push(parsed.hostname + path);
    if (parsed.hostname === "api.exchange.coinbase.com") {
      return new Response(JSON.stringify({ message: "primary feed unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json", "retry-after": "0" }
      });
    }
    if (parsed.hostname !== "www.bitstamp.net") {
      return jsonResponse({ message: "unexpected provider" }, 404);
    }
    if (path === "/api/v2/ticker/solusd/") {
      return jsonResponse({
        timestamp: String(Math.floor(Date.now() / 1000)),
        market_type: "SPOT",
        bid: "99.99", ask: "100.01", last: "100",
        volume: "25000"
      });
    }
    if (path === "/api/v2/order_book/solusd/?group=1") {
      return jsonResponse(makeBitstampBook());
    }
    if (path === "/api/v2/ohlc/solusd/?step=3600&limit=200&exclude_current_candle=true") {
      return jsonResponse({
        data: { pair: "SOL/USD", ohlc: makeBitstampRows(interval1h, last1h) }
      });
    }
    if (path === "/api/v2/ohlc/solusd/?step=21600&limit=200&exclude_current_candle=true") {
      return jsonResponse({
        data: { pair: "SOL/USD", ohlc: makeBitstampRows(interval6h, last6h) }
      });
    }
    return jsonResponse({ message: "unexpected endpoint: " + path }, 404);
  };

  try {
    const snapshot = await fetchProductSnapshot(
      { symbol: "SOL/USD", product: "SOL-USD" },
      now,
      { bitstamp: { one_hour: [], six_hour: [] } },
      createCoinbaseRequestState()
    );

    assert.equal(snapshot.status, "live");
    assert.equal(snapshot.market_data_provider, "bitstamp_spot");
    assert.equal(snapshot.bid, 99.99);
    assert.equal(snapshot.ask, 100.01);
    assert.equal(snapshot.last, 100);
    assert.equal(snapshot.quote_volume_usd, 2500000);
    assert.equal(snapshot.one_hour_audit.ok, true);
    assert.equal(snapshot.six_hour_audit.ok, true);
    assert.equal(snapshot.one_hour_audit.valid_closed_bars, 160);
    assert.equal(snapshot.six_hour_audit.valid_closed_bars, 160);
    assert.equal(snapshot.data_quality.book_status, "available");
    assert.equal(snapshot.data_quality.failover_used, true);
    assert.equal(snapshot.data_quality.primary_provider_error, "provider_server_error");
    assert.equal(snapshot.data_quality.failover_reason, "primary_provider_request_failed");
    assert.ok(snapshot.data_quality.book_provider === snapshot.market_data_provider);
    assert.ok(snapshot.data_quality.ticker_provider === snapshot.market_data_provider);
    assert.ok(snapshot.data_quality.one_hour_provider === snapshot.market_data_provider);
    assert.ok(snapshot.data_quality.six_hour_provider === snapshot.market_data_provider);
    assert.ok(snapshot.bid_depth_quote >= 5000);
    assert.ok(snapshot.ask_depth_quote >= 5000);
    assert.ok(Number.isFinite(snapshot.quote_received_at_ms));
    assert.ok(Number.isFinite(snapshot.book_retrieved_at_ms));
    assert.ok(calls.every((call) => !call.includes("BTC") && !call.includes("ETH")));
    assert.equal(calls.filter((call) => call.includes("api.exchange.coinbase.com")).length, 3,
      "the primary feed should honour its configured three-attempt retry policy");
    assert.equal(calls.filter((call) => call.includes("www.bitstamp.net")).length, 6);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Bitstamp OHLC pair mismatch is rejected instead of mixing another market's candles", async () => {
  const originalFetch = globalThis.fetch;
  const now = Date.now();
  const interval1h = 3600000;
  const interval6h = 21600000;
  const last1h = Math.floor(now / interval1h) * interval1h - interval1h;
  const last6h = Math.floor(now / interval6h) * interval6h - interval6h;

  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname + parsed.search;
    if (parsed.hostname === "api.exchange.coinbase.com") {
      return jsonResponse({ error: "primary down" }, 404);
    }
    if (path === "/api/v2/ticker/solusd/") {
      return jsonResponse({
        timestamp: String(Math.floor(Date.now() / 1000)),
        market_type: "SPOT",
        bid: "99.99", ask: "100.01", last: "100", volume: "25000"
      });
    }
    if (path === "/api/v2/order_book/solusd/?group=1") return jsonResponse(makeBitstampBook());
    if (path.includes("step=3600")) {
      return jsonResponse({
        data: { pair: "BTC/USD", ohlc: makeBitstampRows(interval1h, last1h) }
      });
    }
    if (path.includes("step=21600")) {
      return jsonResponse({
        data: { pair: "SOL/USD", ohlc: makeBitstampRows(interval6h, last6h) }
      });
    }
    return jsonResponse({ error: "unexpected_endpoint" }, 404);
  };

  try {
    const snapshot = await fetchProductSnapshot(
      { symbol: "SOL/USD", product: "SOL-USD" },
      now,
      {},
      createCoinbaseRequestState()
    );
    assert.equal(snapshot.market_data_provider, "bitstamp_spot");
    assert.equal(snapshot.one_hour_audit.ok, false);
    assert.ok(snapshot.one_hour_audit.issues.includes("insufficient_closed_history"));
    assert.equal(snapshot.data_quality.one_hour_refresh_status, "provider_error_no_fresh_cache");
    assert.equal(snapshot.data_quality.one_hour_refresh_error, "provider_server_error");
    assert.equal(snapshot.data_quality.failover_used, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("both market-data providers unavailable returns explicit combined provider error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ error: "unavailable" }, 404);
  try {
    await assert.rejects(
      fetchProductSnapshot(
        { symbol: "SOL/USD", product: "SOL-USD" },
        Date.now(),
        {},
        createCoinbaseRequestState()
      ),
      (error) => error.code === "all_market_data_providers_unavailable" &&
        error.primary_error_code === "provider_http_error" &&
        error.backup_error_code === "provider_http_error"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("a partial Coinbase snapshot triggers an all-Bitstamp replacement rather than mixing venues", async () => {
  const originalFetch = globalThis.fetch;
  const now = Date.now();
  const interval1h = 3600000;
  const interval6h = 21600000;
  const last1h = Math.floor(now / interval1h) * interval1h - interval1h;
  const last6h = Math.floor(now / interval6h) * interval6h - interval6h;
  const calls = [];

  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname + parsed.search;
    calls.push(parsed.hostname + path);

    if (parsed.hostname === "api.exchange.coinbase.com") {
      if (path === "/products/SOL-USD/ticker") {
        return jsonResponse({
          bid: "100", ask: "100.01", price: "100",
          volume: "25000", time: new Date(Date.now()).toISOString()
        });
      }
      if (path === "/products/SOL-USD/book?level=2") {
        return jsonResponse({ message: "order book temporarily unavailable" }, 404);
      }
      if (path.includes("/candles?")) {
        return jsonResponse({ message: "candle history temporarily unavailable" }, 404);
      }
      return jsonResponse({ message: "unexpected primary endpoint" }, 404);
    }

    if (parsed.hostname !== "www.bitstamp.net") {
      return jsonResponse({ message: "unexpected host" }, 404);
    }
    if (path === "/api/v2/ticker/solusd/") {
      return jsonResponse({
        timestamp: String(Math.floor(Date.now() / 1000)),
        market_type: "SPOT",
        bid: "99.99", ask: "100.01", last: "100",
        volume: "25000"
      });
    }
    if (path === "/api/v2/order_book/solusd/?group=1") return jsonResponse(makeBitstampBook());
    if (path.includes("step=3600")) {
      return jsonResponse({
        data: { pair: "SOL/USD", ohlc: makeBitstampRows(interval1h, last1h) }
      });
    }
    if (path.includes("step=21600")) {
      return jsonResponse({
        data: { pair: "SOL/USD", ohlc: makeBitstampRows(interval6h, last6h) }
      });
    }
    return jsonResponse({ message: "unexpected secondary endpoint" }, 404);
  };

  try {
    const snapshot = await fetchProductSnapshot(
      { symbol: "SOL/USD", product: "SOL-USD" },
      now,
      {},
      createCoinbaseRequestState()
    );

    assert.equal(snapshot.status, "live");
    assert.equal(snapshot.market_data_provider, "bitstamp_spot");
    assert.equal(snapshot.data_quality.ticker_provider, "bitstamp_spot");
    assert.equal(snapshot.data_quality.book_provider, "bitstamp_spot");
    assert.equal(snapshot.data_quality.one_hour_provider, "bitstamp_spot");
    assert.equal(snapshot.data_quality.six_hour_provider, "bitstamp_spot");
    assert.equal(snapshot.data_quality.failover_reason, "primary_snapshot_incomplete");
    assert.equal(snapshot.data_quality.primary_provider_error, "provider_http_error");
    assert.equal(snapshot.data_quality.book_status, "available");
    assert.equal(snapshot.one_hour_audit.ok, true);
    assert.equal(snapshot.six_hour_audit.ok, true);
    assert.equal(calls.filter((call) => call.includes("api.exchange.coinbase.com")).length, 6);
    assert.equal(calls.filter((call) => call.includes("www.bitstamp.net")).length, 6);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("Bitstamp fallback rejects non-SPOT ticker responses", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname + parsed.search;
    if (parsed.hostname === "api.exchange.coinbase.com") {
      return jsonResponse({ error: "primary unavailable" }, 404);
    }
    if (path === "/api/v2/ticker/solusd/") {
      return jsonResponse({
        timestamp: String(Math.floor(Date.now() / 1000)),
        market_type: "MARGIN",
        bid: "99.99", ask: "100.01", last: "100", volume: "25000"
      });
    }
    return jsonResponse({ error: "unexpected endpoint" }, 404);
  };
  try {
    await assert.rejects(
      fetchProductSnapshot(
        { symbol: "SOL/USD", product: "SOL-USD" },
        Date.now(), {}, createCoinbaseRequestState()
      ),
      (error) => error.code === "all_market_data_providers_unavailable"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Bitstamp fallback rejects a stale exchange-side order-book timestamp", async () => {
  const originalFetch = globalThis.fetch;
  const now = Date.now();
  const interval1h = 3600000;
  const interval6h = 21600000;
  const last1h = Math.floor(now / interval1h) * interval1h - interval1h;
  const last6h = Math.floor(now / interval6h) * interval6h - interval6h;

  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname + parsed.search;
    if (parsed.hostname === "api.exchange.coinbase.com") {
      return jsonResponse({ error: "primary unavailable" }, 404);
    }
    if (path === "/api/v2/ticker/solusd/") {
      return jsonResponse({
        timestamp: String(Math.floor(Date.now() / 1000)),
        market_type: "SPOT",
        bid: "99.99", ask: "100.01", last: "100", volume: "25000"
      });
    }
    if (path === "/api/v2/order_book/solusd/?group=1") {
      return jsonResponse({
        ...makeBitstampBook(),
        timestamp: String(Math.floor((Date.now() - 16000) / 1000))
      });
    }
    if (path.includes("step=3600")) {
      return jsonResponse({
        data: { pair: "SOL/USD", ohlc: makeBitstampRows(interval1h, last1h) }
      });
    }
    if (path.includes("step=21600")) {
      return jsonResponse({
        data: { pair: "SOL/USD", ohlc: makeBitstampRows(interval6h, last6h) }
      });
    }
    return jsonResponse({ error: "unexpected endpoint" }, 404);
  };

  try {
    const snapshot = await fetchProductSnapshot(
      { symbol: "SOL/USD", product: "SOL-USD" },
      now, {}, createCoinbaseRequestState()
    );
    assert.equal(snapshot.market_data_provider, "bitstamp_spot");
    assert.equal(snapshot.data_quality.book_status, "provider_error");
    assert.equal(snapshot.data_quality.book_error, "provider_timestamp_invalid_or_stale");
    assert.ok(Number.isFinite(snapshot.book_event_time_ms));
    assert.ok(snapshot.book_age_ms <= 15000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("Bitstamp research backfill pages OHLC history, validates spot metadata and contiguous closed bars", async () => {
  const originalFetch = globalThis.fetch;
  const now = Date.now();
  const oneInterval = 3600000;
  const sixInterval = 21600000;
  const lastOne = Math.floor(now / oneInterval) * oneInterval - oneInterval;
  const lastSix = Math.floor(now / sixInterval) * sixInterval - sixInterval;
  const oneRows = makeBitstampRows(oneInterval, lastOne, 1001);
  const sixRows = makeBitstampRows(sixInterval, lastSix, 160);
  const calls = [];

  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname + parsed.search;
    calls.push(path);
    if (path === "/api/v2/markets/") {
      return jsonResponse([{
        market_symbol: "solusd",
        base_currency: "SOL",
        counter_currency: "USD",
        market_type: "SPOT",
        trading: "Enabled"
      }]);
    }
    if (path.startsWith("/api/v2/ohlc/solusd/")) {
      const query = parsed.searchParams;
      const interval = Number(query.get("step"));
      const rows = interval === 3600 ? oneRows : sixRows;
      const limit = Number(query.get("limit"));
      const end = Number(query.get("end"));
      const page = rows
        .filter((row) => Number(row.timestamp) <= end)
        .slice(-limit);
      return jsonResponse({ data: { pair: "SOL/USD", ohlc: page } });
    }
    return jsonResponse({ error: "unexpected endpoint" }, 404);
  };

  try {
    const result = await fetchBitstampResearchHistory({
      product: "SOL-USD",
      nowMs: now,
      oneHourBars: 1001,
      sixHourBars: 160,
      requestState: createCoinbaseRequestState()
    });
    assert.equal(result.provider, "bitstamp_spot");
    assert.equal(result.market_type, "SPOT");
    assert.equal(result.quote_currency, "USD");
    assert.equal(result.one_hour.ok, true);
    assert.equal(result.one_hour.valid_closed_bars, 1001);
    assert.equal(result.six_hour.ok, true);
    assert.equal(result.six_hour.valid_closed_bars, 160);
    assert.equal(result.requests.markets, 1);
    assert.equal(result.requests.one_hour, 2, "1,001 hourly bars must be paged across two requests");
    assert.equal(result.requests.six_hour, 1);
    assert.equal(calls.length, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Bitstamp research backfill rejects disabled or non-SPOT instruments", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse([{
    market_symbol: "solusd",
    base_currency: "SOL",
    counter_currency: "USD",
    market_type: "PERPETUAL",
    trading: "Enabled"
  }]);
  try {
    await assert.rejects(
      fetchBitstampResearchHistory({
        product: "SOL-USD",
        oneHourBars: 150,
        sixHourBars: 150,
        requestState: createCoinbaseRequestState()
      }),
      (error) => error.code === "research_backfill_market_not_enabled_spot"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Bitstamp research backfill rejects gaps rather than persisting incomplete lookback windows", async () => {
  const originalFetch = globalThis.fetch;
  const now = Date.now();
  const oneInterval = 3600000;
  const sixInterval = 21600000;
  const lastOne = Math.floor(now / oneInterval) * oneInterval - oneInterval;
  const lastSix = Math.floor(now / sixInterval) * sixInterval - sixInterval;
  const oneRows = makeBitstampRows(oneInterval, lastOne, 160);
  oneRows.splice(80, 1);
  const sixRows = makeBitstampRows(sixInterval, lastSix, 160);

  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname + parsed.search;
    if (path === "/api/v2/markets/") {
      return jsonResponse([{
        market_symbol: "solusd",
        base_currency: "SOL",
        counter_currency: "USD",
        market_type: "SPOT",
        trading: "Enabled"
      }]);
    }
    if (path.startsWith("/api/v2/ohlc/solusd/")) {
      const interval = Number(parsed.searchParams.get("step"));
      const rows = interval === 3600 ? oneRows : sixRows;
      const limit = Number(parsed.searchParams.get("limit"));
      const end = Number(parsed.searchParams.get("end"));
      return jsonResponse({
        data: {
          pair: "SOL/USD",
          ohlc: rows.filter((row) => Number(row.timestamp) <= end).slice(-limit)
        }
      });
    }
    return jsonResponse({ error: "unexpected endpoint" }, 404);
  };

  try {
    await assert.rejects(
      fetchBitstampResearchHistory({
        product: "SOL-USD",
        nowMs: now,
        oneHourBars: 150,
        sixHourBars: 150,
        requestState: createCoinbaseRequestState()
      }),
      (error) => error.code === "research_backfill_candle_integrity_failed"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
