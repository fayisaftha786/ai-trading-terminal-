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

const authLimiterSource = readFileSync(new URL("../src/auth-rate-limiter.js", import.meta.url), "utf8");
const workerConfigSource = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");

test("owner login uses a dedicated Durable Object rate limiter, not the trading engine", () => {
  const loginStart = workerSource.indexOf("async function login(request, env)");
  const routeStart = workerSource.indexOf("async function routeApi", loginStart);
  const loginSource = workerSource.slice(loginStart, routeStart);
  assert.ok(workerSource.includes('import { AuthRateLimiter } from "./auth-rate-limiter.js";'));
  assert.ok(loginSource.includes("env.AUTH_RATE_LIMITER.idFromName"));
  assert.ok(loginSource.includes("limiter.fetch("));
  assert.ok(!loginSource.includes("TRADING_ENGINE") && !loginSource.includes("engine.fetch("));
});

test("dedicated rate limiter enforces eight attempts per ten-minute window", () => {
  assert.ok(authLimiterSource.includes("const windowMs = 10 * 60 * 1000;"));
  assert.ok(authLimiterSource.includes("const attemptLimit = 8;"));
  assert.ok(authLimiterSource.includes("too_many_login_attempts"));
  assert.ok(authLimiterSource.includes("rate_limit_storage_unavailable"));
  assert.ok(authLimiterSource.includes("ip_hash TEXT NOT NULL"));
  assert.ok(!authLimiterSource.includes("cf-connecting-ip"));
});

test("Wrangler registers the isolated auth limiter as a new SQLite Durable Object migration", () => {
  assert.ok(workerConfigSource.includes('"name": "AUTH_RATE_LIMITER", "class_name": "AuthRateLimiter"'));
  assert.ok(workerConfigSource.includes('"tag": "v1", "new_sqlite_classes": ["TradingEngine"]'));
  assert.ok(workerConfigSource.includes('"tag": "v2", "new_sqlite_classes": ["AuthRateLimiter"]'));
});

test("trading health requests can still respond when scheduler alarm setup fails", () => {
  assert.ok(engineSource.includes("Trading engine alarm initialization failed"));
  assert.ok(engineSource.includes("try {\n        await this.ensureAlarm();\n      } catch (error)"));
});

test("research candle cache reads only the 150 closed bars required by audit gates", () => {
  const cacheStart = engineSource.indexOf("  loadResearchCandleCache(");
  const cacheEnd = engineSource.indexOf("  async ensureAlarm()", cacheStart);
  const cacheMethod = engineSource.slice(cacheStart, cacheEnd);
  assert.ok(cacheMethod.includes("ORDER BY candle_open_ms DESC LIMIT 150"));
  assert.ok(!cacheMethod.includes("LIMIT 300"));
});

test("10-second book refresh reuses loaded markets and avoids full-ledger portfolio aggregation", () => {
  const start = engineSource.indexOf("async refreshOrderBooksOnly()");
  const end = engineSource.indexOf("  getOpenTrades() {", start);
  const refresh = engineSource.slice(start, end);
  assert.equal(refresh.split("this.getMarkets()").length - 1, 1);
  assert.ok(refresh.includes("const refreshedMarkets = markets"));
  assert.ok(refresh.includes("this.buildPositionLockedBidMarks(refreshedMarkets, Date.now(), openTrades)"));
  assert.ok(refresh.includes("this.monitorExits(markBySymbol, risk, Date.now(), openTrades)"));
  assert.ok(!refresh.includes("this.portfolio("));
});

test("authentication limiter does not globally sweep its SQL table on every login", () => {
  const limiterSource = readFileSync(new URL("../src/auth-rate-limiter.js", import.meta.url), "utf8");
  assert.ok(limiterSource.includes("const windowMs = 10 * 60 * 1000;"));
  assert.ok(limiterSource.includes("this.lastMaintenanceAtMs >= 60 * 60 * 1000"));
  assert.ok(limiterSource.includes("DELETE FROM auth_login_attempts WHERE ip_hash=? AND attempted_at_ms < ?"));
  assert.ok(limiterSource.includes("attemptLimit = 8"));
});

test("Durable Object failures return controlled HTTP 503 instead of an unhandled Worker exception", () => {
  assert.ok(workerSource.includes("Trading engine Durable Object request failed"));
  assert.ok(workerSource.includes('error: "trading_engine_temporarily_unavailable"'));
  assert.ok(workerSource.includes("return await stub.fetch(request)"));
});
