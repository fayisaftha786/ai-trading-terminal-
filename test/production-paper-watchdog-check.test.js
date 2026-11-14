import test from "node:test";
import assert from "node:assert/strict";
import { evaluateProductionPaperHealth } from "../scripts/production-paper-watchdog-check.mjs";

const SHA = "ac23f02605b755066eca77ffab6a3427d1ff032d";

function healthyPayload() {
  return {
    status: "ok",
    mode: "paper_only",
    live_trading_enabled: false,
    deployment_commit_sha: SHA,
    worker_version: { id: "version-1" },
    scheduler: {
      status: "healthy",
      last_alarm_age_ms: 1000,
      last_scheduled_scan_status: "completed",
      last_scheduled_scan_age_ms: 30000,
      last_healthy_scan_age_ms: 30000
    },
    scan_diagnostics: {
      last_scheduled_scan_healthy_market_count: 3,
      last_scheduled_scan_expected_market_count: 3,
      current_market_feed: {
        status: "healthy",
        freshness_state: "fresh",
        freshness_reason: "current_market_snapshots_pass_all_entry_data_gates",
        healthy_market_count: 3,
        expected_market_count: 3
      },
      market_book_depth: ["BTC/USD", "ETH/USD", "SOL/USD"].map(symbol => ({
        symbol,
        bid_depth_quote: 10000,
        ask_depth_quote: 10000,
        minimum_depth_quote_per_side: 5000,
        depth_levels: 50
      }))
    }
  };
}

test("accepts a fully healthy Coinbase PAPER Worker snapshot", () => {
  const result = evaluateProductionPaperHealth(healthyPayload(), SHA);
  assert.equal(result.status, "healthy");
  assert.equal(result.ok, true);
  assert.equal(result.retryable, false);
  assert.equal(Object.values(result.checks).every(Boolean), true);
});

test("classifies the exact in-progress scheduled refresh as retryable", () => {
  const health = healthyPayload();
  health.scheduler.status = "running";
  health.scheduler.last_scheduled_scan_status = "running";
  health.scan_diagnostics.current_market_feed = {
    status: "unavailable",
    freshness_state: "refresh_in_progress",
    freshness_reason: "scheduled_market_refresh_is_running",
    healthy_market_count: 0,
    expected_market_count: 3
  };

  const result = evaluateProductionPaperHealth(health, SHA);
  assert.equal(result.status, "retryable_refresh_in_progress");
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.equal(result.checks.currentBidAskDepthComplete, true);
});

test("does not retry a genuine market-data outage", () => {
  const health = healthyPayload();
  health.scan_diagnostics.current_market_feed = {
    status: "unavailable",
    freshness_state: "stale",
    freshness_reason: "order_book_snapshot_expired",
    healthy_market_count: 0,
    expected_market_count: 3
  };

  const result = evaluateProductionPaperHealth(health, SHA);
  assert.equal(result.status, "unhealthy");
  assert.equal(result.retryable, false);
});

test("does not retry an in-progress feed when the scheduler is not running", () => {
  const health = healthyPayload();
  health.scheduler.status = "healthy";
  health.scheduler.last_scheduled_scan_status = "completed";
  health.scan_diagnostics.current_market_feed = {
    status: "unavailable",
    freshness_state: "refresh_in_progress",
    freshness_reason: "scheduled_market_refresh_is_running",
    healthy_market_count: 0,
    expected_market_count: 3
  };

  const result = evaluateProductionPaperHealth(health, SHA);
  assert.equal(result.retryable, false);
  assert.equal(result.status, "unhealthy");
});

test("fails closed when any market lacks the required two-sided L2 depth", () => {
  const health = healthyPayload();
  health.scan_diagnostics.market_book_depth[1].ask_depth_quote = 4999;

  const result = evaluateProductionPaperHealth(health, SHA);
  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
  assert.equal(result.checks.currentBidAskDepthComplete, false);
});

test("fails closed when live trading is enabled or deployed SHA differs", () => {
  const live = healthyPayload();
  live.live_trading_enabled = true;
  const wrongSha = healthyPayload();

  assert.equal(
    evaluateProductionPaperHealth(live, SHA).checks.liveTradingDisabled,
    false
  );
  assert.equal(
    evaluateProductionPaperHealth(wrongSha, "1".repeat(40)).checks.deployedCommitMatchesMain,
    false
  );
});

test("fails closed for stale scheduled heartbeat and incomplete market universe", () => {
  const health = healthyPayload();
  health.scheduler.last_alarm_age_ms = 46 * 60 * 1000;
  health.scan_diagnostics.last_scheduled_scan_healthy_market_count = 2;

  const result = evaluateProductionPaperHealth(health, SHA);
  assert.equal(result.ok, false);
  assert.equal(result.checks.schedulerHeartbeatFresh, false);
  assert.equal(result.checks.lastScheduledUniverseComplete, false);
});
