import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const worker = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");

test("premium terminal navigation links to the main operating surfaces", () => {
  for (const id of [
    "modePanel", "liveMarketPanel", "marketIntelligencePanel", "exchangeConnections",
    "automationPanel", "researchArchivePanel", "performancePanel", "paperLedgerPanel"
  ]) assert.ok(html.includes('href="#' + id + '"') || html.includes('id="' + id + '"'), "missing navigation target " + id);
  assert.match(html, /class="app-nav"/);
  assert.match(html, /prefers-reduced-motion:reduce/);
});

test("Coinbase public market monitor and historical chart remain available", () => {
  assert.match(html, /Coinbase Exchange ticker stream/);
  assert.match(html, /Coinbase historical candlestick chart/);
  assert.match(html, /BTC \/ USD/);
  assert.match(html, /ETH \/ USD/);
  assert.match(html, /SOL \/ USD/);
  assert.match(html, /marketChart/);
});

test("Coinbase is the sole exchange connector visible in the cloud dashboard", () => {
  assert.match(html, /REAL MODE · Coinbase Advanced account connection/);
  assert.match(html, /id="realModePanel"/);
  assert.match(html, /Coinbase Advanced/);
  assert.doesNotMatch(html, /binance|testnet|ccxt/i);
  assert.doesNotMatch(html, /\/binance-radar\.js/);
});

test("content security policy allows Coinbase public market data only", () => {
  assert.match(worker, /https:\/\/api\.exchange\.coinbase\.com/);
  assert.match(worker, /wss:\/\/ws-feed\.exchange\.coinbase\.com/);
  assert.doesNotMatch(worker, /binance/i);
  assert.match(worker, /frame-ancestors 'none'/);
});

test("paper automation remains distinct from guarded manual Coinbase execution", () => {
  assert.match(html, /PRIVATE CLOUD \/ PAPER AUTOMATION/);
  assert.match(html, /Enable paper auto-entry/);
  assert.match(html, /Confirm &amp; submit REAL order/);
  assert.match(html, /live execution locked/);
});

test("market radar surfaces the cost-adjusted take-profit and net reward-risk for qualified entries", () => {
  assert.match(html, /Net R:R/);
  assert.match(html, /dynamic_take_profit_pct/);
  assert.match(html, /round_trip_cost_bps/);
});

test("dashboard distinguishes expected between-scan book expiry from provider outage", () => {
  assert.match(html, /BETWEEN-SCAN EXPIRED/);
  assert.match(html, /each 90s entry scan fetches a fresh Coinbase order book/);
  assert.match(html, /This is not a provider failure/);
});

test("mode summary and automation panel use the same dashboard automation snapshot", () => {
  assert.ok(html.includes("const a=data.automation||{};const modeIsDemo="));
  assert.ok(html.includes("const paperState=a.halted?"));
  assert.ok(html.includes('$("modeNote").textContent=modeIsDemo?'));
});


test("dashboard labels the 10-second L2 refresh as position-exit monitoring, not the entry-scan book fetch", () => {
  assert.match(html, /Position-exit L2 refresh \(10s while positions are open\)/);
  assert.match(html, /Automatic PAPER entries are OFF by default/);
  assert.match(html, /live AUTO status above is authoritative/);
});
