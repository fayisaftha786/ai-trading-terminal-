import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const port = 8787;
const base = "http://127.0.0.1:" + port;
const password = "SmokeTest-PaperOnly-2026!";
const secret = "smoke-test-session-secret-which-is-over-32-bytes";
const command = process.platform === "win32" ? "npx.cmd" : "npx";
const args = [
  "--yes", "wrangler@4", "dev", "--local", "--port", String(port),
  "--persist-to", ".wrangler/smoke-state",
  "--var", "ADMIN_PASSWORD:" + password,
  "--var", "SESSION_SECRET:" + secret
];

const child = spawn(command, args, {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  detached: process.platform !== "win32"
});

let output = "";
child.stdout.on("data", (chunk) => { output += chunk.toString(); });
child.stderr.on("data", (chunk) => { output += chunk.toString(); });

async function request(path, options = {}) {
  return fetch(base + path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    signal: AbortSignal.timeout(5000)
  });
}

try {
  let ready = false;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Wrangler dev exited early: " + child.exitCode + " " + child.signalCode);
    try {
      const response = await request("/api/health");
      if (response.ok) { ready = true; break; }
      if (response.status >= 500) throw new Error("Local Worker health returned HTTP " + response.status + ": " + (await response.text()).slice(0, 1000));
    } catch {
      // The local workerd process may still be starting.
    }
    await delay(500);
  }
  assert.equal(ready, true, "Local Worker did not become ready within 90 seconds");

  const health = await request("/api/health").then((response) => response.json());
  assert.equal(health.status, "ok");
  assert.equal(health.mode, "paper_only");
  assert.equal(health.live_trading_enabled, false);
  assert.equal(health.binance_testnet_enabled, false);

  const anonymousDashboard = await request("/api/dashboard");
  assert.equal(anonymousDashboard.status, 401, "dashboard must require authentication");

  const loginResponse = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "admin", password })
  });
  assert.equal(loginResponse.status, 200, "valid owner login must succeed");
  const login = await loginResponse.json();
  assert.equal(login.token_type, "Bearer");
  assert.ok(login.access_token);

  const auth = { authorization: "Bearer " + login.access_token };
  const dashboardResponse = await request("/api/dashboard", { headers: auth });
  assert.equal(dashboardResponse.status, 200, "owner dashboard must load");
  const dashboard = await dashboardResponse.json();
  assert.equal(dashboard.mode, "paper_only");
  assert.equal(dashboard.settings.auto_paper_enabled, false, "paper automation must default OFF");
  assert.equal(dashboard.live_trading_enabled, false);
  assert.deepEqual(dashboard.research_history, [], "research archive starts empty before a successful live-data scan");
  const researchHistory = await request("/api/research/history", { headers: auth });
  assert.equal(researchHistory.status, 200, "owner research-history API must load");
  const researchPayload = await researchHistory.json();
  assert.equal(researchPayload.mode, "read_only");
  assert.deepEqual(researchPayload.history, []);

  const enable = await request("/api/automation/paper-trading", {
    method: "PUT", headers: auth, body: JSON.stringify({ enabled: true })
  });
  assert.equal(enable.status, 200);
  assert.equal((await enable.json()).enabled, true);

  const stop = await request("/api/automation/kill-switch", { method: "POST", headers: auth });
  assert.equal(stop.status, 200);
  assert.equal((await stop.json()).halted, true);

  const statusAfterStop = await request("/api/automation/status", { headers: auth }).then((r) => r.json());
  assert.equal(statusAfterStop.enabled, false);
  assert.equal(statusAfterStop.halted, true);

  const reset = await request("/api/automation/reset", { method: "POST", headers: auth });
  assert.equal(reset.status, 200);
  const statusAfterReset = await request("/api/automation/status", { headers: auth }).then((r) => r.json());
  assert.equal(statusAfterReset.enabled, false);
  assert.equal(statusAfterReset.halted, false);

  const staticPage = await request("/");
  assert.equal(staticPage.status, 200);
  const staticHtml = await staticPage.text();
  assert.match(staticHtml, /AI TRADING TERMINAL/);
  assert.match(staticHtml, /ENTRY GATE/);
  assert.match(staticHtml, /Per-market gate results are read-only diagnostics/);
  assert.match(staticHtml, /Research data archive/);
  assert.match(staticHtml, /id="researchHistory"/);

  process.stdout.write("CLOUDFLARE_LOCAL_RUNTIME_SMOKE_OK\n");
} catch (error) {
  process.stderr.write(output.slice(-12000) + "\n");
  process.stderr.write(String(error?.stack || error) + "\n");
  process.exitCode = 1;
} finally {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch { /* The process may already have exited. */ }
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(4000)
  ]);
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
    else if (child.exitCode === null) child.kill("SIGKILL");
  } catch { /* The process group may already have exited. */ }
}
