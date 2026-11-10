import { analyzeTimeframe, ema } from "./strategy.js";

// Conservative public-tier assumption for Coinbase Exchange spot research.
// Replace only after the account's actual maker/taker tier is verified.
export const DEFAULT_MICRO_SCALP_COSTS = Object.freeze({
  feeBpsPerSide: 60,
  slippageBpsPerSide: 10,
  minimumNetEdgeBps: 5,
  minimumCostMultiple: 1.5,
  maximumSpreadBps: 8,
  minimumBookDepthUsd: 5000,
  minimumQuoteVolumeUsd: 1000000
});

function isFreshTimestamp(value, nowMs, maximumAgeMs) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return false;
  const age = nowMs - timestamp;
  return age >= -1000 && age <= maximumAgeMs;
}

function average(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function round(value, places = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(places)) : null;
}

/**
 * Explainable long-only micro-scalp research gate.
 *
 * Setup: validated closed 5m trend.
 * Trigger: validated closed 1m breakout + EMA alignment + relative volume.
 * Context: 1h and 6h trend agreement.
 * Execution: deliberately NOT connected to the PAPER or live order path.
 *
 * The gross target is an ATR-derived research estimate, not a price forecast.
 * A candidate is rejected unless that estimate comfortably exceeds taker fees,
 * the observed full spread and a slippage allowance on both sides.
 */
