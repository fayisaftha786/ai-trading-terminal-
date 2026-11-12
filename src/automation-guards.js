import { isFreshQuoteObservation, isFreshTickerEvent } from "./strategy.js";

export function assessMarketUniverse(
  markets,
  expectedSymbols,
  nowMs = Date.now(),
  maxQuoteAgeMs = 120000,
  maxOrderBookAgeMs = 15000,
  minimumOrderBookDepthQuote = 5000
) {
  const rows = Array.isArray(markets) ? markets : [];
  const expected = Array.isArray(expectedSymbols) ? expectedSymbols : [];
  const bySymbol = new Map(rows.map((market) => [market?.symbol, market]));
  const issues = [];
  let healthyMarkets = 0;

  if (rows.length !== expected.length) {
    issues.push({
      symbol: null,
      reason: rows.length < expected.length ? "market_universe_incomplete" : "unexpected_market_count"
    });
  }

  for (const symbol of expected) {
    const market = bySymbol.get(symbol);
    const marketIssues = [];
    if (!market) {
      issues.push({ symbol, reason: "market_snapshot_missing" });
      continue;
    }
    if (market.status !== "live") {
      const providerReason = typeof market.error_code === "string" &&
        /^[a-z0-9_]{1,80}$/.test(market.error_code)
        ? "provider_unavailable:" + market.error_code
        : "provider_unavailable";
      issues.push({ symbol, reason: providerReason });
      continue;
    }

    const selectedProvider = market.market_data_provider;
    const quality = market.data_quality || {};
    const declaredProviders = [
      quality.ticker_provider,
      quality.book_provider,
      quality.one_hour_provider,
      quality.six_hour_provider
    ];
    if (typeof selectedProvider !== "string" || !selectedProvider) {
      marketIssues.push("market_data_provider_missing");
    } else if (!["coinbase_exchange", "bitstamp_spot"].includes(selectedProvider)) {
      marketIssues.push("market_data_provider_unsupported");
    } else if (selectedProvider !== "coinbase_exchange") {
      // Bitstamp remains available only to mark/exit an already-open legacy
      // PAPER position. It must never make the complete new-entry universe
      // look healthy, enable automation, or count as scheduled-scan success.
      marketIssues.push("coinbase_market_data_required_for_new_entry_universe");
    }
    if (typeof selectedProvider === "string" && selectedProvider &&
        declaredProviders.some((provider) => provider !== selectedProvider)) {
      marketIssues.push("market_data_provider_mismatch");
    }

    if (!isFreshQuoteObservation(market, nowMs, maxQuoteAgeMs) ||
        !isFreshTickerEvent(market, nowMs, maxQuoteAgeMs)) {
      marketIssues.push("ticker_stale_or_timestamp_invalid");
    }
    if (![market.bid, market.ask, market.last].every((value) => Number.isFinite(value) && value > 0) ||
        market.ask < market.bid) {
      marketIssues.push("invalid_or_crossed_quote");
    }

    const bookRetrievedAtMs = Number(market.book_retrieved_at_ms);
    const bookAgeMs = nowMs - bookRetrievedAtMs;
    if (!Number.isFinite(bookRetrievedAtMs) || bookAgeMs < -1000 || bookAgeMs > maxOrderBookAgeMs) {
      marketIssues.push("orderbook_snapshot_stale_or_missing");
    }
    if (selectedProvider === "bitstamp_spot") {
      const bookEventTimeMs = Number(market.book_event_time_ms);
      const bookEventAgeMs = nowMs - bookEventTimeMs;
      if (!Number.isFinite(bookEventTimeMs) || bookEventAgeMs < -1000 || bookEventAgeMs > maxOrderBookAgeMs) {
        marketIssues.push("orderbook_exchange_timestamp_stale_or_missing");
      }
    }
    const bidDepthQuote = Number(market.bid_depth_quote);
    const askDepthQuote = Number(market.ask_depth_quote);
    if (![bidDepthQuote, askDepthQuote].every(Number.isFinite) ||
        Math.min(bidDepthQuote, askDepthQuote) < minimumOrderBookDepthQuote) {
      marketIssues.push("orderbook_depth_unavailable_or_low");
    }

    for (const [timeframe, intervalMs, maxClosedAgeMs, audit] of [
      ["1h", 3600000, 5400000, market.one_hour_audit_summary],
      ["6h", 21600000, 25200000, market.six_hour_audit_summary]
    ]) {
      const validBars = Number(audit?.valid_closed_bars);
      if (audit?.ok !== true || !Number.isFinite(validBars) || validBars < 150) {
        const details = Array.isArray(audit?.issues) && audit.issues.length
          ? ":" + audit.issues.slice(0, 2).join(",")
          : "";
        marketIssues.push(timeframe + "_candle_integrity_failed" + details);
      }

      const lastOpenMs = Number(audit?.last_closed_candle_ms);
      if (!Number.isFinite(lastOpenMs) || lastOpenMs <= 0) {
        marketIssues.push(timeframe + "_latest_closed_candle_missing");
      } else {
        const closedAtMs = lastOpenMs + intervalMs;
        const closedAgeMs = nowMs - closedAtMs;
        if (closedAgeMs < -1000) {
          marketIssues.push(timeframe + "_latest_closed_candle_from_future");
        } else if (closedAgeMs > maxClosedAgeMs) {
          marketIssues.push(timeframe + "_latest_closed_candle_stale");
        }
      }
    }

    if (marketIssues.length) {
      issues.push({ symbol, reason: marketIssues.join(",") });
    } else {
      healthyMarkets += 1;
    }
  }

  return {
    healthy: issues.length === 0 && healthyMarkets === expected.length,
    healthy_market_count: healthyMarkets,
    expected_market_count: expected.length,
    issues
  };
}

