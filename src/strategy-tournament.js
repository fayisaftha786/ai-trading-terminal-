const HOUR_MS = 3600000;
const SIX_HOUR_MS = 6 * HOUR_MS;
const DEFAULTS = Object.freeze({
  initialEquity: 100,
  allocationPct: 0.1,
  feeBpsPerSide: 15,
  slippageBps: 10,
  maxBarsInTrade: 72
});

function finiteBar(row) {
  return row && [row.time, row.open, row.high, row.low, row.close, row.volume]
    .every((value) => Number.isFinite(Number(value))) &&
    Number(row.open) > 0 && Number(row.high) >= Math.max(Number(row.open), Number(row.close), Number(row.low)) &&
    Number(row.low) <= Math.min(Number(row.open), Number(row.close), Number(row.high)) &&
    Number(row.volume) >= 0;
}

function normalizeBars(input, intervalMs) {
  if (!Array.isArray(input)) return [];
  const rows = input.filter(finiteBar).map((row) => ({
    time: Number(row.time), open: Number(row.open), high: Number(row.high),
    low: Number(row.low), close: Number(row.close), volume: Number(row.volume)
  })).sort((a, b) => a.time - b.time);
  const unique = [];
  for (const row of rows) {
    if (row.time % intervalMs !== 0) continue;
    if (unique.length && row.time === unique.at(-1).time) continue;
    if (unique.length && row.time - unique.at(-1).time !== intervalMs) return [];
    unique.push(row);
  }
  return unique;
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
  return {
    trade_count: trades.length,
    win_rate_pct: trades.length ? Number((wins.length / trades.length * 100).toFixed(2)) : null,
    net_pnl: Number((finalEquity - initialEquity).toFixed(6)),
    net_return_pct: Number(((finalEquity / initialEquity - 1) * 100).toFixed(4)),
    profit_factor: grossLosses > 0 ? Number((grossWins / grossLosses).toFixed(4)) : (grossWins > 0 ? null : 0),
    expectancy_per_trade: trades.length ? Number((trades.reduce((sum, trade) => sum + trade.netPnl, 0) / trades.length).toFixed(6)) : null,
    max_drawdown_pct: Number(maxDrawdownPct.toFixed(4)),
    average_hold_bars: trades.length ? Number(mean(trades.map((trade) => trade.holdBars)).toFixed(2)) : null,
    exposure_pct: equityCurve.length ? Number((equityCurve.filter((value, index) => index > 0 && value !== equityCurve[index - 1]).length / equityCurve.length * 100).toFixed(2)) : 0
  };
}

function simulate(name, bars, featureRows, options, startIndex, endIndex) {
  const initialEquity = options.initialEquity;
  let equity = initialEquity;
  let position = null;
  const trades = [];
  const curve = [];
  const feeRate = options.feeBpsPerSide / 10000;
  const slipRate = options.slippageBps / 10000;
  const allocation = options.allocationPct;
  const finish = Math.min(endIndex, bars.length - 1);

  function closePosition(rawPrice, index, reason, gap = false) {
    const fillPrice = rawPrice * (1 - slipRate);
    const exitNotional = position.quantity * fillPrice;
    const exitFee = exitNotional * feeRate;
    const gross = (fillPrice - position.entryFill) * position.quantity;
    const net = gross - position.entryFee - exitFee;
    equity += net;
    trades.push({
      entry_time: new Date(position.entryTime).toISOString(),
      exit_time: new Date(bars[index].time).toISOString(),
      entry_price: Number(position.entryFill.toFixed(8)),
      exit_price: Number(fillPrice.toFixed(8)),
      quantity: Number(position.quantity.toFixed(8)),
      netPnl: Number(net.toFixed(8)),
      fees: Number((position.entryFee + exitFee).toFixed(8)),
      holdBars: index - position.entryIndex + 1,
      exit_reason: reason,
      conservative_stop_first: Boolean(gap)
    });
    position = null;
  }

  for (let i = startIndex; i <= finish; i += 1) {
    const bar = bars[i];
    if (position) {
      if (bar.open <= position.stop) {
        closePosition(bar.open, i, "stop_gap", true);
      } else if (bar.open >= position.target) {
        closePosition(position.target, i, "target_gap");
      } else {
        const stopHit = bar.low <= position.stop;
        const targetHit = Number.isFinite(position.target) && bar.high >= position.target;
        if (stopHit) closePosition(position.stop, i, "stop", targetHit);
        else if (targetHit) closePosition(position.target, i, "target");
        else if (i - position.entryIndex >= options.maxBarsInTrade) {
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
            entryFill, quantity, entryFee, stop, target,
            entryTime: next.time, entryIndex: i + 1, reason: signal.reason
          };
        }
      }
    }
    const mark = position ? position.quantity * bar.close + (equity - position.entryFee) : equity;
    curve.push(mark);
  }
  if (position) closePosition(bars[finish].close, finish, "end_of_window");
  const finalEquity = equity;
  return { ...metrics(trades, curve, initialEquity, finalEquity), trades };
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
  const oneHour = normalizeBars(candles1h, HOUR_MS);
  const sixHour = normalizeBars(candles6h, SIX_HOUR_MS);
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
  const results = Object.fromEntries(strategies.map((name) => [
    name, simulate(name, oneHour, featureRows, settings, start, finish)
  ]));
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
    benchmark: buyAndHold(oneHour, settings, start, finish),
    strategies: results
  };
}

export function runWalkForwardResearch({ candles1h, candles6h, options = {} }) {
  const oneHour = normalizeBars(candles1h, HOUR_MS);
  const sixHour = normalizeBars(candles6h, SIX_HOUR_MS);
  if (oneHour.length < 300 || sixHour.length < 50) {
    return { ok: false, reason: "need_at_least_300_clean_1h_and_50_clean_6h_bars",
      bars_1h: oneHour.length, bars_6h: sixHour.length };
  }
  const firstEvaluation = 100;
  const available = oneHour.length - firstEvaluation;
  const foldSize = Math.floor(available / 4);
  if (foldSize < 20) return { ok: false, reason: "walk_forward_folds_too_short" };
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
  return {
    ok: folds.every((fold) => fold.ok) && stress.every((item) => item.result.ok),
    mode: "offline_research_only",
    validation: "chronological_non_overlapping_folds_no_random_shuffle",
    warmup_bars: firstEvaluation,
    folds,
    cost_stress: stress,
    warning: "Exploratory backtest only. No strategy is approved for automatic paper entries or live execution."
  };
}
