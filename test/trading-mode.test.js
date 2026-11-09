import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTradingMode, selectTradingMode } from "../src/trading-mode.js";

test("unknown or missing mode safely defaults to DEMO", () => {
  assert.equal(normalizeTradingMode(undefined), "demo");
  assert.equal(normalizeTradingMode("unexpected"), "demo");
  assert.equal(normalizeTradingMode("real"), "real");
});

test("switching from DEMO to REAL disables paper automation and watchdog resume", () => {
  const result = selectTradingMode({
    trading_mode: "demo",
    auto_paper_enabled: true,
    auto_paper_resume_after_watchdog: true,
    risk: { risk_per_trade_pct: 1 }
  }, "real");
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.settings.trading_mode, "real");
  assert.equal(result.settings.auto_paper_enabled, false);
  assert.equal(result.settings.auto_paper_resume_after_watchdog, false);
  assert.deepEqual(result.settings.risk, { risk_per_trade_pct: 1 });
});

test("switching to REAL is blocked while a paper position is open", () => {
  const result = selectTradingMode({ trading_mode: "demo" }, "real", {
    openPaperPositions: 1
  });
  assert.deepEqual(result, {
    ok: false,
    reason: "close_open_paper_positions_before_switching_mode"
  });
});

test("mode switching is blocked while any live order is unresolved", () => {
  const result = selectTradingMode({ trading_mode: "demo" }, "real", {
    liveOrders: [{ status: "UNKNOWN" }]
  });
  assert.deepEqual(result, {
    ok: false,
    reason: "reconcile_active_live_orders_before_switching_mode"
  });
});

test("switching back to DEMO does not silently re-enable paper automation", () => {
  const result = selectTradingMode({
    trading_mode: "real",
    auto_paper_enabled: false,
    auto_paper_resume_after_watchdog: false
  }, "demo");
  assert.equal(result.ok, true);
  assert.equal(result.settings.trading_mode, "demo");
  assert.equal(result.settings.auto_paper_enabled, false);
});

test("selecting the already-active DEMO mode preserves its explicit opt-in", () => {
  const result = selectTradingMode({
    trading_mode: "demo",
    auto_paper_enabled: true,
    auto_paper_resume_after_watchdog: true
  }, "demo");
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.settings.auto_paper_enabled, true);
});

test("REAL mode always forces paper auto-entry off, even if legacy state is inconsistent", () => {
  const result = selectTradingMode({
    trading_mode: "real",
    auto_paper_enabled: true,
    auto_paper_resume_after_watchdog: true
  }, "real");
  assert.equal(result.settings.auto_paper_enabled, false);
  assert.equal(result.settings.auto_paper_resume_after_watchdog, false);
});

test("invalid requested mode is rejected", () => {
  assert.deepEqual(selectTradingMode({}, "live"), {
    ok: false,
    reason: "trading_mode_invalid"
  });
});
