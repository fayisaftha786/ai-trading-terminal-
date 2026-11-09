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
    } else if (declaredProviders.some((provider) => provider !== selectedProvider)) {
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
  const activationPct = Math.max(2, (costPct * 2) + 0.75);
  const distancePct = Math.max(0.9, costPct + 0.35);
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

/**
 * Build a bounded, sanitized view of the selected provider and its freshness
 * evidence from the actual persisted market snapshots, not a stale runtime copy.
 * Negative ages are kept visible so future timestamps cannot masquerade as fresh.
 */
export function buildMarketDataProviderDiagnostics(markets, nowMs = Date.now(), limit = 3) {
  const rows = Array.isArray(markets) ? markets : [];
  const safeLimit = Number.isSafeInteger(limit) ? Math.max(0, Math.min(3, limit)) : 3;
  if (!Number.isFinite(nowMs) || nowMs <= 0) return [];

  return rows.slice(0, safeLimit).map((market) => {
    const quality = market?.data_quality || {};
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
      market_candidate_eligible: market?.entry_gate?.eligible === true
    };
  });
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
