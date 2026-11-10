import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const radar = readFileSync(new URL("../public/binance-radar.js", import.meta.url), "utf8");
const worker = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");

test("premium terminal navigation links to the main operating surfaces", () => {
  for (const id of [
    "modePanel", "liveMarketPanel", "binanceRadarPanel", "binanceStrategyPanel", "marketIntelligencePanel",
    "exchangeConnections", "automationPanel", "researchArchivePanel",
    "performancePanel", "paperLedgerPanel"
  ]) assert.ok(html.includes('href="#' + id + '"') || html.includes('id="' + id + '"'), "missing navigation target " + id);
  assert.match(html, /class="app-nav"/);
  assert.match(html, /prefers-reduced-motion:reduce/);
});

test("50-market radar has live metrics, search, filters, sorting and a clear monitor-only label", () => {
  for (const id of [
    "radarFeedState", "radarMarketCount", "radarLiveCount", "radarMedianSpread",
    "radarTopMover", "radarSearch", "radarFilter", "radarSort",
    "radarRefresh", "binanceRadarRows"
  ]) assert.match(html, new RegExp('id="' + id + '"'));
  assert.match(html, /50-market liquidity radar/);
  assert.match(html, /does not generate BUY\/SELL signals or submit orders/);
  assert.match(html, /assumes USD\/USDT parity/);
  assert.match(html, /src="\/binance-radar\.js"/);
});

test("radar uses the public-data-only endpoints and never accesses account credentials", () => {
  assert.match(radar, /https:\/\/data-api\.binance\.vision\/api\/v3\/ticker\/24hr/);
  assert.match(radar, /wss:\/\/data-stream\.binance\.vision\/stream/);
  assert.match(radar, /BINANCE_RADAR_LIMIT = 50/);
  assert.match(radar, /@ticker/);
  assert.doesNotMatch(radar, /apiKey|apiSecret|API_SECRET|X-MBX-APIKEY/i);
});

test("content security policy permits only the Coinbase and Binance public market data origins used by the page", () => {
  assert.match(worker, /https:\/\/api\.exchange\.coinbase\.com/);
  assert.match(worker, /wss:\/\/ws-feed\.exchange\.coinbase\.com/);
  assert.match(worker, /https:\/\/data-api\.binance\.vision/);
  assert.match(worker, /wss:\/\/data-stream\.binance\.vision/);
  assert.match(worker, /frame-ancestors 'none'/);
});

test("AI Brain uses parallel 25-market batches and visibly reports verified candle-cache use", () => {
  assert.match(html, /AI Brain · 50-market multi-timeframe engine/);
  assert.match(html, /index\+=25/);
  assert.match(html, /Promise\.all\(chunks\.map/);
  assert.match(html, /timeframe\(s\) reused/);
  assert.match(html, /new closed bar is due/);
  assert.match(radar, /window\.binanceRadarSymbols = markets\.map/);
});
