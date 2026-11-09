const HOUR_MS = 3600000;
const SIX_HOUR_MS = 6 * HOUR_MS;
const DEFAULTS = Object.freeze({
  initialEquity: 100,
  allocationPct: 0.1,
  feeBpsPerSide: 15,
  slippageBps: 10,
  maxBarsInTrade: 72,
  monteCarloIterations: 500,
  monteCarloBlockLength: 3,
  monteCarloSeed: 20261109,
  minimumMonteCarloTrades: 30
});

function hasPresentNumericValue(value) {
  return (typeof value === "number" ||
    (typeof value === "string" && value.trim() !== "")) &&
    Number.isFinite(Number(value));
}

function normalizeBars(input, intervalMs) {
  if (!Array.isArray(input)) return { rows: [], issues: ["candles_not_array"] };
  const issues = new Set();
  const rows = [];

  for (const raw of input) {
    if (!raw || typeof raw !== "object") {
      issues.add("invalid_candle_row");
      continue;
    }
    if (!hasPresentNumericValue(raw.time) ||
        !Number.isSafeInteger(Number(raw.time)) || Number(raw.time) < 0) {
      issues.add("invalid_timestamp");
      continue;
    }
    const values = [raw.open, raw.high, raw.low, raw.close, raw.volume];
    if (!values.every(hasPresentNumericValue)) {
      issues.add("invalid_ohlcv");
      continue;
    }
    const row = {
      time: Number(raw.time),
      open: Number(raw.open),
      high: Number(raw.high),
      low: Number(raw.low),
      close: Number(raw.close),
      volume: Number(raw.volume)
    };
    if ([row.open, row.high, row.low, row.close].some((price) => price <= 0) ||
        row.high < Math.max(row.open, row.close, row.low) ||
        row.low > Math.min(row.open, row.close, row.high) || row.volume < 0) {
      issues.add("invalid_ohlcv");
      continue;
    }
    if (row.time % intervalMs !== 0) issues.add("off_grid_timestamp");
    rows.push(row);
  }

  rows.sort((a, b) => a.time - b.time);
  for (let index = 1; index < rows.length; index += 1) {
    const distance = rows[index].time - rows[index - 1].time;
    if (distance === 0) issues.add("duplicate_timestamp");
    else if (distance !== intervalMs) issues.add("missing_intervals");
  }

  return { rows, issues: [...issues] };
}

function ema(values, period) {
  if (values.length < period) return [];
  const alpha = 2 / (period + 1);
  const result = Array(period - 1).fill(null);
  result.push(values.slice(0, period).reduce((a, b) => a + b, 0) / period);
  for (let i = period; i < values.length; i += 1) {
    result.push(alpha * values[i] + (1 - alpha) * result.at(-1));
  }
  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) return Array(values.length).fill(null);
  const out = Array(values.length).fill(null);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = values[i] - values[i - 1];
    gain += Math.max(0, change);
    loss += Math.max(0, -change);
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < values.length; i += 1) {
    const change = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(0, change)) / period;
    loss = (loss * (period - 1) + Math.max(0, -change)) / period;
    out[i] = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

function atr(rows, period = 14) {
  const out = Array(rows.length).fill(null);
  if (rows.length <= period) return out;
  const tr = [];
  for (let i = 1; i < rows.length; i += 1) {
    tr.push(Math.max(rows[i].high - rows[i].low,
      Math.abs(rows[i].high - rows[i - 1].close),
      Math.abs(rows[i].low - rows[i - 1].close)));
  }
  let value = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period] = value;
  for (let i = period + 1; i < rows.length; i += 1) {
    value = (value * (period - 1) + tr[i - 1]) / period;
    out[i] = value;
  }
  return out;
}

