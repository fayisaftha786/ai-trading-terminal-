import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_HEALTH_AGE_MS = 45 * 60 * 1000;
const EXPECTED_MARKETS = 3;
const MINIMUM_DEPTH_QUOTE = 5000;
const REQUIRED_DEPTH_LEVELS = 50;

function validAge(value) {
  return Number.isFinite(value) && value >= 0 && value <= MAX_HEALTH_AGE_MS;
}

/**
 * Evaluate public production health without weakening any trading-entry gate.
 * The only retryable state is the precise, intentional refresh-in-progress
 * window while a healthy scheduled scan is currently running.
 */
export function evaluateProductionPaperHealth(health, expectedMainSha) {
  const scheduler = health?.scheduler || {};
  const diagnostics = health?.scan_diagnostics || {};
  const currentFeed = diagnostics.current_market_feed || {};
  const scheduledHealthy = Number(diagnostics.last_scheduled_scan_healthy_market_count);
  const scheduledExpected = Number(diagnostics.last_scheduled_scan_expected_market_count);
  const scheduledAge = scheduler.last_scheduled_scan_age_ms ??
    diagnostics.last_scheduled_scan_age_ms;
  const currentHealthy = Number(currentFeed.healthy_market_count);
  const currentExpected = Number(currentFeed.expected_market_count);
  const depthRows = Array.isArray(diagnostics.market_book_depth)
    ? diagnostics.market_book_depth : [];

  const depthComplete = depthRows.length === EXPECTED_MARKETS && depthRows.every(row =>
    typeof row?.symbol === "string" &&
    Number.isFinite(row.bid_depth_quote) && row.bid_depth_quote >= MINIMUM_DEPTH_QUOTE &&
    Number.isFinite(row.ask_depth_quote) && row.ask_depth_quote >= MINIMUM_DEPTH_QUOTE &&
    row.minimum_depth_quote_per_side === MINIMUM_DEPTH_QUOTE &&
    row.depth_levels === REQUIRED_DEPTH_LEVELS
  );

  const checks = {
    statusOk: health?.status === "ok",
    paperOnly: health?.mode === "paper_only",
    liveTradingDisabled: health?.live_trading_enabled === false,
    workerVersionIdPresent: typeof health?.worker_version?.id === "string" &&
      health.worker_version.id.length > 0,
    deployedCommitMatchesMain: typeof expectedMainSha === "string" &&
      /^[0-9a-f]{40}$/i.test(expectedMainSha) &&
      health?.deployment_commit_sha === expectedMainSha.toLowerCase(),
    schedulerHeartbeatFresh: validAge(scheduler.last_alarm_age_ms),
    schedulerNotStale: ["healthy", "running"].includes(scheduler.status),
    lastScheduledScanHealthy: ["completed", "running"].includes(
      scheduler.last_scheduled_scan_status
    ),
    lastScheduledScanFresh: validAge(scheduledAge),
    lastScheduledUniverseComplete: Number.isInteger(scheduledHealthy) &&
      Number.isInteger(scheduledExpected) &&
      scheduledExpected === EXPECTED_MARKETS && scheduledHealthy === scheduledExpected,
    currentMarketFeedHealthy: currentFeed.status === "healthy" &&
      currentFeed.freshness_state === "fresh",
    currentMarketUniverseComplete: Number.isInteger(currentHealthy) &&
      Number.isInteger(currentExpected) &&
      currentExpected === EXPECTED_MARKETS && currentHealthy === currentExpected,
    currentBidAskDepthComplete: depthComplete,
    lastHealthyScanFresh: validAge(scheduler.last_healthy_scan_age_ms)
  };

  const currentSnapshotChecks = [
    "currentMarketFeedHealthy",
    "currentMarketUniverseComplete"
  ];
  const nonSnapshotChecksPassed = Object.entries(checks)
    .filter(([name]) => !currentSnapshotChecks.includes(name))
    .every(([, passed]) => passed);

  const refreshInProgress = currentFeed.status === "unavailable" &&
    currentFeed.freshness_state === "refresh_in_progress" &&
    currentFeed.freshness_reason === "scheduled_market_refresh_is_running" &&
    scheduler.status === "running" &&
    scheduler.last_scheduled_scan_status === "running";

  const ok = Object.values(checks).every(Boolean);
  const retryable = !ok && nonSnapshotChecksPassed && refreshInProgress;

  return {
    status: ok ? "healthy" : retryable ? "retryable_refresh_in_progress" : "unhealthy",
    ok,
    retryable,
    checks,
    scheduler: {
      status: scheduler.status ?? null,
      last_scheduled_scan_status: scheduler.last_scheduled_scan_status ?? null,
      last_alarm_age_ms: scheduler.last_alarm_age_ms ?? null,
      last_scheduled_scan_age_ms: scheduledAge ?? null,
      last_healthy_scan_age_ms: scheduler.last_healthy_scan_age_ms ?? null
    },
    current_market_snapshots: {
      status: currentFeed.status ?? health?.market_data_status ?? "unknown",
      freshness_state: currentFeed.freshness_state ?? "not_reported",
      freshness_reason: currentFeed.freshness_reason ?? null,
      healthy_market_count: currentFeed.healthy_market_count ?? null,
      expected_market_count: currentFeed.expected_market_count ?? null
    },
    current_market_book_depth: depthRows,
    message: ok
      ? "Production PAPER Worker and scheduled heartbeat verified."
      : retryable
        ? "Market refresh is currently running; retrying without relaxing freshness or entry gates."
        : "Production PAPER watchdog checks failed."
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const [healthPath, expectedMainSha] = process.argv.slice(2);
    if (!healthPath || !expectedMainSha) {
      throw new Error("Usage: node scripts/production-paper-watchdog-check.mjs <health-json-file> <expected-main-sha>");
    }
    const health = JSON.parse(readFileSync(healthPath, "utf8"));
    const result = evaluateProductionPaperHealth(health, expectedMainSha);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : result.retryable ? 2 : 1;
  } catch (error) {
    console.error("Production PAPER health validation error:", error.message);
    process.exitCode = 1;
  }
}
