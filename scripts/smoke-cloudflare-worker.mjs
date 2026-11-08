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
  const anonymousResearch = await request("/api/research/history");
  assert.equal(anonymousResearch.status, 401, "research archive must require authentication");
  const anonymousTournament = await request("/api/research/tournament");
  assert.equal(anonymousTournament.status, 401, "strategy tournament must require authentication");

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

  const initialScheduler = await request("/api/automation/status", { headers: auth });
  assert.equal(initialScheduler.status, 200, "owner scheduler watchdog API must load");
  const scheduler = await initialScheduler.json();
  assert.equal(scheduler.scanner_status, "starting", "scheduler watchdog must expose starting state before its first scheduled alarm");
  assert.equal(scheduler.last_scan_age_ms, null, "scan age must be null before the first completed scan");
  assert.equal(scheduler.last_scheduled_alarm_age_ms, null, "scheduled heartbeat age must be null before the first alarm");
  assert.equal(scheduler.last_scheduled_scan_status, "not_run", "scheduled scan state must be explicit before first alarm");
  assert.ok(Number.isFinite(scheduler.next_alarm_in_ms), "scheduler watchdog must expose the next durable alarm countdown");
  assert.ok(scheduler.next_alarm_in_ms >= 0 && scheduler.next_alarm_in_ms <= 30000, "first alarm must be scheduled within 30 seconds");
  const researchHistory = await request("/api/research/history", { headers: auth });
  assert.equal(researchHistory.status, 200, "owner research-history API must load");
  const researchPayload = await researchHistory.json();
  assert.equal(researchPayload.mode, "read_only");
  assert.deepEqual(researchPayload.history, []);

  const tournamentResponse = await request("/api/research/tournament", { headers: auth });
  assert.equal(tournamentResponse.status, 200, "owner strategy tournament API must load");
  const tournament = await tournamentResponse.json();
  assert.equal(tournament.mode, "offline_research_only");
  assert.equal(tournament.no_trading_side_effects, true);
  assert.equal(tournament.assets.length, 3);
  assert.ok(tournament.assets.every((asset) => asset.exploratory.ok === false));
  const settingsAfterResearch = await request("/api/automation/paper-trading", { headers: auth }).then((r) => r.json());
  assert.equal(settingsAfterResearch.enabled, false, "research must not enable paper automation");

  const enableWithoutFreshScan = await request("/api/automation/paper-trading", {
    method: "PUT", headers: auth, body: JSON.stringify({ enabled: true })
  });
  assert.equal(enableWithoutFreshScan.status, 409, "auto-entry must require a recent complete scheduled scan");
  assert.equal((await enableWithoutFreshScan.json()).error, "fresh_complete_scheduled_scan_required");

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
  assert.match(staticHtml, /schedulerLabels/);
  assert.match(staticHtml, /last_scan_error/);
  assert.match(staticHtml, /next_alarm_in_ms/);
  assert.match(staticHtml, /id="researchHistory"/);
  assert.match(staticHtml, /Strategy tournament/);
  assert.match(staticHtml, /id="runTournament"/);

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
