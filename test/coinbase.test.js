import test from "node:test";
import assert from "node:assert/strict";
import { getJson, parseRetryAfterMs } from "../src/coinbase.js";

test("Retry-After parses seconds and HTTP dates with a safe cap", () => {
  assert.equal(parseRetryAfterMs("2", 1000), 2000);
  assert.equal(parseRetryAfterMs("0", 1000), 0);
  assert.equal(parseRetryAfterMs("invalid", 1000), null);
  assert.equal(parseRetryAfterMs("120", 1000), 120000);
  assert.equal(parseRetryAfterMs(new Date(121000).toUTCString(), 1000), 120000);
});

test("Coinbase request retries a 429 response and then succeeds", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await getJson("/test-retry");
    assert.deepEqual(result, { ok: true });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("Coinbase honors long Retry-After headers without retrying early or blocking the scan", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("rate limited", { status: 429, headers: { "retry-after": "120" } });
  };
  try {
    const started = Date.now();
    await assert.rejects(
      getJson("/test-long-retry"),
      (error) => error.status === 429 && error.retryAfterMs > 119000
    );
    assert.equal(calls, 1, "long provider cooldown must not be retried early");
    assert.ok(Date.now() - started < 1000, "a long cooldown must fail fast instead of holding a scheduled scan");
    await assert.rejects(
      getJson("/test-cooldown-active"),
      (error) => error.status === 429 && error.message.includes("cooldown active")
    );
    assert.equal(calls, 1, "other product requests must respect the active provider cooldown");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
