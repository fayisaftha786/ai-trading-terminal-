const DEFAULT_SCAN_INTERVAL_MS = 90_000;

const DEFINITIONS = Object.freeze([
  ["market_feed", "Market data integrity", "MARKET DATA", "Checks Coinbase ticker, order-book depth and closed-candle integrity."],
  ["market_regime", "BTC-led market regime", "MARKET CONTEXT", "Reads the BTC anchor and cross-market breadth classification."],
  ["trend", "Trend structure", "TECHNICAL", "Compares 1H and 6H directional structure and EMA slope."],
  ["reversal_watch", "Reversal watch", "TECHNICAL", "Observes RSI and directional-pressure changes; never creates or authorizes an entry."],
  ["momentum", "Momentum quality", "TECHNICAL", "Inspects RSI, ADX and directional movement without inventing probabilities."],
  ["volume", "Volume confirmation", "TECHNICAL", "Compares closed-bar volume against its historical baseline."],
  ["breakout", "Breakout monitor", "STRATEGY", "Checks validated 20-bar breakout and volume-expansion hypotheses."],
  ["mean_reversion", "Mean-reversion research", "STRATEGY", "Tracks the range mean-reversion hypothesis as research only."],
  ["microstructure", "Order-book microstructure", "EXECUTION QUALITY", "Checks spread, visible depth and order-book freshness."],
  ["multi_timeframe", "Multi-timeframe alignment", "CONFIRMATION", "Compares the current closed 1H and 6H regimes."],
  ["strategy_research", "Strategy research quality", "RESEARCH", "Reports available research candidates without claiming a backtest was run."],
  ["risk_guardian", "Risk Guardian", "RISK", "Applies an independent safety veto; it can never authorize an order."],
  ["system_watchdog", "Scheduler watchdog", "RELIABILITY", "Reports server-side scheduler heartbeat and the last scan state."]
]);

const safeNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const compact = (value, max = 120) => String(value ?? "").replace(/[\r\n\t]+/g, " ").slice(0, max);
const liveMarkets = (markets) => (Array.isArray(markets) ? markets : [])
  .filter((market) => market && market.status === "live" && market.market_data_provider === "coinbase_exchange");
const statusForCoverage = (ready, total) => ready === 0 ? "blocked" : ready < total ? "partial" : "complete";

function makeWorker(id, status, summary, findings = [], metrics = {}, extra = {}) {
  const definition = DEFINITIONS.find((item) => item[0] === id);
  return {
    id,
    name: definition?.[1] || id,
    group: definition?.[2] || "SYSTEM",
    description: definition?.[3] || "",
    status,
    summary: compact(summary, 220),
    findings: (Array.isArray(findings) ? findings : []).slice(0, 4).map((item) => compact(item, 160)),
    metrics,
    last_run_at_ms: extra.lastRunAtMs ?? null,
    execution_authorized: false,
    ...extra.fields
  };
}

function asSummary(rows, selector, empty = "No verified market data is available.") {
  const values = rows.map(selector).filter((value) => value !== null && value !== undefined && value !== "");
  return values.length ? values.slice(0, 3).join(" · ") : empty;
}

export function evaluateAiWorkforceRiskVeto({
  marketFeed = {},
  marketContext = {},
  portfolio = {},
  settings = {},
  paperMode = false
} = {}) {
  const checks = {
    complete_market_universe: marketFeed.healthy === true,
    market_context_allows_long_entries: marketContext.allowed_for_long_entries === true,
    owner_stop_not_active: settings.halted !== true,
    portfolio_fully_marked: safeNumber(portfolio.unmarked_positions) === 0,
    paper_only_mode: paperMode === true
  };
  const vetoReasons = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  return { veto: vetoReasons.length > 0, vetoReasons, checks };
}

function candidateFor(market, id) {
  const candidates = market?.strategy_research?.candidates;
  return Array.isArray(candidates)
    ? candidates.find((candidate) => candidate?.strategy_id === id) || null
    : null;
}

