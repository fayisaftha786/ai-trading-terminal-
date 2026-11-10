import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/engine.js", import.meta.url), "utf8");
const constructorStart = source.indexOf("const currentSettings = this.getState(\"settings\");");
const constructorEnd = source.indexOf("this.sql.exec(\n      \"INSERT OR IGNORE INTO app_state(key,value_json) VALUES(?,?)\",\n      \"runtime\"", constructorStart);
const constructor = source.slice(constructorStart, constructorEnd);

test("Durable Object startup skips historical ledger reads after profile migration", () => {
  assert.ok(constructor.includes("Number(currentSettings?.paper_automation_profile_version || 0) < PAPER_AUTOMATION_PROFILE.version"));
  assert.ok(constructor.includes("SELECT 1 AS has_trades FROM trades LIMIT 1"));
  assert.ok(!constructor.includes("SELECT COUNT(*) AS count FROM trades"));
});

test("dashboard trade analytics reuses a short-lived cached summary instead of rescanning the full ledger each refresh", () => {
  assert.ok(source.includes("const TRADE_ANALYTICS_CACHE_TTL_MS = 5 * 60 * 1000;"));
  assert.ok(source.includes('this.getState("trade_analytics_cache")'));
  assert.ok(source.includes("nowMs - Number(cached.calculated_at_ms) < TRADE_ANALYTICS_CACHE_TTL_MS"));
  assert.ok(source.includes("this.computeTradeAnalytics()"));
  assert.ok(source.includes('this.setState("trade_analytics_cache", { calculated_at_ms: nowMs, value })'));
});
