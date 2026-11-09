// Cloudflare deployment strategy: deterministic research-only PAPER signals.

/**
 * Use only valid, current two-sided ticker quotes when valuing paper positions.
 * This same gate is used by scheduled scans and dashboard reads so stale cached
 * marks cannot alter persisted equity peaks or daily/weekly risk baselines.
 */
/**
 * A fresh HTTP snapshot can contain a valid current bid/ask even when the
 * ticker's "time" is an older last-trade timestamp. That distinction matters
 * for PAPER exits: never discard a just-retrieved bid merely because no trade
 * printed recently. Entry eligibility still requires a fresh exchange
 * timestamp in assessCandidate/assessMarketUniverse.
 */
/**
 * A newly received ticker response is a usable mark for an existing PAPER
 * position even when no recent trade printed. Exchange event time is checked
 * separately for entries; exits only require a fresh local observation and
 * valid bid/ask values.
 */
export function isFreshQuoteObservation(market, nowMs = Date.now(), maxQuoteAgeMs = 120000) {
  if (market?.status !== "live") return false;
  const hasReceivedAt = Object.prototype.hasOwnProperty.call(market, "quote_received_at_ms");
  if (hasReceivedAt) {
    const receivedAt = Number(market.quote_received_at_ms);
    if (!Number.isFinite(receivedAt) || receivedAt <= 0) return false;
    const receivedAge = nowMs - receivedAt;
    if (receivedAge < -5000 || receivedAge > maxQuoteAgeMs) return false;
    const eventTime = Date.parse(market.ticker_time || "");
    return !Number.isFinite(eventTime) || eventTime <= nowMs + 5000;
  }

  // Backward compatibility for snapshots created before local receipt time
  // was persisted: use the exchange ticker timestamp as the only observation.
  const quoteTime = Date.parse(market.ticker_time || "");
  const age = nowMs - quoteTime;
  return Number.isFinite(quoteTime) && age >= -5000 && age <= maxQuoteAgeMs;
}

/** New entries also require a recent actual exchange trade timestamp. */
export function isFreshTickerEvent(market, nowMs = Date.now(), maxEventAgeMs = 120000) {
  if (!isFreshQuoteObservation(market, nowMs, maxEventAgeMs)) return false;
  const quoteTime = Date.parse(market?.ticker_time || "");
  const age = nowMs - quoteTime;
  return Number.isFinite(quoteTime) && age >= -5000 && age <= maxEventAgeMs;
}

/**
 * Exit marks use the current response receipt time, not the last-trade time.
 * Old trade timestamps are therefore allowed for quiet markets, but malformed
 * or future timestamps are still rejected when present.
 */
export function isFreshBidQuote(market, nowMs = Date.now(), maxQuoteAgeMs = 120000) {
  if (market?.status !== "live" ||
      !Number.isFinite(market.bid) || market.bid <= 0 ||
      !Number.isFinite(market.ask) || market.ask < market.bid) return false;

  if (!Object.prototype.hasOwnProperty.call(market, "quote_received_at_ms")) {
    const quoteTime = Date.parse(market.ticker_time || "");
    const age = nowMs - quoteTime;
    return Number.isFinite(quoteTime) && age >= -5000 && age <= maxQuoteAgeMs;
  }

  const receivedAt = Number(market.quote_received_at_ms);
  if (!Number.isFinite(receivedAt) || receivedAt <= 0) return false;
  const receivedAge = nowMs - receivedAt;
  if (receivedAge < -5000 || receivedAge > maxQuoteAgeMs) return false;
  const eventTime = Date.parse(market.ticker_time || "");
  return !Number.isFinite(eventTime) || eventTime <= nowMs + 5000;
}

export function buildFreshBidMarks(
  markets,
  nowMs = Date.now(),
  maxQuoteAgeMs = 120000,
  requiredProvidersBySymbol = null
) {
  const rows = Array.isArray(markets) ? markets : [];
  return new Map(rows.filter((market) => {
    if (!isFreshBidQuote(market, nowMs, maxQuoteAgeMs)) return false;
    if (requiredProvidersBySymbol instanceof Map &&
        requiredProvidersBySymbol.has(market.symbol)) {
      return market.market_data_provider === requiredProvidersBySymbol.get(market.symbol);
    }
    return true;
  }).map((market) => [market.symbol, market.bid]));
}

/**
 * Do not establish a risk-period baseline using incomplete marks for an
 * existing open position. A new baseline is created on the first fully marked
 * observation in that UTC period.
 */
