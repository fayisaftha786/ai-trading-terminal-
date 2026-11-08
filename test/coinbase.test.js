import test from "node:test";
import assert from "node:assert/strict";
import { createCoinbaseRequestState, getJson, parseRetryAfterMs, shouldRefreshCandleHistory } from "../src/coinbase.js";

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