function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function standardDeviation(values) {
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

function features(oneHour, sixHour) {
  const closes = oneHour.map((row) => row.close);
  const fast = ema(closes, 20);
  const slow = ema(closes, 50);
  const momentum = rsi(closes);
  const ranges = atr(oneHour);
  const sixCloses = sixHour.map((row) => row.close);
  const sixFast = ema(sixCloses, 20);
  const sixSlow = ema(sixCloses, 50);
  let sixIndex = -1;
  return oneHour.map((bar, index) => {
    while (sixIndex + 1 < sixHour.length && sixHour[sixIndex + 1].time + SIX_HOUR_MS <= bar.time) sixIndex += 1;
    const higherTrend = sixIndex >= 49 && sixFast[sixIndex] > sixSlow[sixIndex] &&
      sixHour[sixIndex].close > sixSlow[sixIndex];
    const higherDown = sixIndex >= 49 && sixFast[sixIndex] < sixSlow[sixIndex] &&
      sixHour[sixIndex].close < sixSlow[sixIndex];
    const sample = closes.slice(Math.max(0, index - 19), index + 1);
    const average = sample.length === 20 ? mean(sample) : null;
    const deviation = sample.length === 20 ? standardDeviation(sample) : null;
    const priorHigh = index >= 20 ? Math.max(...oneHour.slice(index - 20, index).map((row) => row.high)) : null;
    const priorVolumes = oneHour.slice(Math.max(0, index - 20), index);
    const relativeVolume = priorVolumes.length === 20 && mean(priorVolumes.map((row) => row.volume)) > 0
      ? bar.volume / mean(priorVolumes.map((row) => row.volume)) : null;
    return {
      ema20: fast[index], ema50: slow[index],
      ema20Rising: index >= 5 && Number.isFinite(fast[index]) && Number.isFinite(fast[index - 5]) && fast[index] > fast[index - 5],
      rsi14: momentum[index], atr14: ranges[index],
      higherTrend, higherDown,
      rangeRegime: Number.isFinite(fast[index]) && Number.isFinite(slow[index]) &&
        Math.abs(fast[index] - slow[index]) / bar.close < 0.008 && !higherTrend && !higherDown,
      lowerBand: average !== null ? average - 2 * deviation : null,
      middleBand: average,
      priorHigh,
      relativeVolume
    };
  });
}

function strategySignal(name, bar, feature, index) {
  if (![feature.ema20, feature.ema50, feature.rsi14, feature.atr14].every(Number.isFinite)) return null;
  if (name === "trend_continuation") {
    if (bar.close > feature.ema20 && feature.ema20 > feature.ema50 && feature.ema20Rising &&
        feature.rsi14 >= 50 && feature.rsi14 <= 68 && feature.higherTrend) {
      return { stopAtr: 1.5, targetAtr: 3, reason: "ema_trend_and_6h_alignment" };
    }
  } else if (name === "range_mean_reversion") {
    if (feature.rangeRegime && !feature.higherDown && Number.isFinite(feature.lowerBand) &&
        bar.close < feature.lowerBand && feature.rsi14 <= 32) {
      return { stopAtr: 1.25, targetMiddle: true, reason: "range_lower_band_rsi_oversold" };
    }
  } else if (name === "breakout_continuation") {
    if (Number.isFinite(feature.priorHigh) && bar.close > feature.priorHigh &&
        feature.relativeVolume >= 1.25 && feature.higherTrend) {
      return { stopAtr: 1.5, targetAtr: 3.5, reason: "20_bar_breakout_volume_and_6h_alignment" };
    }
  }
  return null;
}

function metrics(trades, equityCurve, initialEquity, finalEquity) {
  const wins = trades.filter((trade) => trade.netPnl > 0);
  const losses = trades.filter((trade) => trade.netPnl < 0);
  const grossWins = wins.reduce((sum, trade) => sum + trade.netPnl, 0);
  const grossLosses = -losses.reduce((sum, trade) => sum + trade.netPnl, 0);
  let peak = initialEquity;
  let maxDrawdownPct = 0;
  for (const value of equityCurve) {
    peak = Math.max(peak, value);
    if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, (peak - value) / peak * 100);
  }
  const intrabarConflicts = trades.filter((trade) =>
    trade.same_bar_stop_target_conflict_resolved_stop_first
  ).length;
  return {
    trade_count: trades.length,
    win_rate_pct: trades.length ? Number((wins.length / trades.length * 100).toFixed(2)) : null,
    net_pnl: Number((finalEquity - initialEquity).toFixed(6)),
    net_return_pct: Number(((finalEquity / initialEquity - 1) * 100).toFixed(4)),
    profit_factor: grossLosses > 0 ? Number((grossWins / grossLosses).toFixed(4)) : (grossWins > 0 ? null : 0),
    expectancy_per_trade: trades.length ? Number((trades.reduce((sum, trade) => sum + trade.netPnl, 0) / trades.length).toFixed(6)) : null,
    max_drawdown_pct: Number(maxDrawdownPct.toFixed(4)),
    average_hold_bars: trades.length ? Number(mean(trades.map((trade) => trade.holdBars)).toFixed(2)) : null,
    intrabar_stop_target_conflicts: intrabarConflicts,
    intrabar_stop_target_conflict_rate_pct: trades.length
      ? Number((intrabarConflicts / trades.length * 100).toFixed(2)) : 0,
    exposure_pct: equityCurve.length ? Number((equityCurve.filter((value, index) => index > 0 && value !== equityCurve[index - 1]).length / equityCurve.length * 100).toFixed(2)) : 0
  };
}

