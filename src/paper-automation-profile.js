export const PAPER_AUTOMATION_PROFILE = Object.freeze({
  version: 2,
  initial_capital_usd: 10,
  max_cycles_per_day: 5,
  max_position_notional_usd: 8,
  cash_reserve_usd: 2
});

export const PAPER_AUTOMATION_RISK = Object.freeze({
  risk_per_trade_pct: 1,
  max_daily_loss_pct: 1,
  max_weekly_loss_pct: 4,
  max_total_exposure_pct: 80,
  max_open_positions: 1,
  stop_loss_pct: 1,
  take_profit_pct: 3,
  fee_bps_per_side: 60,
  slippage_bps: 10,
  max_total_drawdown_pct: 5,
  daily_profit_lock_pct: 1,
  soft_loss_guard_fraction: 0.75,
  max_position_notional_usd: 8
});

export function migratePaperAutomationSettings(existing, tradeCount = 0) {
  const totalTrades = Number.isSafeInteger(Number(tradeCount)) && Number(tradeCount) >= 0
    ? Number(tradeCount) : 0;
  const base = {
    initial_capital_usd: PAPER_AUTOMATION_PROFILE.initial_capital_usd,
    risk: { ...PAPER_AUTOMATION_RISK },
    auto_paper_enabled: false,
    auto_paper_resume_after_watchdog: false,
    halted: false,
    halt_reason: null,
    peak_equity_usd: PAPER_AUTOMATION_PROFILE.initial_capital_usd,
    paper_automation_profile_version: PAPER_AUTOMATION_PROFILE.version,
    capital_setup_required: false
  };
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) return base;

  const settings = {
    ...base,
    ...existing,
    risk: { ...base.risk, ...(existing.risk && typeof existing.risk === "object" ? existing.risk : {}) }
  };
  if (Number(existing.paper_automation_profile_version) >= PAPER_AUTOMATION_PROFILE.version) {
    return settings;
  }

  if (totalTrades > 0 && Number(existing.initial_capital_usd) !== PAPER_AUTOMATION_PROFILE.initial_capital_usd) {
    return {
      ...settings,
      auto_paper_enabled: false,
      auto_paper_resume_after_watchdog: false,
      capital_setup_required: true,
      capital_setup_required_reason: "existing_paper_ledger_not_rebased_automatically"
    };
  }

  if (totalTrades === 0) {
    return {
      ...base,
      halted: existing.halted === true,
      halt_reason: existing.halt_reason || (existing.halted === true ? "legacy_manual_halt" : null),
      auto_paper_enabled: false,
      auto_paper_resume_after_watchdog: false
    };
  }

  return {
    ...settings,
    initial_capital_usd: PAPER_AUTOMATION_PROFILE.initial_capital_usd,
    paper_automation_profile_version: PAPER_AUTOMATION_PROFILE.version,
    capital_setup_required: false,
    auto_paper_enabled: false,
    auto_paper_resume_after_watchdog: false
  };
}



export function reviewLegacyPaperCapital(existing, {
  action,
  confirmed,
  tradeCount,
  openPositions
} = {}) {
  if (action !== "keep_existing_capital") {
    return { ok: false, reason: "capital_review_action_invalid" };
  }
  if (confirmed !== true) {
    return { ok: false, reason: "capital_review_confirmation_required" };
  }
  if (!existing || typeof existing !== "object" ||
      Array.isArray(existing) || existing.capital_setup_required !== true) {
    return { ok: false, reason: "capital_review_not_required" };
  }
  const initialCapital = Number(existing.initial_capital_usd);
  if (!Number.isFinite(initialCapital) || initialCapital <= 0) {
    return { ok: false, reason: "capital_review_existing_balance_invalid" };
  }
  if (!Number.isSafeInteger(tradeCount) || tradeCount < 1) {
    return { ok: false, reason: "capital_review_history_required" };
  }
  if (!Number.isSafeInteger(openPositions) || openPositions < 0) {
    return { ok: false, reason: "capital_review_ledger_state_unavailable" };
  }
  if (openPositions > 0) {
    return { ok: false, reason: "capital_review_open_positions_must_be_closed" };
  }

  const peak = Number(existing.peak_equity_usd);
  const settings = {
    ...existing,
    initial_capital_usd: initialCapital,
    peak_equity_usd: Number.isFinite(peak) && peak > 0
      ? Math.max(initialCapital, peak) : initialCapital,
    risk: { ...PAPER_AUTOMATION_RISK },
    auto_paper_enabled: false,
    auto_paper_resume_after_watchdog: false,
    paper_automation_profile_version: PAPER_AUTOMATION_PROFILE.version,
    capital_setup_required: false
  };
  delete settings.capital_setup_required_reason;
  return { ok: true, settings };
}

export function shouldResumePaperAutomationAfterWatchdog({
  resumeAllowed,
  capitalSetupRequired
}) {
  return resumeAllowed === true && capitalSetupRequired !== true;
}

export function calculateDynamicTakeProfit({ atrPct, roundTripCostBps }) {
  const atr = Number(atrPct);
  const costs = Number(roundTripCostBps);
  if (!Number.isFinite(atr) || atr <= 0 || !Number.isFinite(costs) || costs <= 0) {
    return { ok: false, reason: "dynamic_target_inputs_invalid" };
  }
  // Target the greater of 1.5x estimated round-trip costs, 0.8x 1H ATR,
  // or a 1% gross move. Reject exceptionally expensive/volatile setups.
  const targetBps = Math.max(costs * 1.5, atr * 80, 100);
  if (!Number.isFinite(targetBps) || targetBps <= costs || targetBps > 500) {
    return { ok: false, reason: "dynamic_target_outside_safe_bounds" };
  }
  return {
    ok: true,
    target_pct: Number((targetBps / 100).toFixed(4)),
    target_bps: Number(targetBps.toFixed(2)),
    estimated_net_edge_bps: Number((targetBps - costs).toFixed(2))
  };
}

export function getDailyCycleAllowance(completedCyclesToday, limit = PAPER_AUTOMATION_PROFILE.max_cycles_per_day) {
  const safeLimit = Number.isSafeInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : 0;
  const validCount = Number.isSafeInteger(Number(completedCyclesToday)) && Number(completedCyclesToday) >= 0;
  // Unknown ledger counts must never be interpreted as zero available cycles.
  const used = validCount ? Number(completedCyclesToday) : safeLimit;
  return {
    limit: safeLimit,
    used,
    remaining: Math.max(0, safeLimit - used),
    allowed: safeLimit > 0 && validCount && used < safeLimit
  };
}

export function countCompletedPaperCyclesInWindow(sql, startMs, endMs) {
  if (!sql || typeof sql.exec !== "function" ||
      !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error("paper_cycle_count_window_invalid");
  }
  const rows = sql.exec(
    "SELECT COUNT(*) AS count FROM trades WHERE status='CLOSED' AND closed_at_ms>=? AND closed_at_ms<?",
    startMs,
    endMs
  ).toArray();
  const count = Number(rows[0]?.count);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("paper_cycle_count_unavailable");
  }
  return count;
}

export function shouldAutoResumeWatchdog({ halted, haltReason, healthyScheduledScanStreak }) {
  return halted === true &&
    haltReason === "market_data_watchdog" &&
    Number.isSafeInteger(Number(healthyScheduledScanStreak)) &&
    Number(healthyScheduledScanStreak) >= 2;
}