export function hasRecentHealthyScheduledScan({
  status,
  scanAtMs,
  healthyMarketCount,
  expectedMarketCount,
  nowMs = Date.now(),
  maxAgeMs = 3 * 90 * 1000
}) {
  const scanAt = Number(scanAtMs);
  const healthy = Number(healthyMarketCount);
  const expected = Number(expectedMarketCount);
  return status === "completed" &&
    Number.isFinite(nowMs) &&
    Number.isFinite(scanAt) && scanAt > 0 && scanAt <= nowMs + 5000 &&
    nowMs - scanAt <= maxAgeMs &&
    Number.isSafeInteger(healthy) && Number.isSafeInteger(expected) &&
    expected > 0 && healthy === expected;
}

export function advanceUnhealthyScanStreak(previousCount, source, marketFeedHealthy) {
  const previous = Number.isSafeInteger(previousCount) && previousCount > 0 ? previousCount : 0;
  if (source !== "scheduled") return previous;
  return marketFeedHealthy ? 0 : previous + 1;
}

export function shouldHaltPaperAutomation({
  autoEnabled,
  halted,
  consecutiveUnhealthyScans,
  lastHealthyScanAtMs,
  nowMs = Date.now(),
  staleAfterMs = 45 * 60 * 1000,
  failureThreshold = 3
}) {
  if (!autoEnabled || halted) return { halt: false, reason: null };

  const lastHealthy = Number(lastHealthyScanAtMs);
  const lastHealthyIsValid = Number.isFinite(lastHealthy) && lastHealthy > 0 && lastHealthy <= nowMs + 5000;
  const staleHealthyFeed = lastHealthyIsValid && (nowMs - lastHealthy) > staleAfterMs;
  if (staleHealthyFeed) {
    return { halt: true, reason: "scheduler_stale_since_last_healthy_scan" };
  }

  if (Number(consecutiveUnhealthyScans) >= failureThreshold) {
    return { halt: true, reason: "consecutive_market_data_failures" };
  }
  return { halt: false, reason: null };
}