function seededRandom(seed) {
  let state = Number.isSafeInteger(seed) ? (seed >>> 0) : 20261109;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(values, quantile) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function evaluateReturnPath(returns, initialEquity) {
  let equity = initialEquity;
  let peak = initialEquity;
  let maxDrawdownPct = 0;
  for (const returnPct of returns) {
    equity *= Math.max(0, 1 + (returnPct / 100));
    peak = Math.max(peak, equity);
    if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, (peak - equity) / peak * 100);
  }
  return {
    net_return_pct: (equity / initialEquity - 1) * 100,
    max_drawdown_pct: maxDrawdownPct
  };
}

/**
 * Deterministic order-shuffle and moving-block bootstrap stress.
 * The result is a research diagnostic, never an execution or promotion signal.
 */
export function runTradeOrderMonteCarlo(tradeReturnsPct, options = {}) {
  const returns = Array.isArray(tradeReturnsPct) ? tradeReturnsPct.slice() : [];
  const initialEquity = Number(options.initialEquity ?? DEFAULTS.initialEquity);
  const iterations = Number(options.iterations ?? DEFAULTS.monteCarloIterations);
  const blockLength = Number(options.blockLength ?? DEFAULTS.monteCarloBlockLength);
  const minimumTrades = Number(options.minimumTrades ?? DEFAULTS.minimumMonteCarloTrades);
  const seed = Number(options.seed ?? DEFAULTS.monteCarloSeed);

  if (!Number.isFinite(initialEquity) || initialEquity <= 0 ||
      !Number.isSafeInteger(iterations) || iterations < 100 || iterations > 2000 ||
      !Number.isSafeInteger(blockLength) || blockLength < 1 || blockLength > 10 ||
      !Number.isSafeInteger(minimumTrades) || minimumTrades < 10 ||
      !Number.isSafeInteger(seed) || !returns.every((value) => Number.isFinite(value) && value > -100)) {
    return { status: "invalid_inputs", sample_size: returns.length };
  }

  if (returns.length < minimumTrades) {
    return {
      status: "insufficient_trade_sample",
      sample_size: returns.length,
      minimum_required_trades: minimumTrades,
      iterations: 0
    };
  }

  const random = seededRandom(seed);
  const shuffledDrawdowns = [];
  const bootstrappedReturns = [];
  const bootstrappedDrawdowns = [];
  let bootstrapLosses = 0;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const shuffled = returns.slice();
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1));
      [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
    }
    shuffledDrawdowns.push(evaluateReturnPath(shuffled, initialEquity).max_drawdown_pct);

    const bootstrapped = [];
    while (bootstrapped.length < returns.length) {
      const maxStart = Math.max(0, returns.length - blockLength);
      const blockStart = Math.floor(random() * (maxStart + 1));
      for (let offset = 0; offset < blockLength && bootstrapped.length < returns.length; offset += 1) {
        bootstrapped.push(returns[blockStart + offset]);
      }
    }
    const result = evaluateReturnPath(bootstrapped, initialEquity);
    bootstrappedReturns.push(result.net_return_pct);
    bootstrappedDrawdowns.push(result.max_drawdown_pct);
    if (result.net_return_pct < 0) bootstrapLosses += 1;
  }

  return {
    status: "research_only",
    method: "trade_order_shuffle_and_moving_block_bootstrap",
    sample_size: returns.length,
    iterations,
    block_length: blockLength,
    trade_order_shuffle: {
      median_max_drawdown_pct: Number(percentile(shuffledDrawdowns, 0.5).toFixed(4)),
      p95_max_drawdown_pct: Number(percentile(shuffledDrawdowns, 0.95).toFixed(4))
    },
    moving_block_bootstrap: {
      p05_net_return_pct: Number(percentile(bootstrappedReturns, 0.05).toFixed(4)),
      median_net_return_pct: Number(percentile(bootstrappedReturns, 0.5).toFixed(4)),
      p95_net_return_pct: Number(percentile(bootstrappedReturns, 0.95).toFixed(4)),
      probability_of_loss_pct: Number((bootstrapLosses / iterations * 100).toFixed(2)),
      median_max_drawdown_pct: Number(percentile(bootstrappedDrawdowns, 0.5).toFixed(4)),
      p95_max_drawdown_pct: Number(percentile(bootstrappedDrawdowns, 0.95).toFixed(4))
    },
    caveat: "Resamples observed paper/backtest trade returns; regime changes and dependence beyond the chosen block length may not be captured."
  };
}

