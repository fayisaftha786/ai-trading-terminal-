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
    "Manual execution guard",
    "Background order & fill sync"
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

test("read-only Coinbase account refresh starts at login and runs in DEMO and REAL modes every five minutes", () => {
  assert.match(dashboard, /const COINBASE_ACCOUNT_SYNC_INTERVAL_MS=5\*60\*1000/);
  assert.match(dashboard, /if\(!token\)return null;/);
  assert.doesNotMatch(dashboard, /if\(!token\|\|currentTradingMode!=="real"\)return null;/);
  assert.match(dashboard, /if\(status\?\.credentials_configured===true\)\{\s*runCoinbasePreflight\(\{silent:true\}\)/);
  assert.match(dashboard, /!document\.hidden&&token&&coinbaseStaticStatus\?\.credentials_configured===true/);
  assert.match(dashboard, /runCoinbasePreflight\(\{silent:true,force:true\}\)/);
  assert.match(dashboard, /sync_mode:"read_only_account_preflight"/);
  assert.match(dashboard, /never places or cancels orders/i);
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

test("Coinbase UI exposes background scheduled order and fill synchronization", () => {
  assert.match(dashboard, /background_reconciliation/);
  assert.match(dashboard, /Background order & fill sync/);
  assert.match(dashboard, /90-second scheduler/);
  assert.match(dashboard, /retries incomplete terminal fill syncs every 5 minutes/);
});

test("Coinbase connection center shows exchange-side open-order cap diagnostics", () => {
  assert.match(dashboard, /exchange open orders/);
  assert.match(dashboard, /exchange_open_order_count/);
  assert.match(dashboard, /exchange_order_pagination_complete/);
});

test("Coinbase dashboard exposes exchange-side daily order cap diagnostics", () => {
  assert.match(dashboard, /exchange daily orders/);
  assert.match(dashboard, /exchange_daily_order_count/);
  assert.match(dashboard, /exchange_daily_order_pagination_complete/);
});

test("Coinbase connection center exposes a read-only verified FIFO P&L report", () => {
  assert.match(dashboard, /id="liveFillReportButton"/);
  assert.match(dashboard, /api\("\\/api\\/live\\/fills\\/report"\)/);
  assert.match(dashboard, /id="liveFillReport"/);
  assert.match(dashboard, /Unknown fee currency/);
  assert.match(dashboard, /manual\/external Coinbase trades are excluded/);
  assert.match(dashboard, /total P&L withheld until the accounting inputs are complete/);
});
