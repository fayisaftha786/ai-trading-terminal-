import test from "node:test";
import assert from "node:assert/strict";
import {
  PAPER_AUTOMATION_PROFILE,
  PAPER_AUTOMATION_RISK,
  calculateDynamicTakeProfit,
  getDailyCycleAllowance,
  countCompletedPaperCyclesInWindow,
  migratePaperAutomationSettings,
  shouldAutoResumeWatchdog
} from "../src/paper-automation-profile.js";

test("fresh paper automation profile starts with ten dollars and sequential limits", () => {
  const settings = migratePaperAutomationSettings(null, 0);
  assert.equal(settings.initial_capital_usd, 10);
  assert.equal(settings.peak_equity_usd, 10);
  assert.equal(settings.auto_paper_enabled, true);
  assert.equal(settings.halted, false);
  assert.equal(settings.risk.max_open_positions, 1);
  assert.equal(settings.risk.max_position_notional_usd, 8);
  assert.equal(PAPER_AUTOMATION_PROFILE.cash_reserve_usd, 2);
  assert.equal(PAPER_AUTOMATION_PROFILE.max_cycles_per_day, 5);
  assert.equal(PAPER_AUTOMATION_RISK.max_daily_loss_pct, 1);
});

test("empty legacy paper ledger safely migrates from 100 to 10 dollars", () => {
  const settings = migratePaperAutomationSettings({
    initial_capital_usd: 100,
    peak_equity_usd: 100,
    risk: { max_open_positions: 3 },
    auto_paper_enabled: false,
    halted: false
  }, 0);
  assert.equal(settings.initial_capital_usd, 10);
  assert.equal(settings.peak_equity_usd, 10);
  assert.equal(settings.auto_paper_enabled, true);
  assert.equal(settings.risk.max_open_positions, 1);
  assert.equal(settings.capital_setup_required, false);
});

test("paper ledger with trade history is never silently rebased", () => {
  const settings = migratePaperAutomationSettings({
    initial_capital_usd: 100,
    peak_equity_usd: 102,
    auto_paper_enabled: true,
    halted: false
  }, 3);
  assert.equal(settings.initial_capital_usd, 100);
  assert.equal(settings.auto_paper_enabled, false);
  assert.equal(settings.capital_setup_required, true);
  assert.equal(settings.capital_setup_required_reason, "existing_paper_ledger_not_rebased_automatically");
});

test("dynamic take-profit clears estimated round-trip costs with a minimum net buffer", () => {
  const costDriven = calculateDynamicTakeProfit({ atrPct: 0.5, roundTripCostBps: 140 });
  assert.equal(costDriven.ok, true);
  assert.equal(costDriven.target_bps, 210);
  assert.equal(costDriven.estimated_net_edge_bps, 70);

  const volatilityDriven = calculateDynamicTakeProfit({ atrPct: 3, roundTripCostBps: 100 });
  assert.equal(volatilityDriven.ok, true);
  assert.equal(volatilityDriven.target_bps, 240);
  assert.ok(volatilityDriven.estimated_net_edge_bps > 0);
});

test("dynamic take-profit rejects invalid costs and extreme targets", () => {
  assert.equal(calculateDynamicTakeProfit({ atrPct: 1, roundTripCostBps: 0 }).ok, false);
  assert.equal(calculateDynamicTakeProfit({ atrPct: 8, roundTripCostBps: 350 }).ok, false);
  assert.equal(calculateDynamicTakeProfit({ atrPct: 0, roundTripCostBps: 100 }).ok, false);
});

test("daily cycle allowance stops at five completed BUY/SELL cycles and never forces a trade", () => {
  assert.deepEqual(getDailyCycleAllowance(0), { limit: 5, used: 0, remaining: 5, allowed: true });
  assert.deepEqual(getDailyCycleAllowance(4), { limit: 5, used: 4, remaining: 1, allowed: true });
  assert.deepEqual(getDailyCycleAllowance(5), { limit: 5, used: 5, remaining: 0, allowed: false });
  assert.equal(getDailyCycleAllowance(100).allowed, false);
});

test("watchdog pause auto-recovers after two healthy scheduled scans but manual halt does not", () => {
  assert.equal(shouldAutoResumeWatchdog({
    halted: true, haltReason: "market_data_watchdog", healthyScheduledScanStreak: 1
  }), false);
  assert.equal(shouldAutoResumeWatchdog({
    halted: true, haltReason: "market_data_watchdog", healthyScheduledScanStreak: 2
  }), true);
  assert.equal(shouldAutoResumeWatchdog({
    halted: true, haltReason: "owner_emergency_stop", healthyScheduledScanStreak: 10
  }), false);
  assert.equal(shouldAutoResumeWatchdog({
    halted: false, haltReason: "market_data_watchdog", healthyScheduledScanStreak: 10
  }), false);
});


test("daily cycle count includes only SELL-completed positions inside the UTC day window", () => {
  const calls = [];
  const sql = {
    exec(statement, startMs, endMs) {
      calls.push({ statement, startMs, endMs });
      return { toArray: () => [{ count: 2 }] };
    }
  };
  const count = countCompletedPaperCyclesInWindow(sql, 1000, 2000);
  assert.equal(count, 2);
  assert.equal(calls.length, 1);
  assert.match(calls[0].statement, /status='CLOSED'/);
  assert.match(calls[0].statement, /closed_at_ms>=\?/);
  assert.match(calls[0].statement, /closed_at_ms<\?/);
  assert.deepEqual([calls[0].startMs, calls[0].endMs], [1000, 2000]);
});

test("daily cycle counting fails closed when the ledger count is malformed", () => {
  const sql = { exec: () => ({ toArray: () => [{ count: "not-a-count" }] }) };
  assert.throws(
    () => countCompletedPaperCyclesInWindow(sql, 1000, 2000),
    /paper_cycle_count_unavailable/
  );
  assert.throws(
    () => countCompletedPaperCyclesInWindow(sql, 2000, 1000),
    /paper_cycle_count_window_invalid/
  );
});