/**
 * The short alarm cadence refreshes only L2 books. Full strategy/candle scans
 * remain on their own bounded interval, independent of book-refresh alarms.
 */
export function shouldRunScheduledMarketScan(
  lastScheduledScanAtMs,
  nowMs = Date.now(),
  intervalMs = 90_000
) {
  const last = Number(lastScheduledScanAtMs);
  if (!Number.isFinite(nowMs) || nowMs <= 0 ||
      !Number.isFinite(intervalMs) || intervalMs <= 0) return true;
  if (!Number.isFinite(last) || last <= 0 || last > nowMs + 5000) return true;
  return nowMs - last >= intervalMs;
}

export function deriveSchedulerStatus({
  lastScheduledAlarmAtMs,
  lastScheduledScanStatus,
  nowMs = Date.now(),
  staleAfterMs = 45 * 60 * 1000
}) {
  const lastAlarm = Number(lastScheduledAlarmAtMs);
  if (!Number.isFinite(lastAlarm) || lastAlarm <= 0 || lastAlarm > nowMs + 5000) {
    return { status: "starting", ageMs: null };
  }

  const ageMs = Math.max(0, nowMs - lastAlarm);
  if (ageMs > staleAfterMs) return { status: "stale", ageMs };

  const statuses = {
    running: "running",
    completed: "healthy",
    partial: "partial",
    unavailable: "unavailable",
    error: "error"
  };
  return { status: statuses[lastScheduledScanStatus] || "unknown", ageMs };
}


/**
 * Pause new paper entries after a short run of consecutive realised losses.
 * The latest closed trade must be first in the supplied array.
 */
export function assessLossCooldown(recentClosedTrades, nowMs = Date.now()) {
  const rows = Array.isArray(recentClosedTrades) ? recentClosedTrades.slice(0, 3) : [];
  let lossStreak = 0;
  for (const row of rows) {
    const pnl = Number(row?.pnl_usd);
    if (!Number.isFinite(pnl)) {
      return { blocked: true, lossStreak, remainingMs: null, reason: "recent_trade_result_invalid" };
    }
    if (pnl < 0) lossStreak += 1;
    else break;
  }
  if (lossStreak < 2) {
    return { blocked: false, lossStreak, remainingMs: 0, reason: null };
  }
  const lastClosedAt = Number(rows[0]?.closed_at_ms);
  if (!Number.isFinite(lastClosedAt) || lastClosedAt <= 0 ||
      !Number.isFinite(nowMs) || lastClosedAt > nowMs + 5000) {
    return { blocked: true, lossStreak, remainingMs: null, reason: "loss_cooldown_timestamp_invalid" };
  }
  const cooldownMs = lossStreak >= 3 ? 12 * 60 * 60 * 1000 : 4 * 60 * 60 * 1000;
  const remainingMs = Math.max(0, cooldownMs - Math.max(0, nowMs - lastClosedAt));
  return {
    blocked: remainingMs > 0,
    lossStreak,
    remainingMs,
    reason: remainingMs > 0
      ? (lossStreak >= 3 ? "three_loss_cooldown_12h" : "two_loss_cooldown_4h")
      : null
  };
}

/**
 * Reduce PAPER risk as drawdown or recent losses increase; never increase
 * above the configured base risk. At 4% drawdown, block new entries early.
 */
export function assessAdaptiveRisk({ drawdownPct, lossStreak = 0 }) {
  if (!Number.isFinite(drawdownPct) || drawdownPct < 0) {
    return { allowed: false, multiplier: 0, reason: "drawdown_unavailable" };
  }
  if (drawdownPct >= 4) {
    return { allowed: false, multiplier: 0, reason: "preemptive_drawdown_pause" };
  }
  let multiplier = drawdownPct >= 3 ? 0.25
    : drawdownPct >= 2 ? 0.5
      : drawdownPct >= 1 ? 0.75 : 1;
  const losses = Number.isSafeInteger(lossStreak) && lossStreak > 0 ? lossStreak : 0;
  if (losses >= 3) multiplier = Math.min(multiplier, 0.25);
  else if (losses >= 2) multiplier = Math.min(multiplier, 0.5);
  return {
    allowed: true,
    multiplier,
    reason: multiplier < 1 ? "adaptive_risk_reduced" : null
  };
}