export function resolveLongBarExit(bar, stop, target) {
  if (bar.open <= stop) return { price: bar.open, reason: "stop_gap", conflict: false };
  if (bar.open >= target) return { price: target, reason: "target_gap", conflict: false };
  const stopHit = bar.low <= stop;
  const targetHit = bar.high >= target;
  if (stopHit) return { price: stop, reason: "stop", conflict: targetHit };
  if (targetHit) return { price: target, reason: "target", conflict: false };
  return null;
}

function simulate(name, bars, featureRows, options, startIndex, endIndex) {
  const initialEquity = options.initialEquity;
  let equity = initialEquity;
  let position = null;
  const trades = [];
  const curve = [];
  const exposure = [];
  const feeRate = options.feeBpsPerSide / 10000;
  const slipRate = options.slippageBps / 10000;
  const allocation = options.allocationPct;
  const finish = Math.min(endIndex - 1, bars.length - 1);

  function closePosition(rawPrice, index, reason, conflict = false) {
    const fillPrice = rawPrice * (1 - slipRate);
    const exitNotional = position.quantity * fillPrice;
    const exitFee = exitNotional * feeRate;
    const gross = (fillPrice - position.entryFill) * position.quantity;
    const net = gross - position.entryFee - exitFee;
    equity += net;
    trades.push({
      signal_time: new Date(position.signalTime).toISOString(),
      entry_time: new Date(position.entryTime).toISOString(),
      exit_time: new Date(bars[index].time).toISOString(),
      entry_price: Number(position.entryFill.toFixed(8)),
      exit_price: Number(fillPrice.toFixed(8)),
      quantity: Number(position.quantity.toFixed(8)),
      netPnl: Number(net.toFixed(8)),
      net_return_on_entry_equity_pct: Number((net / position.entryEquity * 100).toFixed(8)),
      entry_notional_usd: Number(position.notional.toFixed(8)),
      entry_equity_usd: Number(position.entryEquity.toFixed(8)),
      fees: Number((position.entryFee + exitFee).toFixed(8)),
      holdBars: index - position.entryIndex + 1,
      exit_reason: reason,
      same_bar_stop_target_conflict_resolved_stop_first: Boolean(conflict),
      entry_reason: position.reason
    });
    position = null;
  }

  for (let i = startIndex; i <= finish; i += 1) {
    const bar = bars[i];
    const heldDuringBar = Boolean(position);
    if (position) {
      const barExit = resolveLongBarExit(bar, position.stop, position.target);
      if (barExit) {
        closePosition(barExit.price, i, barExit.reason, barExit.conflict);
      } else if (i - position.entryIndex >= options.maxBarsInTrade) {
        closePosition(bar.close, i, "time_exit");
      } else {
        const currentFeature = featureRows[i];
        if (name === "range_mean_reversion" && Number.isFinite(currentFeature.middleBand) &&
            bar.close >= currentFeature.middleBand) {
          if (i + 1 <= finish) closePosition(bars[i + 1].open, i + 1, "mean_reversion_exit");
          else closePosition(bar.close, i, "end_of_window");
        }
      }
    }

    if (!position && i >= startIndex && i < finish) {
      const signal = strategySignal(name, bar, featureRows[i], i);
      if (signal) {
        const next = bars[i + 1];
        const entryFill = next.open * (1 + slipRate);
        const notional = equity * allocation;
        const quantity = notional / entryFill;
        const entryFee = notional * feeRate;
        const stop = entryFill - featureRows[i].atr14 * signal.stopAtr;
        const target = signal.targetMiddle
          ? featureRows[i].middleBand
          : entryFill + featureRows[i].atr14 * signal.targetAtr;
        if (Number.isFinite(stop) && stop > 0 && Number.isFinite(target) && target > entryFill) {
          position = {
            entryFill, quantity, entryFee, stop, target, notional,
            entryEquity: equity,
            signalTime: bar.time, entryTime: next.time, entryIndex: i + 1, reason: signal.reason
          };
        }
      }
    }
    const markedPosition = position && position.entryIndex <= i ? position : null;
    const estimatedExitFill = markedPosition ? bar.close * (1 - slipRate) : null;
    const estimatedExitFee = markedPosition ? estimatedExitFill * markedPosition.quantity * feeRate : 0;
    const mark = markedPosition
      ? equity + (estimatedExitFill - markedPosition.entryFill) * markedPosition.quantity -
        markedPosition.entryFee - estimatedExitFee
      : equity;
    curve.push(mark);
    exposure.push(heldDuringBar);
  }
  if (position) {
    closePosition(bars[finish].close, finish, "end_of_window");
    // Include the final forced-exit slippage and fee in the last drawdown mark.
    if (curve.length) curve[curve.length - 1] = equity;
  }
  const finalEquity = equity;
  const summary = metrics(trades, curve, initialEquity, finalEquity);
  summary.exposure_pct = exposure.length
    ? Number((exposure.filter(Boolean).length / exposure.length * 100).toFixed(2)) : 0;
  return { ...summary, trades };
}

