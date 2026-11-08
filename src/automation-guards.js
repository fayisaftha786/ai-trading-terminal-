export function assessMarketUniverse(markets, expectedSymbols, nowMs = Date.now(), maxQuoteAgeMs = 120000) {
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
    if (market.status !== "live") marketIssues.push("provider_unavailable");

    const quoteTime = Date.parse(market.ticker_time || "");
    const quoteAge = nowMs - quoteTime;
    if (!Number.isFinite(quoteTime) || quoteAge < -5000 || quoteAge > maxQuoteAgeMs) {
      marketIssues.push("ticker_stale_or_timestamp_invalid");
    }
    if (![market.bid, market.ask, market.last].every((value) => Number.isFinite(value) && value > 0) ||
        market.ask < market.bid) {
      marketIssues.push("invalid_or_crossed_quote");
    }

    for (const [timeframe, audit] of [
      ["1h", market.one_hour_audit_summary],
      ["6h", market.six_hour_audit_summary]
    ]) {
      const validBars = Number(audit?.valid_closed_bars);
      if (audit?.ok !== true || !Number.isFinite(validBars) || validBars < 150) {
        const details = Array.isArray(audit?.issues) && audit.issues.length
          ? ":" + audit.issues.slice(0, 2).join(",")
          : "";
        marketIssues.push(timeframe + "_candle_integrity_failed" + details);
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
