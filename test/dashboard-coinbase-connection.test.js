import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dashboard = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("premium Coinbase connection center exposes each independent account readiness check", () => {
  for (const id of [
    "coinbaseSyncState",
    "coinbaseLastSync",
    "coinbaseConnectionGrid",
    "coinbaseBalances",
    "coinbaseProducts",
    "coinbaseLimits",
    "livePreflight",
    "liveProduct"
  ]) {
    assert.match(dashboard, new RegExp('id="' + id + '"'));
  }
  for (const label of [
    "Worker credentials",
    "API authentication",
    "View permission",
    "Trade permission",
    "Transfer disabled",
    "Spot products",
    "Available balances",
    "Manual execution guard"
  ]) {
    assert.ok(dashboard.includes(label), "missing connection check: " + label);
  }
});

test("Coinbase UI treats authenticated preflight as the source of account connection truth", () => {
  assert.match(dashboard, /api\("\/api\/live\/status"\)/);
  assert.match(dashboard, /api\("\/api\/live\/preflight",\{method:"POST",body:"\{\}"\}\)/);
  assert.match(dashboard, /const hasPreflight=!!permissions&&result\?\.status!=="provider_check_failed"/);
  assert.match(dashboard, /permissions\?\.can_transfer===false/);
  assert.match(dashboard, /result\?\.order_submission_available===true&&permissions\?\.can_trade===true/);
});

test("read-only Coinbase account refresh runs only in REAL mode and is throttled to five minutes", () => {
  assert.match(dashboard, /const COINBASE_ACCOUNT_SYNC_INTERVAL_MS=5\*60\*1000/);
  assert.match(dashboard, /currentTradingMode==="real"&&coinbaseStaticStatus\?\.credentials_configured===true/);
  assert.match(dashboard, /runCoinbasePreflight\(\{silent:true,force:true\}\)/);
  assert.match(dashboard, /sync_mode:"read_only_account_preflight"/);
  assert.match(dashboard, /it never places, changes or cancels an order/i);
});

test("Coinbase product selection is populated from server-verified eligible products only", () => {
  assert.match(dashboard, /const options=hasPreflight\?eligible:\[\]/);
  assert.match(dashboard, /select\.value=options\.includes\(previous\)\?previous:options\[0\]/);
  assert.match(dashboard, /coinbaseProducts/);
});

test("dashboard never asks for Coinbase private-key material in browser form fields", () => {
  assert.doesNotMatch(dashboard, /id="(?:coinbaseApiSecret|privateKey|apiSecret|secretKey)"/i);
  assert.match(dashboard, /API keys stay in Cloudflare Worker Secrets/);
  assert.match(dashboard, /never enter them in this page or chat/i);
});