function buyAndHold(bars, options, startIndex, endIndex) {
  const initial = options.initialEquity;
  const first = bars[startIndex + 1];
  const last = bars[endIndex - 1];
  if (!first || !last || last.time <= first.time) return { net_return_pct: 0, net_pnl: 0 };
  const fee = options.feeBpsPerSide / 10000;
  const slip = options.slippageBps / 10000;
  const notional = initial * options.allocationPct;
  const entry = first.open * (1 + slip);
  const exit = last.close * (1 - slip);
  const qty = notional / entry;
  const net = (exit - entry) * qty - notional * fee - exit * qty * fee;
  return { net_pnl: Number(net.toFixed(6)), net_return_pct: Number((net / initial * 100).toFixed(4)) };
}

export function runStrategyTournament({
  candles1h, candles6h, options = {}, startIndex = 100, endIndex
}) {
  const oneHourInput = normalizeBars(candles1h, HOUR_MS);
  const sixHourInput = normalizeBars(candles6h, SIX_HOUR_MS);
  if (oneHourInput.issues.length || sixHourInput.issues.length) {
    return {
      ok: false,
      reason: "invalid_candle_history",
      issues_1h: oneHourInput.issues,
      issues_6h: sixHourInput.issues,
      bars_1h: oneHourInput.rows.length,
      bars_6h: sixHourInput.rows.length
    };
  }
  const oneHour = oneHourInput.rows;
  const sixHour = sixHourInput.rows;
  if (oneHour.length < 150 || sixHour.length < 50) {
    return { ok: false, reason: "insufficient_clean_history", bars_1h: oneHour.length, bars_6h: sixHour.length };
  }
  const settings = { ...DEFAULTS, ...options };
  if (![settings.initialEquity, settings.allocationPct, settings.feeBpsPerSide,
    settings.slippageBps, settings.maxBarsInTrade].every(Number.isFinite) ||
    settings.initialEquity <= 0 || settings.allocationPct <= 0 || settings.allocationPct > 0.25 ||
    settings.feeBpsPerSide < 0 || settings.slippageBps < 0 || settings.maxBarsInTrade < 1) {
    return { ok: false, reason: "invalid_backtest_options" };
  }
  const finish = Math.min(Number.isInteger(endIndex) ? endIndex : oneHour.length, oneHour.length);
  const start = Math.max(50, Math.floor(startIndex));
  if (finish - start < 20) return { ok: false, reason: "evaluation_window_too_short" };
  const featureRows = features(oneHour, sixHour);
  const strategies = ["trend_continuation", "range_mean_reversion", "breakout_continuation"];
  const results = Object.fromEntries(strategies.map((name) => {
    const result = simulate(name, oneHour, featureRows, settings, start, finish);
    if (options.includeMonteCarlo === true) {
      const strategySeed = settings.monteCarloSeed +
        name.split("").reduce((sum, character) => sum + character.charCodeAt(0), 0) +
        result.trades.length;
      result.monte_carlo = runTradeOrderMonteCarlo(
        result.trades.map((trade) => trade.net_return_on_entry_equity_pct),
        {
          initialEquity: settings.initialEquity,
          iterations: settings.monteCarloIterations,
          blockLength: settings.monteCarloBlockLength,
          minimumTrades: settings.minimumMonteCarloTrades,
          seed: strategySeed
        }
      );
    }
    return [name, result];
  }));
  return {
    ok: true,
    mode: "offline_research_only",
    bars_1h: oneHour.length,
    bars_6h: sixHour.length,
    window: { start_index: start, end_index_exclusive: finish },
    assumptions: {
      initial_equity: settings.initialEquity,
      allocation_pct: settings.allocationPct * 100,
      fee_bps_per_side: settings.feeBpsPerSide,
      slippage_bps_per_side: settings.slippageBps,
      next_bar_open_fills: true,
      intrabar_stop_target_conflict: "stop_first",
      max_bars_in_trade: settings.maxBarsInTrade
    },
    cash_no_trade: { net_pnl: 0, net_return_pct: 0 },
    benchmark: buyAndHold(oneHour, settings, start, finish),
    strategies: results
  };
}

