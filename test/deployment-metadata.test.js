import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workerSource = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
const deploymentWorkflow = readFileSync(
  new URL("../.github/workflows/deploy-cloudflare-worker.yml", import.meta.url),
  "utf8"
);

test("Worker health binds only a validated deployment Git SHA", () => {
  assert.match(workerSource, /typeof env\.DEPLOY_COMMIT_SHA === "string"/);
  assert.match(workerSource, /\/\^\[a-f0-9\]\{40\}\$\/i\.test\(env\.DEPLOY_COMMIT_SHA\)/);
  assert.match(workerSource, /deployment_commit_sha: deploymentCommitSha/);
  assert.match(workerSource, /env\.DEPLOY_COMMIT_SHA\.toLowerCase\(\)/);
  assert.match(workerSource, /worker_version: workerVersion/);
});

test("production deploy injects and verifies the exact GitHub commit", () => {
  assert.match(deploymentWorkflow, /--var DEPLOY_COMMIT_SHA:\$\{\{ github\.sha \}\}/);
  assert.match(deploymentWorkflow, /EXPECTED_DEPLOY_COMMIT_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(deploymentWorkflow, /deploymentCommitMatches: health\.deployment_commit_sha === process\.env\.EXPECTED_DEPLOY_COMMIT_SHA/);
  assert.match(deploymentWorkflow, /liveTradingDisabled: health\.live_trading_enabled === false/);
  assert.match(deploymentWorkflow, /paperOnly: health\.mode === "paper_only"/);
});

test("production deployment runs automatically on main pushes", () => {
  assert.match(deploymentWorkflow, /push:\s+branches:\s+- main/);
  assert.match(deploymentWorkflow, /workflow_dispatch:/);
});


const engineSource = readFileSync(new URL("../src/engine.js", import.meta.url), "utf8");
const dashboardSource = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("dashboard API exposes explicit market-feed freshness diagnostics", () => {
  assert.match(engineSource, /currentMarketFeedDiagnostics/);
  assert.match(engineSource, /freshness_state: marketFeedFreshness\.state/);
  assert.match(engineSource, /freshness_reason: marketFeedFreshness\.reason/);
  assert.match(engineSource, /status: currentMarketStatus/);
});

test("dashboard UI never labels an omitted market-feed status as UNKNOWN", () => {
  assert.match(dashboardSource, /feedStatus=currentFeed\.status\|\|\(currentFeed\.healthy===true\?"healthy":Number\(currentFeed\.healthy_market_count\|\|0\)>0\?"partial":"unavailable"\)/);
  assert.match(dashboardSource, /currentFeed\.freshness_state/);
  assert.match(dashboardSource, /currentFeed\.freshness_reason/);
});


const watchdogWorkflow = readFileSync(
  new URL("../.github/workflows/production-paper-watchdog.yml", import.meta.url),
  "utf8"
);

test("deployment verification bypasses cached health responses and reports provenance", () => {
  assert.match(deploymentWorkflow, /deploy_verify=\\$\\{GITHUB_SHA\\}-\\$\\{attempt\\}/);
  assert.match(deploymentWorkflow, /deployment_commit_sha: health\.deployment_commit_sha/);
  assert.match(deploymentWorkflow, /deploymentCommitMatches: health\.deployment_commit_sha === process\.env\.EXPECTED_DEPLOY_COMMIT_SHA/);
});

test("production watchdog checks the injected deployment SHA, not optional version tags", () => {
  assert.match(watchdogWorkflow, /deployedCommitMatchesMain: health\.deployment_commit_sha === process\.env\.EXPECTED_MAIN_SHA/);
  assert.doesNotMatch(watchdogWorkflow, /deployedCommitMatchesMain: health\.worker_version\?\.tag/);
  assert.match(watchdogWorkflow, /freshness_state: currentFeed\.freshness_state/);
  assert.match(watchdogWorkflow, /strict 15-second freshness gate/);
});
