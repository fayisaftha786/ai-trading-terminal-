import test from "node:test";
import assert from "node:assert/strict";
import { checkEdgeLoginRateLimit } from "../src/edge-login-rate-limit.js";

test("edge fallback allows login only when both IP and location limits allow it", async () => {
  const calls = [];
  const env = {
    LOGIN_EDGE_IP_LIMITER: {
      async limit(input) { calls.push({ kind: "ip", input }); return { success: true }; }
    },
    LOGIN_EDGE_GLOBAL_LIMITER: {
      async limit(input) { calls.push({ kind: "global", input }); return { success: true }; }
    }
  };
  const result = await checkEdgeLoginRateLimit(env, "opaque-ip-hmac");
  assert.deepEqual(result, { available: true, allowed: true });
  assert.deepEqual(calls, [
    { kind: "ip", input: { key: "owner-login:ip:opaque-ip-hmac" } },
    { kind: "global", input: { key: "owner-login:global" } }
  ]);
});

test("edge fallback rejects when the per-IP limit is exceeded", async () => {
  const env = {
    LOGIN_EDGE_IP_LIMITER: { async limit() { return { success: false }; } },
    LOGIN_EDGE_GLOBAL_LIMITER: { async limit() { return { success: true }; } }
  };
  assert.deepEqual(await checkEdgeLoginRateLimit(env, "opaque-ip-hmac"), { available: true, allowed: false });
});

test("edge fallback rejects when the global location limit is exceeded", async () => {
  const env = {
    LOGIN_EDGE_IP_LIMITER: { async limit() { return { success: true }; } },
    LOGIN_EDGE_GLOBAL_LIMITER: { async limit() { return { success: false }; } }
  };
  assert.deepEqual(await checkEdgeLoginRateLimit(env, "opaque-ip-hmac"), { available: true, allowed: false });
});

test("edge fallback fails closed when bindings or HMAC identity are missing", async () => {
  assert.deepEqual(await checkEdgeLoginRateLimit({}, "opaque-ip-hmac"), { available: false, allowed: false });
  assert.deepEqual(await checkEdgeLoginRateLimit({
    LOGIN_EDGE_IP_LIMITER: { async limit() { return { success: true }; } },
    LOGIN_EDGE_GLOBAL_LIMITER: { async limit() { return { success: true }; } }
  }, ""), { available: false, allowed: false });
});

test("edge fallback fails closed when a Cloudflare rate-limit call throws", async () => {
  const env = {
    LOGIN_EDGE_IP_LIMITER: { async limit() { throw new Error("edge unavailable"); } },
    LOGIN_EDGE_GLOBAL_LIMITER: { async limit() { return { success: true }; } }
  };
  assert.deepEqual(await checkEdgeLoginRateLimit(env, "opaque-ip-hmac"), { available: false, allowed: false });
});