export function runWalkForwardResearch({ candles1h, candles6h, options = {} }) {
  const oneHourInput = normalizeBars(candles1h, HOUR_MS);
  const sixHourInput = normalizeBars(candles6h, SIX_HOUR_MS);
  if (oneHourInput.issues.length || sixHourInput.issues.length) {
    return {
      ok: false,
      reason: "invalid_candle_history",
      issues_1h: oneHourInput.issues,
      issues_6h: sixHourInput.issues,
      bars_1h: oneHourInput.rows.length,
      bars_6h: sixHourInput.rows.length
    };
  }
  const oneHour = oneHourInput.rows;
  const sixHour = sixHourInput.rows;
  const minimumOneHourBars = 3000;
  const minimumSixHourBars = 500;
  const initialWarmupBars = 300;
  const minimumFoldBars = 672; // 28 days of non-overlapping hourly test data.
  if (oneHour.length < minimumOneHourBars || sixHour.length < minimumSixHourBars) {
    return {
      ok: false,
      reason: "need_at_least_3000_clean_1h_and_500_clean_6h_bars_for_four_28d_folds",
      bars_1h: oneHour.length,
      bars_6h: sixHour.length,
      required_bars_1h: minimumOneHourBars,
      required_bars_6h: minimumSixHourBars
    };
  }

  // Require 50 completed 6H bars before the first evaluation bar. If the two
  // archives begin at different times, move the test window forward instead
  // of silently evaluating with an incomplete higher-timeframe warmup.
  const sixHourWarmupEndMs = sixHour[49].time + SIX_HOUR_MS;
  let firstEvaluation = initialWarmupBars;
  while (firstEvaluation < oneHour.length &&
      oneHour[firstEvaluation].time < sixHourWarmupEndMs) firstEvaluation += 1;
  const available = oneHour.length - firstEvaluation;
  const foldSize = Math.floor(available / 4);
  if (foldSize < minimumFoldBars) {
    return {
      ok: false,
      reason: "walk_forward_folds_require_at_least_28_days_each",
      fold_bars: foldSize,
      required_fold_bars: minimumFoldBars
    };
  }
  const folds = [];
  for (let index = 0; index < 4; index += 1) {
    const start = firstEvaluation + index * foldSize;
    const end = index === 3 ? oneHour.length : start + foldSize;
    const result = runStrategyTournament({
      candles1h: oneHour, candles6h: sixHour, options,
      startIndex: start, endIndex: end
    });
    folds.push({
      name: index === 3 ? "untouched_holdout" : `walk_forward_${index + 1}`,
      start_index: start,
      end_index_exclusive: end,
      results: result.ok ? result.strategies : null,
      benchmark: result.ok ? result.benchmark : null,
      ok: result.ok
    });
  }
  const stress = [1, 1.5, 2].map((multiplier) => ({
    cost_multiplier: multiplier,
    result: runStrategyTournament({
      candles1h: oneHour, candles6h: sixHour, options: {
        ...options,
        feeBpsPerSide: (options.feeBpsPerSide ?? DEFAULTS.feeBpsPerSide) * multiplier,
        slippageBps: (options.slippageBps ?? DEFAULTS.slippageBps) * multiplier
      },
      startIndex: firstEvaluation, endIndex: oneHour.length
    })
  }));
  const strategySamples = Object.fromEntries(
    ["trend_continuation", "range_mean_reversion", "breakout_continuation"].map((name) => {
      const oosTrades = folds.reduce((sum, fold) => sum + Number(fold.results?.[name]?.trade_count || 0), 0);
      const testFolds = folds.filter((fold) => fold.ok).length;
      return [name, {
        non_overlapping_test_folds: testFolds,
        out_of_sample_trade_count: oosTrades,
        minimum_trade_sample: 30,
        sample_status: oosTrades >= 30 ? "minimum_sample_met_research_only" : "insufficient_out_of_sample_trades"
      }];
    })
  );
  return {
    ok: folds.every((fold) => fold.ok) && stress.every((item) => item.result.ok),
    mode: "offline_research_only",
    validation: "chronological_non_overlapping_folds_no_random_shuffle",
    warmup_bars: firstEvaluation,
    fold_bars: foldSize,
    approximate_test_days_per_fold: Number((foldSize / 24).toFixed(1)),
    strategy_samples: strategySamples,
    folds,
    cost_stress: stress,
    warning: "Exploratory screening only. Every strategy remains research-only; passing these checks does not authorize automatic PAPER entries or live execution."
  };
}