/**
 * Cost-aware long trailing stop. The stop can only move upward, never loosen.
 * It is intentionally a simulated PAPER exit rule, not an exchange-native stop.
 */
export function updateTrailingStop({
  entryPrice,
  currentStop,
  previousHighWater,
  currentBid,
  roundTripCostBps = 0
}) {
  if (![entryPrice, currentStop, currentBid, roundTripCostBps].every(Number.isFinite) ||
      entryPrice <= 0 || currentStop <= 0 || currentBid <= 0 || roundTripCostBps < 0) {
    return { ok: false, reason: "trailing_stop_inputs_invalid" };
  }
  const previousHigh = Number.isFinite(previousHighWater) && previousHighWater > 0
    ? previousHighWater : entryPrice;
  const highWaterBid = Math.max(entryPrice, previousHigh, currentBid);
  const costPct = roundTripCostBps / 100;
  // Align activation with the cost-aware take-profit model. Under the former
  // 2x-cost activation rule, the trailing stop often activated after the
  // dynamic take-profit had already closed the position (e.g. 165 bps costs:
  // 4.05% activation vs ~2.48% target). The new stop activates early enough
  // to lock a small positive net buffer before the target, without loosening.
  const distancePct = Math.max(0.25, Math.min(0.6, costPct * 0.25));
  const activationPct = costPct + distancePct + 0.2;
  const active = highWaterBid >= entryPrice * (1 + activationPct / 100);
  const candidateStop = active ? highWaterBid * (1 - distancePct / 100) : currentStop;
  const stopLoss = Math.max(currentStop, candidateStop);
  const changed = highWaterBid > previousHigh + 1e-10 || stopLoss > currentStop + 1e-10;
  return {
    ok: true,
    active,
    changed,
    highWaterBid,
    stopLoss,
    activationPct,
    distancePct
  };
}


/**
 * Recover a compact, deduplicated list of per-market issue codes from the
 * persisted human-readable error string. This keeps the health API useful when
 * an older Durable Object runtime contains summary text but no issue array.
 */
export function parseScanIssueSummaries(...summaries) {
  const parsed = [];
  const seen = new Set();
  for (const summary of summaries) {
    if (typeof summary !== "string" || !summary.trim()) continue;
    for (const part of summary.split(";")) {
      const value = part.trim();
      const separator = value.indexOf(":");
      if (separator <= 0) continue;
      const symbol = value.slice(0, separator).trim();
      const reason = value.slice(separator + 1).trim();
      if (!symbol || !reason) continue;
      const key = symbol + "|" + reason;
      if (seen.has(key)) continue;
      seen.add(key);
      parsed.push({ symbol, reason });
    }
  }
  return parsed;
}

export function normalizeScanIssueRows(runtime = {}) {
  const stored = Array.isArray(runtime.market_feed_issues)
    ? runtime.market_feed_issues.filter((issue) =>
        issue && typeof issue.reason === "string"
      ).slice(0, 12)
    : [];
  if (stored.length) return stored;
  return parseScanIssueSummaries(
    runtime.last_scan_error,
    runtime.last_scheduled_scan_error
  ).slice(0, 12);
}

export function normalizeProviderFailureRows(runtime = {}, issues = []) {
  const stored = Array.isArray(runtime.provider_failures)
    ? runtime.provider_failures.filter((failure) =>
        failure && typeof failure.symbol === "string" && typeof failure.reason === "string"
      ).slice(0, 3)
    : [];
  if (stored.length) return stored;

  return issues.filter((issue) => /provider_unavailable/.test(issue.reason || ""))
    .slice(0, 3)
    .map((issue) => ({
      symbol: issue.symbol,
      reason: String(issue.reason).slice(0, 120),
      primary_error_code: null,
      backup_error_code: null,
      inferred_from_scan_summary: true
    }));
}


