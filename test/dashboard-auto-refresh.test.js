import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const engine = readFileSync(new URL("../src/engine.js", import.meta.url), "utf8");

test("dashboard refreshes live scan status every 30 seconds while visible", () => {
  assert.match(html, /boot\(\);setInterval\(\(\)=>\{if\(!document\.hidden&&token\)refresh\(\);\},30000\);/);
});

test("dashboard immediately refreshes after returning to the foreground", () => {
  assert.match(html, /else if\(token\)\{connectMarketFeed\(\);updateTickerFreshness\(\);refresh\(\);\}/);
});

test("server-side scheduled scanner continues independently of dashboard visibility", () => {
  assert.match(engine, /const SCAN_INTERVAL_MS = 90 \* 1000/);
  assert.match(engine, /const BOOK_REFRESH_INTERVAL_MS = 10 \* 1000/);
  assert.match(engine, /this\.runShadowCycle\(markets, marketFeed, risk, Date\.now\(\)\)/);
});
