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
