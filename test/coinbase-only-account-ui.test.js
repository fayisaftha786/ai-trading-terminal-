import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const engine = readFileSync(new URL("../src/engine.js", import.meta.url), "utf8");
const marketData = readFileSync(new URL("../src/coinbase.js", import.meta.url), "utf8");
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const cloudflareGuide = readFileSync(new URL("../docs/CLOUDFLARE_FREE_PAPER_AUTOMATION.md", import.meta.url), "utf8");

test("Coinbase is the only exchange account and order connector in the dashboard", () => {
  assert.match(html, /REAL MODE · Coinbase Advanced account connection/);
  assert.match(html, /id="realModePanel"/);
  assert.match(html, /id="exchangeConnections"/);
  assert.doesNotMatch(html, /binance|testnet|ccxt/i);
  assert.doesNotMatch(html, /\/binance-radar\.js/);
});

test("new live scans and entries are Coinbase-only; Bitstamp is legacy-exit-only", () => {
  assert.match(readme, /Coinbase is the only supported centralized-exchange account\/order connector/);
  assert.match(readme, /legacy PAPER position/);
  assert.doesNotMatch(engine, /\/api\/research\/backfill|backfillBitstampResearchHistory|archiveProviderHistoryBackfill/);
  assert.doesNotMatch(marketData, /fetchBitstampResearchHistory/);
  assert.ok(readme.includes("Automatic strategy execution remains PAPER-only"));
  assert.match(cloudflareGuide, /manually previewed and separately owner-confirmed orders/);
  assert.match(cloudflareGuide, /automatic live entries are not implemented/);
});