function safeProviderDiagnosticCode(value) {
  return typeof value === "string" && /^[a-z0-9_]{1,80}$/.test(value) ? value : null;
}

function diagnosticAge(timestamp, nowMs) {
  const value = Number(timestamp);
  return Number.isFinite(value) && value > 0 ? nowMs - value : null;
}

function diagnosticClosedAge(lastOpenMs, intervalMs, nowMs) {
  const value = Number(lastOpenMs);
  return Number.isFinite(value) && value > 0 ? nowMs - (value + intervalMs) : null;
}

function diagnosticNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(4)) : null;
}

/**
 * Build a bounded, sanitized view of the selected provider, freshness evidence
 * and exact per-market entry gate from the actual persisted market snapshots.
 * Negative ages remain visible so future timestamps cannot masquerade as fresh.
 */
export function buildMarketDataProviderDiagnostics(markets, nowMs = Date.now(), limit = 3) {
  const rows = Array.isArray(markets) ? markets : [];
  const safeLimit = Number.isSafeInteger(limit) ? Math.max(0, Math.min(3, limit)) : 3;
  if (!Number.isFinite(nowMs) || nowMs <= 0) return [];

  return rows.slice(0, safeLimit).map((market) => {
    const quality = market?.data_quality || {};
    const entryGate = market?.entry_gate || {};
    const marketContext = market?.market_context || {};
    const primary = market?.primary || {};
    const higher = market?.higher || {};
    const entryGateReason = typeof entryGate.reason === "string"
      ? safeProviderDiagnosticCode(entryGate.reason) || "unrecognized"
      : "not_evaluated";
    const code = (value) => safeProviderDiagnosticCode(
      typeof value === "string" ? value.toLowerCase() : value
    );
    return {
      symbol: typeof market?.symbol === "string" ? market.symbol.slice(0, 24) : null,
      status: market?.status === "live" ? "live" : "error",
      provider: safeProviderDiagnosticCode(market?.market_data_provider),
      failover_used: quality.failover_used === true,
      failover_attempted: quality.failover_attempted === true,
      failover_reason: safeProviderDiagnosticCode(quality.failover_reason),
      failover_error: safeProviderDiagnosticCode(quality.failover_error),
      primary_provider_error: safeProviderDiagnosticCode(quality.primary_provider_error),
      quote_age_ms: diagnosticAge(market?.quote_received_at_ms, nowMs),
      ticker_event_age_ms: diagnosticAge(Date.parse(market?.ticker_time || ""), nowMs),
      book_age_ms: diagnosticAge(market?.book_retrieved_at_ms, nowMs),
      book_event_age_ms: diagnosticAge(market?.book_event_time_ms, nowMs),
      bid_depth_quote: diagnosticNumber(market?.bid_depth_quote),
      ask_depth_quote: diagnosticNumber(market?.ask_depth_quote),
      minimum_depth_quote_per_side: 5000,
      depth_levels: 50,
      book_status: safeProviderDiagnosticCode(quality.book_status) || "unknown",
      book_error: safeProviderDiagnosticCode(quality.book_error),
      one_hour_refresh_status: safeProviderDiagnosticCode(quality.one_hour_refresh_status),
      one_hour_refresh_error: safeProviderDiagnosticCode(quality.one_hour_refresh_error),
      one_hour_closed_age_ms: diagnosticClosedAge(
        market?.one_hour_audit_summary?.last_closed_candle_ms, 3600000, nowMs
      ),
      six_hour_refresh_status: safeProviderDiagnosticCode(quality.six_hour_refresh_status),
      six_hour_refresh_error: safeProviderDiagnosticCode(quality.six_hour_refresh_error),
      six_hour_closed_age_ms: diagnosticClosedAge(
        market?.six_hour_audit_summary?.last_closed_candle_ms, 21600000, nowMs
      ),
      market_candidate_eligible: entryGate.eligible === true,
      entry_gate_reason: entryGate.eligible === true ? "eligible" : entryGateReason,
      market_context_status: code(marketContext.status),
      market_context_mode: code(marketContext.mode),
      market_context_reason: code(marketContext.reason),
      primary_signal: code(primary.signal),
      primary_score: diagnosticNumber(primary.score),
      primary_regime: code(primary.regime),
      higher_regime: code(higher.regime),
      primary_rsi14: diagnosticNumber(primary.rsi14),
      primary_atr_pct: diagnosticNumber(primary.atr_pct),
      primary_adx14: diagnosticNumber(primary.adx14),
      spread_bps: diagnosticNumber(market?.spread_bps),
      entry_spread_bps: diagnosticNumber(entryGate.spread_bps),
      entry_round_trip_cost_bps: diagnosticNumber(entryGate.round_trip_cost_bps)
    };
  });
}

