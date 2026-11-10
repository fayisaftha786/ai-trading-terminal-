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
  assert.ok(workerSource.includes('deployment_provenance_status: deploymentCommitSha ? "verified" : "unverified"'));
  assert.match(workerSource, /env\.DEPLOY_COMMIT_SHA\.toLowerCase\(\)/);
  assert.match(workerSource, /worker_version: workerVersion/);
});

test("production deploy injects and verifies the exact GitHub commit", () => {
  assert.match(deploymentWorkflow, /--var DEPLOY_COMMIT_SHA:\$\{\{ github\.sha \}\}/);
  assert.match(deploymentWorkflow, /EXPECTED_DEPLOY_COMMIT_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(deploymentWorkflow, /deploymentCommitMatches: health\.deployment_commit_sha === process\.env\.EXPECTED_DEPLOY_COMMIT_SHA/);
  assert.match(deploymentWorkflow, /liveTradingDisabled: health\.live_trading_enabled === false/);
  assert.match(deploymentWorkflow, /paperOnly: health\.mode === "paper_only"/);
  assert.ok(deploymentWorkflow.includes("Verify production revision remains stable after Cloudflare build hooks"));
  assert.ok(deploymentWorkflow.includes("sleep 120"));
  assert.ok(deploymentWorkflow.includes('provenanceVerified: health.deployment_provenance_status === "verified"'));
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
  assert.match(deploymentWorkflow, /deploy_verify=\$\{GITHUB_SHA\}-\$\{attempt\}/);
  assert.match(deploymentWorkflow, /deployment_commit_sha: health\.deployment_commit_sha/);
  assert.ok(deploymentWorkflow.includes("deployment_provenance_status: health.deployment_provenance_status"));
  assert.match(deploymentWorkflow, /deploymentCommitMatches: health\.deployment_commit_sha === process\.env\.EXPECTED_DEPLOY_COMMIT_SHA/);
});

test("production watchdog checks the injected deployment SHA, not optional version tags", () => {
  assert.match(watchdogWorkflow, /deployedCommitMatchesMain: health\.deployment_commit_sha === process\.env\.EXPECTED_MAIN_SHA/);
  assert.doesNotMatch(watchdogWorkflow, /deployedCommitMatchesMain: health\.worker_version\?\.tag/);
  assert.match(watchdogWorkflow, /freshness_state: currentFeed\.freshness_state/);
  assert.match(watchdogWorkflow, /strict 15-second freshness gate/);
});

test("login rate limiting is independent of scheduler alarm initialization", () => {
  const fetchStart = engineSource.indexOf("async fetch(request) {");
  const authRoute = engineSource.indexOf(
    'if (request.method === "POST" && url.pathname === "/internal/auth/login-attempts")',
    fetchStart
  );
  const alarmInitialization = engineSource.indexOf("await this.ensureAlarm();", fetchStart);
  assert.ok(fetchStart >= 0, "Durable Object fetch handler must exist");
  assert.ok(authRoute > fetchStart, "internal login rate-limit route must be inside fetch");
  assert.ok(alarmInitialization > authRoute, "login rate-limit route must run before scheduler alarm initialization");
});

test("login rate-limit backend failures are logged without exposing internal details to the client", () => {
  assert.match(workerSource, /console\.error\("Login rate-limit reserve request failed"/);
  assert.match(workerSource, /console\.error\("Login rate-limit reserve returned a non-success response"/);
  assert.match(workerSource, /console\.error\("Login rate-limit clear request failed"/);
  assert.match(workerSource, /error: "login_rate_limit_unavailable"/);
});