export function buildAiWorkforceRun({
  markets = [],
  marketFeed = {},
  marketContext = {},
  portfolio = {},
  settings = {},
  runtime = {},
  entryStatus = "not_evaluated",
  source = "scheduled",
  nowMs = Date.now(),
  startedAtMs = nowMs,
  paperMode = false,
  riskGuardianDecision = null
} = {}) {
  const rows = Array.isArray(markets) ? markets : [];
  const live = liveMarkets(rows);
  const workers = [];

  const feedReady = marketFeed.healthy === true;
  const feedStatus = feedReady ? "complete" : live.length ? "partial" : "unavailable";
  workers.push(makeWorker(
    "market_feed",
    feedStatus,
    feedReady
      ? "All configured Coinbase markets passed the market-universe gate."
      : "The complete Coinbase market-universe gate did not pass; new entries must remain blocked.",
    (marketFeed.issues || []).slice(0, 3).map((item) => (item.symbol ? item.symbol + ": " : "") + item.reason),
    {
      healthy_market_count: safeNumber(marketFeed.healthy_market_count) ?? 0,
      expected_market_count: safeNumber(marketFeed.expected_market_count) ?? rows.length,
      issue_count: Array.isArray(marketFeed.issues) ? marketFeed.issues.length : 0
    },
    { lastRunAtMs: nowMs }
  ));

  const regimeKnown = marketContext.status === "verified";
  workers.push(makeWorker(
    "market_regime",
    regimeKnown ? "complete" : "unavailable",
    regimeKnown
      ? "BTC-led market context: " + compact(marketContext.mode || "UNKNOWN") + "."
      : "Cross-market context is unavailable because one or more required inputs did not pass validation.",
    [marketContext.reason || "Waiting for verified BTC and breadth context."],
    {
      mode: compact(marketContext.mode || "BLOCKED", 32),
      btc_regime_1h: compact(marketContext.btc_regime_1h || "UNKNOWN", 32),
      btc_regime_6h: compact(marketContext.btc_regime_6h || "UNKNOWN", 32),
      breadth_uptrend_1h: safeNumber(marketContext.breadth_1h?.uptrend),
      breadth_uptrend_6h: safeNumber(marketContext.breadth_6h?.uptrend),
      allowed_for_long_entries: marketContext.allowed_for_long_entries === true
    },
    { lastRunAtMs: nowMs }
  ));

  const trendRows = live.filter((market) => ["UPTREND", "DOWNTREND", "RANGE_OR_TRANSITION", "HIGH_VOLATILITY"].includes(market.primary?.regime));
  workers.push(makeWorker(
    "trend",
    statusForCoverage(trendRows.length, Math.max(1, live.length)),
    asSummary(trendRows, (market) => market.symbol + " " + market.primary.regime + " / " + (market.higher?.regime || "UNKNOWN")),
    trendRows.map((market) => market.symbol + " EMA20 slope " + (safeNumber(market.primary?.ema20_slope_pct)?.toFixed(4) ?? "n/a") + "%"),
    { analyzed_markets: trendRows.length, expected_markets: live.length },
    { lastRunAtMs: nowMs }
  ));

  const reversalRows = live.filter((market) =>
    market.primary?.reversal_watch &&
    typeof market.primary.reversal_watch.status === "string" &&
    Array.isArray(market.primary.reversal_watch.evidence)
  );
  const reversalCounts = reversalRows.reduce((counts, market) => {
    const status = market.primary.reversal_watch.status;
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});
  workers.push(makeWorker(
    "reversal_watch",
    statusForCoverage(reversalRows.length, Math.max(1, live.length)),
    reversalRows.length
      ? asSummary(reversalRows, (market) => market.symbol + " " + market.primary.reversal_watch.status)
      : "Reversal diagnostics are unavailable until validated timeframe analysis completes.",
    reversalRows.slice(0, 3).map((market) => {
      const watch = market.primary.reversal_watch;
      return market.symbol + ": " + (watch.evidence.length ? watch.evidence.join(", ") : "no confirmed reversal evidence");
    }),
    { analyzed_markets: reversalRows.length, expected_markets: live.length, status_counts: reversalCounts, execution_authorized: false },
    { lastRunAtMs: nowMs }
  ));

  const momentumRows = live.filter((market) =>
    [market.primary?.rsi14, market.primary?.adx14, market.primary?.plus_di14, market.primary?.minus_di14]
      .every((value) => safeNumber(value) !== null)
  );
  workers.push(makeWorker(
    "momentum",
    statusForCoverage(momentumRows.length, Math.max(1, live.length)),
    momentumRows.length
      ? asSummary(momentumRows, (market) => market.symbol + " RSI " + Number(market.primary.rsi14).toFixed(1) + " · ADX " + Number(market.primary.adx14).toFixed(1))
      : "Momentum metrics are incomplete; no score is fabricated.",
    momentumRows.map((market) => market.symbol + " +DI " + Number(market.primary.plus_di14).toFixed(1) + " / −DI " + Number(market.primary.minus_di14).toFixed(1)),
    { analyzed_markets: momentumRows.length, expected_markets: live.length },
    { lastRunAtMs: nowMs }
  ));

  const volumeRows = live.filter((market) => safeNumber(market.primary?.volume_ratio_20) !== null);
  workers.push(makeWorker(
    "volume",
    statusForCoverage(volumeRows.length, Math.max(1, live.length)),
    volumeRows.length
      ? asSummary(volumeRows, (market) => market.symbol + " " + Number(market.primary.volume_ratio_20).toFixed(2) + "× baseline")
      : "A comparable closed-bar volume baseline is unavailable.",
    ["Volume is a confirmation input only; it does not establish buyer or seller control."],
    { analyzed_markets: volumeRows.length, expected_markets: live.length },
    { lastRunAtMs: nowMs }
  ));

  const breakoutRows = live.filter((market) => typeof market.primary?.breakout_20 === "boolean");
  const breakoutCount = breakoutRows.filter((market) => market.primary.breakout_20 === true).length;
  workers.push(makeWorker(
    "breakout",
    statusForCoverage(breakoutRows.length, Math.max(1, live.length)),
    breakoutRows.length
      ? breakoutCount + " of " + breakoutRows.length + " verified markets are above the prior 20-bar high."
      : "Breakout state is unavailable until closed-candle history passes validation.",
    breakoutRows.map((market) => market.symbol + ": " + (market.primary.breakout_20 ? "above prior high" : "no confirmed upside break")),
    { analyzed_markets: breakoutRows.length, upside_breakouts: breakoutCount },
    { lastRunAtMs: nowMs }
  ));

  const rangeRows = live.filter((market) => candidateFor(market, "range_mean_reversion"));
  const rangeEligible = rangeRows.filter((market) => candidateFor(market, "range_mean_reversion")?.eligible_for_research === true);
  workers.push(makeWorker(
    "mean_reversion",
    rangeRows.length ? statusForCoverage(rangeRows.length, Math.max(1, live.length)) : "unavailable",
    rangeRows.length
      ? rangeEligible.length + " range mean-reversion hypothesis/hypotheses currently pass research filters."
      : "Mean-reversion research is unavailable because validated 1H/6H candle history is incomplete.",
    rangeRows.map((market) => market.symbol + ": " + (candidateFor(market, "range_mean_reversion")?.eligible_for_research ? "research candidate" : "filters not aligned")),
    { analyzed_markets: rangeRows.length, research_candidates: rangeEligible.length },
    { lastRunAtMs: nowMs }
  ));

  const bookRows = live.filter((market) =>
    safeNumber(market.spread_bps) !== null &&
    safeNumber(market.bid_depth_quote) !== null &&
    safeNumber(market.ask_depth_quote) !== null &&
    safeNumber(market.book_retrieved_at_ms) !== null
  );
  const freshBookRows = bookRows.filter((market) => {
    const age = nowMs - Number(market.book_retrieved_at_ms);
    return age >= -1000 && age <= 15_000 &&
      Math.min(Number(market.bid_depth_quote), Number(market.ask_depth_quote)) >= 5_000;
  });
  workers.push(makeWorker(
    "microstructure",
    statusForCoverage(freshBookRows.length, Math.max(1, live.length)),
    freshBookRows.length + " of " + live.length + " live Coinbase books passed freshness and 50-level minimum-depth checks.",
    bookRows.slice(0, 3).map((market) => market.symbol + " spread " + Number(market.spread_bps).toFixed(1) + " bps · depth " + Math.min(Number(market.bid_depth_quote), Number(market.ask_depth_quote)).toFixed(0) + " USD"),
    { fresh_books: freshBookRows.length, observed_books: bookRows.length, max_book_age_ms: 15_000, depth_levels: 50, minimum_depth_usd_per_side: 5_000 },
    { lastRunAtMs: nowMs }
  ));

  const alignedRows = live.filter((market) =>
    market.primary?.regime && market.higher?.regime &&
    market.primary.regime !== "INSUFFICIENT_DATA" &&
    market.higher.regime !== "INSUFFICIENT_DATA"
  );
  const alignedCount = alignedRows.filter((market) => market.primary.regime === market.higher.regime).length;
  workers.push(makeWorker(
    "multi_timeframe",
    statusForCoverage(alignedRows.length, Math.max(1, live.length)),
    alignedRows.length
      ? alignedCount + " of " + alignedRows.length + " markets have matching 1H/6H regime labels."
      : "Multi-timeframe confirmation is unavailable.",
    alignedRows.filter((market) => market.primary.regime !== market.higher.regime)
      .slice(0, 3).map((market) => market.symbol + " 1H " + market.primary.regime + " vs 6H " + market.higher.regime),
    { analyzed_markets: alignedRows.length, aligned_markets: alignedCount },
    { lastRunAtMs: nowMs }
  ));

  const researchRows = live.filter((market) => market.strategy_research?.status === "research_only" && Array.isArray(market.strategy_research.candidates));
  const researchEligible = researchRows.reduce((count, market) =>
    count + market.strategy_research.candidates.filter((candidate) => candidate?.eligible_for_research === true).length, 0);
  workers.push(makeWorker(
    "strategy_research",
    researchRows.length ? statusForCoverage(researchRows.length, Math.max(1, live.length)) : "unavailable",
    researchRows.length
      ? researchEligible + " hypothesis/hypotheses pass transparent research filters; no new production strategy is promoted."
      : "Strategy hypotheses are unavailable because validated candle history is incomplete.",
    ["Research hypotheses are not production entry signals.", "No backtest or future-return estimate is claimed by this worker."],
    { analyzed_markets: researchRows.length, available_hypotheses: researchRows.reduce((n, market) => n + market.strategy_research.candidates.length, 0), eligible_hypotheses: researchEligible, paper_auto_entry_eligible: false },
    { lastRunAtMs: nowMs }
  ));

  const guardianDecision = riskGuardianDecision || evaluateAiWorkforceRiskVeto({
    marketFeed, marketContext, portfolio, settings, paperMode
  });
  const checks = guardianDecision.checks;
  const vetoReasons = guardianDecision.vetoReasons;
  const veto = guardianDecision.veto;
  workers.push(makeWorker(
    "risk_guardian",
    veto ? "blocked" : "complete",
    veto ? "VETO · " + vetoReasons.join(", ") + "." : "Safety preflight passed; this is not an order approval.",
    veto ? vetoReasons.map((reason) => reason.replaceAll("_", " ")) : ["Risk Guardian never authorizes or submits orders.", "Existing portfolio and paper-entry engine remain the sole execution gate."],
    { checks, veto, veto_reasons: vetoReasons, open_positions: safeNumber(portfolio.open_positions), unmarked_positions: safeNumber(portfolio.unmarked_positions), live_trading_enabled: false },
    { lastRunAtMs: nowMs, fields: { veto } }
  ));

  const alarmAt = safeNumber(runtime.last_scheduled_alarm_at_ms);
  const alarmAge = alarmAt === null ? null : Math.max(0, nowMs - alarmAt);
  const watchdogStale = alarmAge === null || alarmAge > DEFAULT_SCAN_INTERVAL_MS * 3;
  workers.push(makeWorker(
    "system_watchdog",
    watchdogStale ? "unavailable" : "complete",
    watchdogStale
      ? "No recent server-side scheduler heartbeat is verified yet."
      : "Cloudflare Durable Object scheduler heartbeat is recent.",
    [runtime.last_scheduled_scan_status ? "Last scheduled scan: " + compact(runtime.last_scheduled_scan_status, 32) : "Waiting for a completed scheduled scan."],
    {
      scheduler_status: watchdogStale ? "stale_or_not_started" : "recent",
      last_alarm_at_ms: alarmAt,
      last_alarm_age_ms: alarmAge,
      scan_interval_ms: DEFAULT_SCAN_INTERVAL_MS,
      last_scheduled_scan_status: compact(runtime.last_scheduled_scan_status || "not_started", 32),
      last_scan_status: compact(runtime.last_scan_status || "not_started", 32)
    },
    { lastRunAtMs: nowMs }
  ));

  const counts = workers.reduce((result, worker) => {
    result[worker.status] = (result[worker.status] || 0) + 1;
    return result;
  }, {});
  const watchdogHealthy = workers.find((worker) => worker.id === "system_watchdog")?.status === "complete";
  const overall = marketFeed.healthy === true && watchdogHealthy
    ? "healthy"
    : live.length ? "partial" : "unavailable";
  return {
    schema_version: 1,
    run_id: "cf-aiw-" + Math.floor(nowMs),
    status: overall,
    mode: "paper_only_read_only",
    source: source === "manual" ? "manual_scan" : "scheduled_scan",
    worker_count: workers.length,
    counts,
    started_at_ms: safeNumber(startedAtMs) ?? nowMs,
    finished_at_ms: nowMs,
    duration_ms: Math.max(0, nowMs - (safeNumber(startedAtMs) ?? nowMs)),
    estimated_next_run_at_ms: nowMs + DEFAULT_SCAN_INTERVAL_MS,
    scan_interval_ms: DEFAULT_SCAN_INTERVAL_MS,
    entry_status: compact(entryStatus, 48),
    execution_authorized: false,
    paper_auto_entry_eligible: false,
    live_trading_enabled: false,
    disclaimer: "Twelve deterministic analysis roles share one verified market snapshot. They are not twelve separately trained AI models and cannot authorize orders.",
    workers
  };
}