export function resolveRiskBaseline({
  periodKey, storedPeriodKey, storedBaseline, equity, closedPnl, unmarkedPositions
}) {
  if (storedPeriodKey === periodKey && Number.isFinite(storedBaseline)) {
    return { baseline: storedBaseline, initialized: true, shouldPersist: false };
  }
  if (unmarkedPositions > 0) {
    return { baseline: null, initialized: false, shouldPersist: false };
  }
  const baseline = equity - closedPnl;
  if (!Number.isFinite(baseline)) {
    return { baseline: null, initialized: false, shouldPersist: false };
  }
  return { baseline, initialized: true, shouldPersist: true };
}

export function ema(values, period) {
  if (!Array.isArray(values) || values.length < period || period < 1) return [];
  const alpha = 2 / (period + 1);
  const seed = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  const result = Array(period - 1).fill(values[0]);
  result.push(seed);
  for (let index = period; index < values.length; index += 1) {
    result.push(alpha * values[index] + (1 - alpha) * result[result.length - 1]);
  }
  return result;
}

export function rsiWilder(values, period = 14) {
  if (values.length <= period) return null;
  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
  }
  gain /= period;
  loss /= period;
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    gain = ((gain * (period - 1)) + Math.max(change, 0)) / period;
    loss = ((loss * (period - 1)) + Math.max(-change, 0)) / period;
  }
  if (loss <= 0) return gain > 0 ? 100 : 50;
  return 100 - (100 / (1 + (gain / loss)));
}

function atrAdx(rows, period = 14) {
  if (rows.length < (2 * period + 1)) return null;
  const trueRanges = [];
  const plusMoves = [];
  const minusMoves = [];
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    const highMove = current.high - previous.high;
    const lowMove = previous.low - current.low;
    trueRanges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    ));
    plusMoves.push(highMove > lowMove && highMove > 0 ? highMove : 0);
    minusMoves.push(lowMove > highMove && lowMove > 0 ? lowMove : 0);
  }
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let plus = plusMoves.slice(0, period).reduce((a, b) => a + b, 0);
  let minus = minusMoves.slice(0, period).reduce((a, b) => a + b, 0);
  const dx = [];
  let plusDi = 0;
  let minusDi = 0;
  for (let index = period - 1; index < trueRanges.length; index += 1) {
    if (index >= period) {
      atr = ((atr * (period - 1)) + trueRanges[index]) / period;
      plus = plus - (plus / period) + plusMoves[index];
      minus = minus - (minus / period) + minusMoves[index];
    }
    plusDi = atr > 0 ? 100 * plus / (period * atr) : 0;
    minusDi = atr > 0 ? 100 * minus / (period * atr) : 0;
    const denominator = plusDi + minusDi;
    dx.push(denominator > 0 ? 100 * Math.abs(plusDi - minusDi) / denominator : 0);
  }
  if (dx.length < period) return null;
  let adx = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let index = period; index < dx.length; index += 1) {
    adx = ((adx * (period - 1)) + dx[index]) / period;
  }
  return { atr, adx, plusDi, minusDi };
}

export function auditCandles(input, intervalMs, nowMs = Date.now(), minimumBars = 150) {
  const issues = [];
  if (!Array.isArray(input)) return { ok: false, issues: ["candles_not_array"], rows: [] };
  const rows = [];
  const seen = new Set();
  for (const raw of input) {
    if (!raw || !Number.isFinite(Number(raw.time))) {
      issues.push("invalid_timestamp");
      continue;
    }
    const time = Number(raw.time);
    if (time % intervalMs !== 0) issues.push("off_grid_timestamp");
    if (seen.has(time)) {
      issues.push("duplicate_timestamp");
      continue;
    }
    seen.add(time);
    const values = [raw.open, raw.high, raw.low, raw.close, raw.volume].map(Number);
    if (!values.every(Number.isFinite) || values.slice(0, 4).some((value) => value <= 0) ||
        values[4] < 0 || values[1] < Math.max(values[0], values[3], values[2]) ||
        values[2] > Math.min(values[0], values[3], values[1])) {
      issues.push("invalid_ohlcv");
      continue;
    }
    if (time + intervalMs <= nowMs) {
      rows.push({
        time,
        open: values[0],
        high: values[1],
        low: values[2],
        close: values[3],
        volume: values[4]
      });
    }
  }
  rows.sort((a, b) => a.time - b.time);
  let gaps = 0;
  for (let index = 1; index < rows.length; index += 1) {
    if ((rows[index].time - rows[index - 1].time) !== intervalMs) gaps += 1;
  }
  if (gaps) issues.push("missing_intervals");
  if (rows.length < minimumBars) issues.push("insufficient_closed_history");
  return {
    ok: issues.length === 0,
    issues: [...new Set(issues)],
    rows,
    valid_closed_bars: rows.length,
    missing_intervals: gaps
  };
}

