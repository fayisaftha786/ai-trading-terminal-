// Cloudflare deployment strategy: deterministic research-only PAPER signals.

/**
 * Use only valid, current two-sided ticker quotes when valuing paper positions.
 * This same gate is used by scheduled scans and dashboard reads so stale cached
 * marks cannot alter persisted equity peaks or daily/weekly risk baselines.
 */
export function buildFreshBidMarks(markets, nowMs = Date.now(), maxQuoteAgeMs = 120000) {
  const rows = Array.isArray(markets) ? markets : [];
  return new Map(rows.filter((market) => {
    if (market?.status !== "live") return false;
    const quoteTime = Date.parse(market.ticker_time || "");
    const age = nowMs - quoteTime;
    return Number.isFinite(quoteTime) &&
      age >= -5000 && age <= maxQuoteAgeMs &&
      Number.isFinite(market.bid) && market.bid > 0 &&
      Number.isFinite(market.ask) && market.ask >= market.bid;
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

export function assessCandidate({ market, primary, higher, nowMs, costs }) {
  const reject = (reason) => ({ eligible: false, reason });
  if (market?.status !== "live") return reject("market_data_unavailable");
  const quoteTime = Date.parse(market.ticker_time || "");
  if (!Number.isFinite(quoteTime) || nowMs - quoteTime < -5000 || nowMs - quoteTime > 120000) {
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
  if (oneHourAge < -1000 || oneHourAge > 9000000) return reject("one_hour_candle_stale");
  if (sixHourAge < -1000 || sixHourAge > 43200000) return reject("six_hour_candle_stale");
  if (primary.signal !== "BUY_CANDIDATE" || primary.score < 75) return reject("primary_signal_not_qualified");
  if (primary.regime !== "UPTREND" || higher.regime !== "UPTREND") return reject("timeframes_not_both_uptrend");
  if (primary.atr_pct >= 5 || primary.rsi14 >= 68 || primary.adx14 < 18 ||
      primary.plus_di14 <= primary.minus_di14) return reject("volatility_or_momentum_guard");
  const roundTripBps = 2 * (costs.feeBpsPerSide + costs.slippageBps) + spreadBps;
  if (primary.atr_pct * 100 < roundTripBps * 2.5) return reject("expected_range_below_cost_multiple");
  return { eligible: true, reason: "eligible", spread_bps: Number(spreadBps.toFixed(2)), round_trip_cost_bps: Number(roundTripBps.toFixed(2)) };
}