export function evaluateMicroScalpResearch({
  oneMinuteAudit,
  fiveMinuteAudit,
  market,
  primary,
  higher,
  nowMs = Date.now(),
  costs = {}
} = {}) {
  const config = { ...DEFAULT_MICRO_SCALP_COSTS, ...costs };
  const base = {
    mode: "research_only",
    strategy_id: "micro_scalp_1m_trigger_5m_setup_v1",
    execution_authorized: false,
    paper_auto_entry_eligible: false,
    live_trading_enabled: false,
    score_is_probability: false,
    cost_assumption: {
      fee_bps_per_side: config.feeBpsPerSide,
      slippage_bps_per_side: config.slippageBpsPerSide,
      minimum_cost_multiple: config.minimumCostMultiple,
      minimum_net_edge_bps: config.minimumNetEdgeBps
    }
  };
  const block = (reason, extra = {}) => ({
    ...base,
    status: "blocked",
    decision: "NO_TRADE",
    reason,
    ...extra
  });

  if (!Number.isFinite(nowMs)) return block("invalid_evaluation_time");
  if (!oneMinuteAudit?.ok || !fiveMinuteAudit?.ok ||
      !Array.isArray(oneMinuteAudit.rows) || !Array.isArray(fiveMinuteAudit.rows) ||
      oneMinuteAudit.rows.length < 150 || fiveMinuteAudit.rows.length < 150) {
    return block("one_minute_or_five_minute_candle_integrity_failed", {
      one_minute_issues: oneMinuteAudit?.issues || [],
      five_minute_issues: fiveMinuteAudit?.issues || []
    });
  }

  const numericCosts = [
    config.feeBpsPerSide, config.slippageBpsPerSide,
    config.minimumNetEdgeBps, config.minimumCostMultiple,
    config.maximumSpreadBps, config.minimumBookDepthUsd,
    config.minimumQuoteVolumeUsd
  ];
  if (!numericCosts.every((value) => Number.isFinite(value) && value >= 0) ||
      config.minimumCostMultiple < 1) {
    return block("micro_scalp_cost_configuration_invalid");
  }

  if (market?.status !== "live" ||
      typeof market.market_data_provider !== "string" ||
      !market.market_data_provider) {
    return block("market_snapshot_unavailable");
  }
  const dataQuality = market.data_quality || {};
  const requiredProviders = [
    dataQuality.ticker_provider,
    dataQuality.book_provider,
    dataQuality.one_minute_provider,
    dataQuality.five_minute_provider
  ];
  if (requiredProviders.some((provider) => provider !== market.market_data_provider)) {
    return block("micro_scalp_provider_mismatch_or_unknown");
  }

  if (!isFreshTimestamp(market.quote_received_at_ms, nowMs, 120000) ||
      !isFreshTimestamp(Date.parse(market.ticker_time || ""), nowMs, 120000)) {
    return block("ticker_quote_or_last_trade_stale");
  }
  if (!isFreshTimestamp(market.book_retrieved_at_ms, nowMs, 15000)) {
    return block("order_book_snapshot_stale_or_missing");
  }

  const oneMinuteLast = oneMinuteAudit.rows.at(-1);
  const fiveMinuteLast = fiveMinuteAudit.rows.at(-1);
  const oneMinuteCloseAt = Number(oneMinuteLast?.time) + 60000;
  const fiveMinuteCloseAt = Number(fiveMinuteLast?.time) + 300000;
  const oneMinuteAge = nowMs - oneMinuteCloseAt;
  const fiveMinuteAge = nowMs - fiveMinuteCloseAt;
  if (!Number.isFinite(oneMinuteAge) || oneMinuteAge < -1000 || oneMinuteAge > 120000) {
    return block("one_minute_closed_candle_stale");
  }
  if (!Number.isFinite(fiveMinuteAge) || fiveMinuteAge < -1000 || fiveMinuteAge > 7 * 60000) {
    return block("five_minute_closed_candle_stale");
  }
  if (fiveMinuteCloseAt > oneMinuteCloseAt + 60000) {
    return block("five_minute_context_from_future");
  }

  const primaryCloseAge = nowMs - (Number(primary?.last_closed_candle_ms) + 3600000);
  const higherCloseAge = nowMs - (Number(higher?.last_closed_candle_ms) + 21600000);
  if (!Number.isFinite(primaryCloseAge) || primaryCloseAge < -1000 || primaryCloseAge > 5400000 ||
      !Number.isFinite(higherCloseAge) || higherCloseAge < -1000 || higherCloseAge > 25200000) {
    return block("higher_timeframe_context_stale_or_missing");
  }
  if (primary?.regime !== "UPTREND" || higher?.regime !== "UPTREND") {
    return block("one_hour_and_six_hour_uptrend_not_aligned", {
      regime_1h: primary?.regime || "UNKNOWN",
      regime_6h: higher?.regime || "UNKNOWN"
    });
  }

  const bid = Number(market.bid);
  const ask = Number(market.ask);
  const quoteVolume = Number(market.quote_volume_usd);
  const spreadBps = Number(market.spread_bps);
  const bidDepth = Number(market.bid_depth_quote);
  const askDepth = Number(market.ask_depth_quote);
  if (![bid, ask, quoteVolume, spreadBps, bidDepth, askDepth].every(Number.isFinite) ||
      bid <= 0 || ask < bid || quoteVolume <= 0 || spreadBps < 0) {
    return block("quote_spread_depth_or_volume_invalid");
  }
  if (spreadBps > config.maximumSpreadBps) {
    return block("spread_above_micro_scalp_limit", { spread_bps: round(spreadBps) });
  }
  if (Math.min(bidDepth, askDepth) < config.minimumBookDepthUsd) {
    return block("top_of_book_depth_below_micro_scalp_limit", {
      bid_depth_usd: round(bidDepth),
      ask_depth_usd: round(askDepth)
    });
  }
  if (quoteVolume < config.minimumQuoteVolumeUsd) {
    return block("24h_quote_volume_below_micro_scalp_limit", {
      quote_volume_usd: round(quoteVolume)
    });
  }

  const fiveMinute = analyzeTimeframe(fiveMinuteAudit, 300000);
  const oneMinute = analyzeTimeframe(oneMinuteAudit, 60000);
  if (!Number.isFinite(fiveMinute.atr_pct) || !Number.isFinite(oneMinute.atr_pct)) {
    return block("micro_timeframe_indicator_warmup_failed");
  }
  if (fiveMinute.signal !== "BUY_CANDIDATE" || fiveMinute.regime !== "UPTREND" ||
      fiveMinute.adx14 < 18 || fiveMinute.plus_di14 <= fiveMinute.minus_di14 ||
      fiveMinute.rsi14 < 45 || fiveMinute.rsi14 > 68) {
    return block("five_minute_trend_setup_not_confirmed", {
      regime_5m: fiveMinute.regime,
      signal_5m: fiveMinute.signal,
      adx_5m: round(fiveMinute.adx14, 3),
      rsi_5m: round(fiveMinute.rsi14, 2)
    });
  }

  const oneMinuteRows = oneMinuteAudit.rows;
  const closes = oneMinuteRows.map((row) => Number(row.close));
  const highs = oneMinuteRows.map((row) => Number(row.high));
  const volumes = oneMinuteRows.map((row) => Number(row.volume));
  const fast = ema(closes, 9);
  const slow = ema(closes, 21);
  const previousHigh = Math.max(...highs.slice(-6, -1));
  const recentVolume = average(volumes.slice(-3));
  const baselineVolume = average(volumes.slice(-23, -3));
  const relativeVolume = baselineVolume > 0 ? recentVolume / baselineVolume : null;
  const breakout = Number(oneMinuteLast.close) > previousHigh &&
    Number(oneMinuteLast.close) > fast.at(-1) &&
    fast.at(-1) > slow.at(-1);
  if (!breakout || !Number.isFinite(relativeVolume) || relativeVolume < 1.2) {
    return block("one_minute_breakout_or_volume_trigger_not_confirmed", {
      breakout_confirmed: breakout,
      relative_volume_1m: round(relativeVolume, 4),
      regime_5m: fiveMinute.regime
    });
  }

  const roundTripCostBps = (2 * config.feeBpsPerSide) +
    (2 * config.slippageBpsPerSide) + spreadBps;
  const stopDistanceBps = Math.max(
    fiveMinute.atr_pct * 100,
    oneMinute.atr_pct * 150
  );
  const grossTargetBps = Math.max(
    fiveMinute.atr_pct * 200,
    oneMinute.atr_pct * 300
  );
  const netTargetBps = grossTargetBps - roundTripCostBps;
  const minimumGrossTargetBps = roundTripCostBps * config.minimumCostMultiple;
  if (!Number.isFinite(roundTripCostBps) || !Number.isFinite(stopDistanceBps) ||
      !Number.isFinite(grossTargetBps) || stopDistanceBps <= 0 || grossTargetBps <= 0) {
    return block("micro_scalp_expected_move_unavailable");
  }
  if (grossTargetBps < minimumGrossTargetBps || netTargetBps < config.minimumNetEdgeBps) {
    return block("round_trip_cost_exceeds_expected_move", {
      spread_bps: round(spreadBps),
      round_trip_cost_bps: round(roundTripCostBps),
      estimated_gross_target_bps: round(grossTargetBps),
      estimated_net_target_bps: round(netTargetBps),
      minimum_gross_target_bps: round(minimumGrossTargetBps)
    });
  }

  return {
    ...base,
    status: "research_candidate",
    decision: "RESEARCH_CANDIDATE",
    reason: "closed_1m_breakout_aligned_with_5m_1h_6h_trend_and_cost_gate",
    regime_1m: oneMinute.regime,
    regime_5m: fiveMinute.regime,
    regime_1h: primary.regime,
    regime_6h: higher.regime,
    relative_volume_1m: round(relativeVolume, 4),
    spread_bps: round(spreadBps),
    round_trip_cost_bps: round(roundTripCostBps),
    estimated_gross_target_bps: round(grossTargetBps),
    estimated_net_target_bps: round(netTargetBps),
    estimated_stop_distance_bps: round(stopDistanceBps),
    estimated_net_reward_to_risk: round(netTargetBps / (stopDistanceBps + roundTripCostBps), 3),
    last_closed_1m_candle_ms: Number(oneMinuteLast.time),
    last_closed_5m_candle_ms: Number(fiveMinuteLast.time),
    entry_reference_price: round(ask, 8),
    ranking_method: "fixed transparent rules and ATR estimates; not trained or calibrated",
    warning: "A candidate is not a fill, backtest result, profit probability, or trade authorization."
  };
}
