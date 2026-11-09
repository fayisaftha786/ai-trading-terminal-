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