export function analyzeTimeframe(audit) {
  if (!audit?.ok) {
    return {
      signal: "HOLD",
      score: 0,
      regime: "DATA_UNAVAILABLE",
      reason: audit?.issues?.join(", ") || "candle_integrity_failed"
    };
  }
  const rows = audit.rows;
  const closes = rows.map((row) => row.close);
  const highs = rows.map((row) => row.high);
  const volumes = rows.map((row) => row.volume);
  const fast = ema(closes, 20);
  const slow = ema(closes, 50);
  const rsi = rsiWilder(closes, 14);
  const directional = atrAdx(rows, 14);
  if (!directional || rsi === null || fast.length !== closes.length || slow.length !== closes.length) {
    return { signal: "HOLD", score: 0, regime: "INSUFFICIENT_INDICATOR_HISTORY", reason: "indicator_warmup" };
  }
  const { atr, adx, plusDi, minusDi } = directional;
  const atrPct = (atr / closes[closes.length - 1]) * 100;
  const emaSlopePct = fast[fast.length - 1] > 0
    ? ((fast[fast.length - 1] / fast[fast.length - 6]) - 1) * 100 : 0;
  const trendUp = fast.at(-1) > slow.at(-1) && closes.at(-1) > slow.at(-1) && emaSlopePct > 0;
  const trendDown = fast.at(-1) < slow.at(-1) && closes.at(-1) < slow.at(-1) && emaSlopePct < 0;
  const regime = atrPct >= 8 ? "HIGH_VOLATILITY"
    : trendUp && adx >= 18 && plusDi > minusDi ? "UPTREND"
      : trendDown && adx >= 18 && plusDi <= minusDi ? "DOWNTREND"
        : "RANGE_OR_TRANSITION";
  const recentVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const priorVolume = volumes.slice(-40, -20).reduce((a, b) => a + b, 0) / 20;
  const volumeRatio = priorVolume > 0 ? recentVolume / priorVolume : null;
  const priorHigh = Math.max(...highs.slice(-21, -1));
  const breakout = closes.at(-1) > priorHigh;
  let score = 50;
  if (trendUp) score += 20;
  if (trendDown) score -= 20;
  if (rsi >= 48 && rsi <= 66) score += 10;
  else if (rsi >= 72 || rsi <= 30) score -= 10;
  if (volumeRatio !== null && volumeRatio >= 1.25) score += 10;
  else if (volumeRatio !== null && volumeRatio < 0.65) score -= 8;
  if (breakout) score += 10;
  if (adx >= 22 && plusDi > minusDi) score += 10;
  else if (adx < 15) score -= 10;
  if (atrPct >= 8) score -= 20;
  score = Math.max(0, Math.min(100, score));
  const signal = score >= 75 && regime === "UPTREND" && atrPct < 8 &&
    adx >= 18 && plusDi > minusDi && rsi < 68 ? "BUY_CANDIDATE" : "HOLD";
  return {
    signal,
    score,
    regime,
    rsi14: Number(rsi.toFixed(2)),
    atr14: atr,
    atr_pct: Number(atrPct.toFixed(4)),
    adx14: Number(adx.toFixed(3)),
    plus_di14: Number(plusDi.toFixed(3)),
    minus_di14: Number(minusDi.toFixed(3)),
    ema20: fast.at(-1),
    ema50: slow.at(-1),
    ema20_slope_pct: Number(emaSlopePct.toFixed(5)),
    volume_ratio_20: volumeRatio === null ? null : Number(volumeRatio.toFixed(4)),
    breakout_20: breakout,
    valid_candles: rows.length,
    last_closed_candle_ms: rows.at(-1).time,
    reason: signal === "BUY_CANDIDATE" ? "multi_factor_uptrend_candidate" : "strategy_filters_not_aligned",
    warning: "Deterministic research signal only; not a forecast or profit guarantee."
  };
}