/**
 * Publish the actual per-side L2 quote depth separately from the broader
 * provider diagnostic row. This makes the market-universe liquidity veto
 * observable without exposing raw order-book levels or changing any gate.
 */
export function buildMarketBookDepthDiagnostics(markets, limit = 3) {
  const rows = Array.isArray(markets) ? markets : [];
  const safeLimit = Number.isSafeInteger(limit) ? Math.max(0, Math.min(3, limit)) : 3;
  return rows.slice(0, safeLimit).map((market) => ({
    symbol: typeof market?.symbol === "string" ? market.symbol.slice(0, 24) : null,
    bid_depth_quote: diagnosticNumber(market?.bid_depth_quote),
    ask_depth_quote: diagnosticNumber(market?.ask_depth_quote),
    minimum_depth_quote_per_side: 5000,
    depth_levels: 50
  }));
}

/** Return only actionable selected-provider failures from the current snapshots. */
export function summarizeCurrentProviderFailures(markets) {
  const rows = Array.isArray(markets) ? markets : [];
  return rows.flatMap((market) => {
    const quality = market?.data_quality || {};
    const failures = [];
    if (market?.status !== "live") {
      failures.push({
        symbol: market?.symbol || null,
        reason: safeProviderDiagnosticCode(market?.error_code) || "provider_unavailable",
        primary_error_code: safeProviderDiagnosticCode(market?.primary_error_code),
        backup_error_code: safeProviderDiagnosticCode(market?.backup_error_code)
      });
    }
    if (quality.book_status === "provider_error" || quality.book_status === "invalid_or_missing") {
      failures.push({
        symbol: market?.symbol || null,
        reason: safeProviderDiagnosticCode(quality.book_error) || "orderbook_unavailable"
      });
    }
    if (quality.one_hour_refresh_error && market?.one_hour_audit_summary?.ok !== true) {
      failures.push({
        symbol: market?.symbol || null,
        reason: safeProviderDiagnosticCode(quality.one_hour_refresh_error) || "one_hour_candle_provider_error"
      });
    }
    if (quality.six_hour_refresh_error && market?.six_hour_audit_summary?.ok !== true) {
      failures.push({
        symbol: market?.symbol || null,
        reason: safeProviderDiagnosticCode(quality.six_hour_refresh_error) || "six_hour_candle_provider_error"
      });
    }
    return failures;
  }).slice(0, 6);
}


/**
 * Do not let a scheduled alarm reuse an in-flight manual scan as its own
 * scheduled result. Wait for all currently active scans, then synchronously
 * start the scheduled scan through the provided callback.
 */
export async function runAfterActiveScan(getActiveScan, startScheduledScan) {
  if (typeof getActiveScan !== "function" || typeof startScheduledScan !== "function") {
    throw new TypeError("scan callbacks are required");
  }
  while (true) {
    const activeScan = getActiveScan();
    if (!activeScan) return startScheduledScan();
    try {
      await activeScan;
    } catch {
      // The scheduled scan must still run after a failed manual scan.
    }
  }
}


