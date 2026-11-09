const VALID_MODES = new Set(["demo", "real"]);
const ACTIVE_LIVE_ORDER_STATES = new Set([
  "SUBMITTING", "UNKNOWN", "PENDING", "OPEN", "QUEUED",
  "PARTIALLY_FILLED", "CANCEL_QUEUED"
]);

export function normalizeTradingMode(value) {
  return VALID_MODES.has(value) ? value : "demo";
}

/**
 * Select a dashboard execution mode without ever enabling order execution.
 * Switching modes always turns off paper auto-entry; the owner must opt in
 * again after returning to DEMO. REAL remains connection/preflight-only.
 */
export function selectTradingMode(settings, requestedMode, {
  openPaperPositions = 0,
  liveOrders = []
} = {}) {
  if (!VALID_MODES.has(requestedMode)) {
    return { ok: false, reason: "trading_mode_invalid" };
  }
  const current = settings && typeof settings === "object" && !Array.isArray(settings)
    ? settings : {};
  const currentMode = normalizeTradingMode(current.trading_mode);
  const activeLiveOrders = Array.isArray(liveOrders)
    ? liveOrders.filter((order) => ACTIVE_LIVE_ORDER_STATES.has(String(order?.status || "").toUpperCase()))
    : [];

  if (requestedMode === currentMode) {
    const unchanged = { ...current, trading_mode: currentMode };
    if (requestedMode === "real") {
      unchanged.auto_paper_enabled = false;
      unchanged.auto_paper_resume_after_watchdog = false;
    }
    return { ok: true, changed: false, settings: unchanged };
  }
  if (Number(openPaperPositions) > 0) {
    return { ok: false, reason: "close_open_paper_positions_before_switching_mode" };
  }
  if (activeLiveOrders.length > 0) {
    return { ok: false, reason: "reconcile_active_live_orders_before_switching_mode" };
  }

  return {
    ok: true,
    changed: true,
    settings: {
      ...current,
      trading_mode: requestedMode,
      auto_paper_enabled: false,
      auto_paper_resume_after_watchdog: false
    }
  };
}