export function markAiWorkforceFailure(previous, error, nowMs = Date.now()) {
  const message = compact(error?.message || error || "scheduled_scan_failed", 180);
  const workers = DEFINITIONS.map(([id]) => {
    const old = Array.isArray(previous?.workers) ? previous.workers.find((item) => item.id === id) : null;
    return makeWorker(id, "error", "Latest full scan failed; this role did not receive a fresh market snapshot.", [message], {}, {
      lastRunAtMs: nowMs,
      fields: { previous_status: old?.status || "not_run" }
    });
  });
  return {
    schema_version: 1,
    run_id: "cf-aiw-" + Math.floor(nowMs),
    status: "error",
    mode: "paper_only_read_only",
    source: "scheduled_scan",
    worker_count: workers.length,
    counts: { error: workers.length },
    started_at_ms: nowMs,
    finished_at_ms: nowMs,
    duration_ms: 0,
    estimated_next_run_at_ms: nowMs + DEFAULT_SCAN_INTERVAL_MS,
    scan_interval_ms: DEFAULT_SCAN_INTERVAL_MS,
    error: message,
    execution_authorized: false,
    paper_auto_entry_eligible: false,
    live_trading_enabled: false,
    disclaimer: "No worker was given stale data after a failed scan. All roles remain read-only.",
    workers
  };
}

