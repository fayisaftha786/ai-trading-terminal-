import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const cloudflareGuide = readFileSync(new URL("../docs/CLOUDFLARE_FREE_PAPER_AUTOMATION.md", import.meta.url), "utf8");

test("Coinbase is the only visible exchange account and order connector", () => {
  assert.match(html, /REAL MODE · Coinbase Advanced account connection/);
  assert.match(html, /id="realModePanel"/);
  assert.match(html, /id="binanceReadonlyPanel"[^>]*class="panel hidden"/);
  assert.match(html, /COINBASE-ONLY ACCOUNT MODE/);
  assert.match(html, /no Binance account connection or Binance order execution is used/i);
});

test("Binance public radar is explicitly research-only and not an execution connector", () => {
  assert.match(html, /id="binanceRadarPanel"/);
  assert.match(html, /RESEARCH \/ MONITOR ONLY/);
  assert.match(html, /does not generate BUY\/SELL signals or submit orders/);
});

test("release documentation distinguishes guarded manual Coinbase orders from automatic live trading", () => {
  assert.match(readme, /Coinbase Advanced is the only exchange account\/order connector/);
  assert.match(readme, /automatic live entries/);
  assert.match(cloudflareGuide, /manually previewed and separately owner-confirmed orders/);
  assert.match(cloudflareGuide, /automatic live entries are not implemented/);
});