export function evaluateResearchCandidates(
  primaryAudit,
  higherAudit,
  higherIntervalMs = 21_600_000
) {
  const blocked = (reason) => ({
    status: "blocked",
    reason,
    candidates: [],
    best_research_candidate: null,
    execution_authorized: false,
    paper_auto_entry_eligible: false,
    live_trading_enabled: false
  });
  if (!primaryAudit?.ok || !higherAudit?.ok) return blocked("candle_integrity_failed");
  if (![14_400_000, 21_600_000].includes(higherIntervalMs)) {
    return blocked("unsupported_higher_timeframe_interval");
  }
  const primaryRows = primaryAudit.rows;
  const higherRows = higherAudit.rows;
  if (!Array.isArray(primaryRows) || !Array.isArray(higherRows) ||
      primaryRows.length < 150 || higherRows.length < 150) {
    return blocked("insufficient_closed_history");
  }
  const primaryClosedAt = primaryRows.at(-1).time + 3_600_000;
  const higherClosedAt = higherRows.at(-1).time + higherIntervalMs;
  if (higherClosedAt > primaryClosedAt) {
    return blocked("higher_timeframe_data_is_from_the_future");
  }

  const primary = analyzeTimeframe(primaryAudit);
  const higher = analyzeTimeframe(higherAudit);
  const metricNames = ["rsi14", "atr_pct", "adx14", "plus_di14", "minus_di14", "ema50"];
  if (!metricNames.every((name) => Number.isFinite(primary[name]) && Number.isFinite(higher[name]))) {
    return blocked("indicator_metrics_invalid");
  }

  const closes = primaryRows.map((row) => row.close);
  const highs = primaryRows.map((row) => row.high);
  const volumes = primaryRows.map((row) => row.volume);
  const close = closes.at(-1);
  const priorHigh = Math.max(...highs.slice(-21, -1));
  const recentVolume = volumes.slice(-20).reduce((sum, value) => sum + value, 0) / 20;
  const previousVolume = volumes.slice(-40, -20).reduce((sum, value) => sum + value, 0) / 20;
  const volumeRatio = previousVolume > 0 ? recentVolume / previousVolume : null;
  const fast = ema(closes, 20);

  const build = (strategyId, label, conditions) => {
    const passed = Object.entries(conditions).filter(([, ok]) => ok).map(([name]) => name);
    const eligible = passed.length === Object.keys(conditions).length;
    return {
      strategy_id: strategyId,
      label,
      signal: eligible ? "RESEARCH_CANDIDATE" : "HOLD",
      eligible_for_research: eligible,
      heuristic_score: Math.min(100, 50 + (passed.length * 8)),
      score_is_probability: false,
      reasons: passed.length ? passed : [strategyId + "_filters_not_aligned"],
      execution_authorized: false
    };
  };

  const trend = build("trend_pullback", "Trend pullback and EMA reclaim", {
    higher_timeframe_uptrend: higher.regime === "UPTREND",
    primary_price_above_ema50: close > primary.ema50,
    ema20_reclaimed_after_pullback: fast.length >= 3 &&
      closes.at(-2) <= fast.at(-2) && close > fast.at(-1),
    directional_strength: primary.adx14 >= 18 && primary.plus_di14 > primary.minus_di14,
    rsi_not_overextended: primary.rsi14 >= 45 && primary.rsi14 <= 68,
    volatility_not_extreme: primary.atr_pct > 0 && primary.atr_pct < 5
  });

  const breakout = build("volatility_breakout", "20-bar breakout with volume expansion", {
    higher_timeframe_uptrend: higher.regime === "UPTREND",
    close_above_prior_20_bar_high: close > priorHigh,
    relative_volume_at_least_1_5x: volumeRatio !== null && volumeRatio >= 1.5,
    adx_at_least_20: primary.adx14 >= 20,
    positive_directional_movement: primary.plus_di14 > primary.minus_di14,
    volatility_not_extreme: primary.atr_pct > 0 && primary.atr_pct < 5
  });

  const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const deviation = (values) => {
    const center = average(values);
    return Math.sqrt(average(values.map((value) => (value - center) ** 2)));
  };
  const currentWindow = closes.slice(-20);
  const previousWindow = closes.slice(-21, -1);
  const currentLower = average(currentWindow) - (2 * deviation(currentWindow));
  const previousLower = average(previousWindow) - (2 * deviation(previousWindow));
  const range = build("range_mean_reversion", "Range mean reversion after lower-band reclaim", {
    primary_range_regime: primary.regime === "RANGE_OR_TRANSITION",
    higher_range_regime: higher.regime === "RANGE_OR_TRANSITION",
    adx_below_18: primary.adx14 < 18,
    rsi_at_or_below_40: primary.rsi14 <= 40,
    reclaimed_lower_bollinger_band: closes.at(-2) <= previousLower && close > currentLower,
    volatility_not_extreme: primary.atr_pct > 0 && primary.atr_pct < 4
  });

  const candidates = [trend, breakout, range];
  const eligible = candidates.filter((candidate) => candidate.eligible_for_research)
    .sort((left, right) => right.heuristic_score - left.heuristic_score);
  return {
    status: "research_only",
    primary_regime: primary.regime,
    higher_regime: higher.regime,
    relative_volume_20: volumeRatio === null ? null : Number(volumeRatio.toFixed(4)),
    higher_timeframe_interval_ms: higherIntervalMs,
    candidates,
    best_research_candidate: eligible[0]?.strategy_id || null,
    ranking_method: "fixed transparent rule count; not trained, calibrated or a probability",
    execution_authorized: false,
    paper_auto_entry_eligible: false,
    live_trading_enabled: false,
    warning: "Research-only strategy hypotheses. They are not approved for PAPER auto-entry or live trading."
  };
}