export function readAiWorkforceStatus(saved, runtime = {}, nowMs = Date.now()) {
  if (saved && Array.isArray(saved.workers) && saved.workers.length === DEFINITIONS.length) {
    const runAge = safeNumber(saved.finished_at_ms) === null
      ? null : Math.max(0, nowMs - Number(saved.finished_at_ms));
    return {
      ...saved,
      freshness_status: runAge === null ? "waiting" : runAge > DEFAULT_SCAN_INTERVAL_MS * 3 ? "stale" : "fresh",
      run_age_ms: runAge,
      heartbeat_age_ms: safeNumber(runtime.last_scheduled_alarm_at_ms) === null
        ? null : Math.max(0, nowMs - Number(runtime.last_scheduled_alarm_at_ms))
    };
  }
  return {
    schema_version: 1,
    run_id: null,
    status: "waiting",
    freshness_status: "waiting",
    run_age_ms: null,
    heartbeat_age_ms: null,
    mode: "paper_only_read_only",
    source: "not_started",
    worker_count: DEFINITIONS.length,
    counts: { waiting: DEFINITIONS.length },
    started_at_ms: null,
    finished_at_ms: null,
    duration_ms: null,
    estimated_next_run_at_ms: (safeNumber(runtime.last_scheduled_scan_at_ms) || nowMs) + DEFAULT_SCAN_INTERVAL_MS,
    scan_interval_ms: DEFAULT_SCAN_INTERVAL_MS,
    execution_authorized: false,
    paper_auto_entry_eligible: false,
    live_trading_enabled: false,
    disclaimer: "Waiting for the next verified full market scan. No specialist status is assumed ready.",
    workers: DEFINITIONS.map(([id, name, group, description]) => ({
      id, name, group, description, status: "waiting", summary: "Waiting for the next verified market scan.",
      findings: [], metrics: {}, last_run_at_ms: null, execution_authorized: false
    }))
  };
}
