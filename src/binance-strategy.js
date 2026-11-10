import { analyzeTimeframe, auditCandles, classifyMarketRegime } from "./strategy.js";

export const BINANCE_STRATEGY_INTERVALS = Object.freeze({
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000
});
export const BINANCE_STRATEGY_BATCH_LIMIT = 50;
const MINIMUM_BARS = 150;

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function normalizeBinanceKlines(input) {
  if (!Array.isArray(input)) return [];
  return input.map((row) => {
    if (!Array.isArray(row) || row.length < 6) return null;
    const values = [row[0], row[1], row[2], row[3], row[4], row[5]].map(Number);
    if (!values.every(Number.isFinite)) return null;
    return {
      time: values[0],
      open: values[1],
      high: values[2],
      low: values[3],
      close: values[4],
      volume: values[5]
    };
  }).filter(Boolean);
}

export function shouldRefreshBinanceCandleCache(input, intervalMs, nowMs = Date.now()) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0 || !Number.isFinite(nowMs)) return true;
  const rows = normalizeBinanceKlines(input);
  const audit = auditCandles(rows, intervalMs, nowMs, MINIMUM_BARS);
  if (!audit.ok) return true;
  const expectedLatestClosedOpenMs = Math.floor(nowMs / intervalMs) * intervalMs - intervalMs;
  const actualLatestClosedOpenMs = audit.rows.at(-1)?.time;
  return !Number.isFinite(actualLatestClosedOpenMs) || actualLatestClosedOpenMs < expectedLatestClosedOpenMs;
}

function bookSideQuote(levels) {
  if (!Array.isArray(levels)) return null;
  const total = levels.slice(0, 20).reduce((sum, level) => {
    const price = Number(level?.[0]);
    const quantity = Number(level?.[1]);
    return Number.isFinite(price) && price > 0 &&
      Number.isFinite(quantity) && quantity > 0
      ? sum + price * quantity : sum;
  }, 0);
  return Number.isFinite(total) && total > 0 ? total : null;
}

