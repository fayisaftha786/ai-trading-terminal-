import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

function makeEnv(deploymentCommitSha) {
  return {
    DEPLOY_COMMIT_SHA: deploymentCommitSha,
    CF_VERSION_METADATA: {
      id: "worker-version-id",
      tag: "",
      timestamp: "2026-11-09T00:00:00.000Z"
    },
    TRADING_ENGINE: {
      idFromName(name) {
        assert.equal(name, "single-owner-paper-ledger");
        return "paper-ledger-id";
      },
      get(id) {
        assert.equal(id, "paper-ledger-id");
        return {
          async fetch(request) {
            assert.equal(new URL(request.url).pathname, "/api/health");
            return new Response(JSON.stringify({
              status: "ok",
              mode: "paper_only",
              live_trading_enabled: false,
              binance_testnet_enabled: false,
              schedule_seconds: 90
            }), {
              status: 200,
              headers: { "content-type": "application/json" }
            });
          }
        };
      }
    }
  };
}

test("public health exposes the exact validated Git commit independently of Cloudflare version tags", async () => {
  const sha = "467da4b18601b6fb8d0746cc36c75280d0302af9";
  const response = await worker.fetch(
    new Request("https://worker.example/api/health"),
    makeEnv(sha)
  );
  const health = await response.json();

  assert.equal(response.status, 200);
  assert.equal(health.deployment_commit_sha, sha);
  assert.equal(health.worker_version.id, "worker-version-id");
  assert.equal(health.mode, "paper_only");
  assert.equal(health.live_trading_enabled, false);
  assert.equal(health.binance_testnet_enabled, false);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("cache-control"), "no-store, private");
});

test("public health never echoes malformed deployment metadata", async () => {
  const response = await worker.fetch(
    new Request("https://worker.example/api/health"),
    makeEnv("not-a-git-sha-or-secret")
  );
  const health = await response.json();

  assert.equal(response.status, 200);
  assert.equal(health.deployment_commit_sha, null);
  assert.equal(health.live_trading_enabled, false);
});