/**
 * Manual scans update current market diagnostics but must never erase scheduler-owned
 * heartbeat, completion, or watchdog state. Scheduled scans may update their own state.
 */
export function mergeScanRuntimeState(previousRuntime, nextRuntime, source) {
  const previous = previousRuntime && typeof previousRuntime === "object" ? previousRuntime : {};
  const next = nextRuntime && typeof nextRuntime === "object" ? nextRuntime : {};
  const merged = { ...previous, ...next };
  if (source !== "scheduled") {
    const schedulerFields = [
      "last_scheduled_alarm_at_ms",
      "last_scheduled_scan_status",
      "last_scheduled_scan_error",
      "last_scheduled_scan_at_ms",
      "last_scheduled_scan_healthy_market_count",
      "last_scheduled_scan_expected_market_count",
      "last_scheduled_scan_issues",
      "last_healthy_scheduled_scan_at_ms",
      "healthy_scheduled_scan_streak",
      "consecutive_unhealthy_scheduled_scans"
    ];
    for (const field of schedulerFields) {
      if (Object.prototype.hasOwnProperty.call(previous, field)) merged[field] = previous[field];
      else delete merged[field];
    }
  }
  return merged;
}


/**
 * Explain whether a stale current snapshot reflects a provider failure or the
 * normal expiry of a previously healthy scan. This is diagnostic only: it
 * never changes market eligibility or relaxes any entry freshness gate.
 */
export function classifyMarketFeedFreshness({
  currentFeedHealthy,
  lastScheduledScanStatus,
  lastScheduledHealthyMarketCount,
  lastScheduledExpectedMarketCount,
  lastScheduledScanAgeMs,
  staleAfterMs
} = {}) {
  const expected = Number.isSafeInteger(Number(lastScheduledExpectedMarketCount)) &&
    Number(lastScheduledExpectedMarketCount) > 0
    ? Number(lastScheduledExpectedMarketCount) : 0;
  const healthy = Number.isSafeInteger(Number(lastScheduledHealthyMarketCount)) &&
    Number(lastScheduledHealthyMarketCount) >= 0
    ? Number(lastScheduledHealthyMarketCount) : 0;
  const age = lastScheduledScanAgeMs === null || lastScheduledScanAgeMs === undefined
    ? Number.NaN : Number(lastScheduledScanAgeMs);
  const maxAge = staleAfterMs === null || staleAfterMs === undefined
    ? Number.NaN : Number(staleAfterMs);
  const recent = Number.isFinite(age) && age >= 0 &&
    Number.isFinite(maxAge) && maxAge > 0 && age <= maxAge;

  if (currentFeedHealthy === true) {
    return { state: "fresh", reason: "current_market_snapshots_pass_all_entry_data_gates" };
  }
  if (lastScheduledScanStatus === "running") {
    return { state: "refresh_in_progress", reason: "scheduled_market_refresh_is_running" };
  }
  if (lastScheduledScanStatus === "completed" &&
      expected > 0 && healthy === expected && recent) {
    return {
      state: "snapshot_expired_after_healthy_scan",
      reason: "last_scheduled_scan_was_healthy_but_persisted_order_book_snapshots_have_expired"
    };
  }
  if (lastScheduledScanStatus === "completed" && expected > 0 && healthy === expected &&
      Number.isFinite(age) && Number.isFinite(maxAge) && age > maxAge) {
    return { state: "scheduled_scan_overdue", reason: "last_healthy_scan_is_older_than_scheduler_health_window" };
  }
  if (lastScheduledScanStatus === "partial" || lastScheduledScanStatus === "unavailable" ||
      lastScheduledScanStatus === "error") {
    return { state: "last_scan_degraded", reason: "last_scheduled_scan_did_not_validate_the_full_market_universe" };
  }
  return { state: "not_yet_verified", reason: "no_recent_complete_healthy_market_scan_is_available" };
}