export function analyzeBinanceMultiTimeframeMarket({
  symbol,
  ticker,
  depth,
  candlesByInterval,
  nowMs = Date.now(),
  costs = {},
  portfolioBlockReasons = [],
  symbolBlockReasons = []
}) {
  const normalizedSymbol = String(symbol || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{1,18}USDT$/.test(normalizedSymbol)) {
    return { symbol: normalizedSymbol, status: "rejected", signal: "HOLD", block_reasons: ["invalid_spot_symbol"] };
  }

  const marketSymbol = normalizedSymbol.slice(0, -4) + "/USDT";
  const bid = positive(ticker?.bidPrice);
  const ask = positive(ticker?.askPrice);
  const last = positive(ticker?.lastPrice);
  const quoteVolume = positive(ticker?.quoteVolume) || 0;
  // Binance 24h ticker closeTime is the rolling-window boundary, not the
  // timestamp of the last execution. Do not use it as last-trade freshness.
  const mid = bid !== null && ask !== null && ask >= bid ? (bid + ask) / 2 : null;
  const spreadBps = mid ? ((ask - bid) / mid) * 10_000 : null;
  const bidDepthQuote = bookSideQuote(depth?.bids);
  const askDepthQuote = bookSideQuote(depth?.asks);

  const analyses = {};
  const audits = {};
  for (const [label, intervalMs] of Object.entries(BINANCE_STRATEGY_INTERVALS)) {
    const rows = normalizeBinanceKlines(candlesByInterval?.[label]);
    const audit = auditCandles(rows, intervalMs, nowMs, MINIMUM_BARS);
    audits[label] = audit;
    analyses[label] = analyzeTimeframe(audit);
  }

  const latestClosed = Object.fromEntries(
    Object.entries(audits).map(([label, audit]) => [label, audit.rows.at(-1)?.time ?? null])
  );
  const candleAgeMs = Object.fromEntries(
    Object.entries(BINANCE_STRATEGY_INTERVALS).map(([label, intervalMs]) => [
      label,
      Number.isFinite(latestClosed[label])
        ? Math.max(0, nowMs - (latestClosed[label] + intervalMs))
        : null
    ])
  );

  const feeBpsPerSide = Number.isFinite(Number(costs.feeBpsPerSide))
    ? Math.min(100, Math.max(0, Number(costs.feeBpsPerSide))) : 10;
  const slippageBpsPerSide = Number.isFinite(Number(costs.slippageBps))
    ? Math.min(100, Math.max(0, Number(costs.slippageBps))) : 5;
  const roundTripCostBps = spreadBps === null
    ? null : (2 * (feeBpsPerSide + slippageBpsPerSide)) + spreadBps;
  const atrPct = analyses["1h"]?.atr_pct;
  const grossTargetBps = Number.isFinite(atrPct) ? atrPct * 100 * 2.25 : null;
  const initialRiskBps = Number.isFinite(atrPct) ? atrPct * 100 * 1.5 : null;
  const netExpectedEdgeBps = Number.isFinite(grossTargetBps) && Number.isFinite(roundTripCostBps)
    ? grossTargetBps - roundTripCostBps : null;
  const netRewardRisk = Number.isFinite(netExpectedEdgeBps) && Number.isFinite(initialRiskBps) &&
    initialRiskBps + roundTripCostBps > 0
    ? netExpectedEdgeBps / (initialRiskBps + roundTripCostBps) : null;

  const trendAligned = ["15m", "1h", "4h"].every((label) =>
    analyses[label]?.signal === "BUY_CANDIDATE" &&
    analyses[label]?.regime === "UPTREND" &&
    analyses[label]?.score >= 75
  );
  const score = Math.round(
    (Number(analyses["15m"]?.score || 0) * 0.2) +
    (Number(analyses["1h"]?.score || 0) * 0.35) +
    (Number(analyses["4h"]?.score || 0) * 0.45)
  );
  const regime4h = audits["4h"]?.ok
    ? classifyMarketRegime(audits["4h"], BINANCE_STRATEGY_INTERVALS["4h"])
    : { status: "unavailable", regime: "UNCLASSIFIED", direction: "UNKNOWN" };

  const dataChecks = {
    closed_15m_history: audits["15m"]?.ok === true,
    closed_1h_history: audits["1h"]?.ok === true,
    closed_4h_history: audits["4h"]?.ok === true,
    fresh_15m_candle: Number.isFinite(candleAgeMs["15m"]) && candleAgeMs["15m"] <= 25 * 60_000,
    fresh_1h_candle: Number.isFinite(candleAgeMs["1h"]) && candleAgeMs["1h"] <= 75 * 60_000,
    fresh_4h_candle: Number.isFinite(candleAgeMs["4h"]) && candleAgeMs["4h"] <= 5 * 60 * 60_000,
    valid_two_sided_quote: bid !== null && ask !== null && ask >= bid && last !== null,
    active_24h_trade_count: Number.isFinite(Number(ticker?.count)) && Number(ticker.count) >= 250
  };
  const liquidityChecks = {
    quote_volume_24h: quoteVolume >= 5_000_000,
    spread: Number.isFinite(spreadBps) && spreadBps <= 15,
    bid_depth: Number.isFinite(bidDepthQuote) && bidDepthQuote >= 5_000,
    ask_depth: Number.isFinite(askDepthQuote) && askDepthQuote >= 5_000
  };
  const edgeChecks = {
    fee_and_slippage_model: roundTripCostBps !== null,
    positive_net_edge: Number.isFinite(netExpectedEdgeBps) && netExpectedEdgeBps >= Math.max(20, (roundTripCostBps || 0) * 1.5),
    net_reward_risk: Number.isFinite(netRewardRisk) && netRewardRisk >= 1.1,
    volatility_in_range: Number.isFinite(atrPct) && atrPct >= 0.15 && atrPct <= 4.5
  };

  const blockReasons = [];
  for (const [key, passed] of Object.entries(dataChecks)) if (!passed) blockReasons.push(key);
  for (const [key, passed] of Object.entries(liquidityChecks)) if (!passed) blockReasons.push(key);
  for (const [key, passed] of Object.entries(edgeChecks)) if (!passed) blockReasons.push(key);
  if (!trendAligned) blockReasons.push("multi_timeframe_trend_not_aligned");
  for (const reason of [...portfolioBlockReasons, ...symbolBlockReasons]) {
    if (typeof reason === "string" && reason) blockReasons.push(reason);
  }

  const signal = trendAligned ? "LONG_CANDIDATE" : "HOLD";
  const paperReviewReady = signal === "LONG_CANDIDATE" && blockReasons.length === 0;
  return {
    symbol: marketSymbol,
    binance_symbol: normalizedSymbol,
    status: Object.values(audits).every((audit) => audit.ok) ? "analyzed" : "data_quality_blocked",
    signal,
    composite_score: score,
    score_is_probability: false,
    multi_timeframe: Object.fromEntries(
      Object.entries(analyses).map(([label, analysis]) => [label, {
        signal: analysis.signal,
        score: analysis.score,
        regime: analysis.regime,
        rsi14: analysis.rsi14 ?? null,
        adx14: analysis.adx14 ?? null,
        atr_pct: analysis.atr_pct ?? null,
        relative_volume: analysis.volume_ratio_20 ?? null,
        last_closed_candle_ms: analysis.last_closed_candle_ms ?? null,
        candle_age_ms: candleAgeMs[label],
        audit_ok: audits[label].ok,
        audit_issues: audits[label].issues
      }])
    ),
    market_quality: {
      last: last,
      bid,
      ask,
      spread_bps: Number.isFinite(spreadBps) ? Number(spreadBps.toFixed(2)) : null,
      quote_volume_24h_usdt: quoteVolume,
      bid_depth_top20_usdt: bidDepthQuote,
      ask_depth_top20_usdt: askDepthQuote,
      trade_count_24h: Number.isFinite(Number(ticker?.count)) ? Number(ticker.count) : null,
      quote_snapshot_evaluated_at_ms: nowMs
    },
    market_regime_4h: regime4h,
    cost_model: {
      fee_bps_per_side: feeBpsPerSide,
      slippage_bps_per_side: slippageBpsPerSide,
      spread_bps: spreadBps,
      round_trip_cost_bps: roundTripCostBps,
      gross_target_bps: grossTargetBps,
      estimated_net_edge_bps: netExpectedEdgeBps,
      estimated_net_reward_risk: netRewardRisk,
      assumptions: "Configured paper fee/slippage plus current Binance top-of-book spread; not a guaranteed fill or profit estimate."
    },
    risk_check: {
      passed: blockReasons.length === 0 && trendAligned,
      data_checks: dataChecks,
      liquidity_checks: liquidityChecks,
      edge_checks: edgeChecks,
      block_reasons: [...new Set(blockReasons)]
    },
    paper_trade: {
      status: paperReviewReady ? "PAPER_REVIEW_READY" : "BLOCKED",
      requires_owner_confirmation: true,
      order_created: false,
      auto_entry_enabled_by_this_engine: false,
      note: paperReviewReady
        ? "Passed research, data, liquidity and estimated-cost gates. Ready for a separate paper-ledger review; no trade has been placed."
        : "No paper trade. At least one strategy, data-quality, liquidity, cost or portfolio gate did not pass."
    },
    warning: "Deterministic multi-timeframe research filters, not a trained model or calibrated probability. Historical indicators cannot guarantee future returns."
  };
}