export function assessCandidate({ market, primary, higher, nowMs, costs }) {
  const reject = (reason) => ({ eligible: false, reason });
  if (market?.status !== "live") return reject("market_data_unavailable");
  if (!Number.isFinite(nowMs)) return reject("invalid_evaluation_time");
  if (!primary || typeof primary !== "object" || !higher || typeof higher !== "object") {
    return reject("timeframe_analysis_unavailable");
  }
  const timeframeMetrics = [
    primary.score, primary.atr_pct, primary.rsi14, primary.adx14,
    primary.plus_di14, primary.minus_di14, primary.last_closed_candle_ms,
    higher.last_closed_candle_ms
  ];
  if (!timeframeMetrics.every(Number.isFinite)) return reject("timeframe_metrics_invalid");
  if (!costs || !Number.isFinite(costs.feeBpsPerSide) || costs.feeBpsPerSide < 0 ||
      !Number.isFinite(costs.slippageBps) || costs.slippageBps < 0) {
    return reject("execution_cost_assumptions_invalid");
  }
  if (!isFreshQuoteObservation(market, nowMs, 120000) ||
      !isFreshTickerEvent(market, nowMs, 120000)) {
    return reject("ticker_stale_or_timestamp_invalid");
  }
  const { bid, ask, last, quote_volume_usd: quoteVolume } = market;
  if (![bid, ask, last, quoteVolume].every((value) => Number.isFinite(value) && value > 0) || ask < bid) {
    return reject("invalid_or_crossed_quote");
  }
  const mid = (bid + ask) / 2;
  const spreadBps = ((ask - bid) / mid) * 10000;
  if (spreadBps > 25) return reject("spread_too_wide");
  if (!Number.isFinite(market.bid_depth_quote) || !Number.isFinite(market.ask_depth_quote) ||
      Math.min(market.bid_depth_quote, market.ask_depth_quote) < 5000) {
    return reject("top10_orderbook_depth_unavailable_or_low");
  }
  if (!Number.isFinite(market.book_retrieved_at_ms) || market.book_retrieved_at_ms > nowMs + 1000 ||
      nowMs - market.book_retrieved_at_ms < -1000 || nowMs - market.book_retrieved_at_ms > 15000) {
    return reject("orderbook_snapshot_retrieval_stale_or_missing");
  }
  if (quoteVolume < 1000000) return reject("quote_volume_below_1m");
  const oneHourAge = nowMs - (primary.last_closed_candle_ms + 3600000);
  const sixHourAge = nowMs - (higher.last_closed_candle_ms + 21600000);
  // A closed 1h candle should normally be less than one hour old, and a
  // closed 6h candle less than six hours old. Allow a modest 30m/1h margin
  // for provider timing, but reject older analysis before considering entry.
  if (oneHourAge < -1000 || oneHourAge > 5400000) return reject("one_hour_candle_stale");
  if (sixHourAge < -1000 || sixHourAge > 25200000) return reject("six_hour_candle_stale");
  if (primary.signal !== "BUY_CANDIDATE" || primary.score < 75) return reject("primary_signal_not_qualified");
  if (primary.regime !== "UPTREND" || higher.regime !== "UPTREND") return reject("timeframes_not_both_uptrend");
  if (primary.atr_pct >= 5 || primary.rsi14 >= 68 || primary.adx14 < 18 ||
      primary.plus_di14 <= primary.minus_di14) return reject("volatility_or_momentum_guard");
  const roundTripBps = 2 * (costs.feeBpsPerSide + costs.slippageBps) + spreadBps;
  if (primary.atr_pct * 100 < roundTripBps * 2.5) return reject("expected_range_below_cost_multiple");
  return { eligible: true, reason: "eligible", spread_bps: Number(spreadBps.toFixed(2)), round_trip_cost_bps: Number(roundTripBps.toFixed(2)) };
}
