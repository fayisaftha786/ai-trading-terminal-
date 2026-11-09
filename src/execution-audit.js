function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function parseMetadata(row) {
  if (row?.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)) return row.metadata;
  if (typeof row?.metadata_json === "string") {
    try {
      const parsed = JSON.parse(row.metadata_json);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
  }
  return {};
}

function average(values) {
  return values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4)) : null;
}

/** Summarize modeled execution evidence stored with PAPER trades; these are never exchange-reported fills. */
export function summarizePaperExecution(rows) {
  const input = Array.isArray(rows) ? rows.filter((row) => row && typeof row === "object") : [];
  const spreads = [], entrySlippage = [], exitSlippage = [], roundTripCosts = [];
  for (const row of input) {
    const metadata = parseMetadata(row);
    let spread = finiteNonNegative(metadata.entry_spread_bps ?? metadata.spread_bps);
    if (spread === null) {
      const bid = Number(metadata.entry_quote_bid), ask = Number(metadata.entry_quote_ask);
      if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask >= bid) {
        const mid = (bid + ask) / 2;
        spread = mid > 0 ? ((ask - bid) / mid) * 10000 : null;
      }
    }
    if (spread !== null) spreads.push(spread);
    const entrySlip = finiteNonNegative(metadata.entry_slippage_bps ?? metadata.slippage_bps);
    if (entrySlip !== null) entrySlippage.push(entrySlip);
    const exitSlip = finiteNonNegative(metadata.exit_slippage_bps ??
      (row.status === "CLOSED" ? metadata.slippage_bps : null));
    if (exitSlip !== null && row.status === "CLOSED") exitSlippage.push(exitSlip);
    const roundTrip = finiteNonNegative(metadata.round_trip_cost_bps);
    if (roundTrip !== null) roundTripCosts.push(roundTrip);
  }
  return {
    scope: "latest_1000_recorded_paper_trades",
    scope_count: input.length,
    sample_count: input.length,
    entry_spread_sample_count: spreads.length,
    average_entry_spread_bps: average(spreads),
    entry_slippage_sample_count: entrySlippage.length,
    average_entry_slippage_bps: average(entrySlippage),
    exit_slippage_sample_count: exitSlippage.length,
    average_exit_slippage_bps: average(exitSlippage),
    round_trip_cost_sample_count: roundTripCosts.length,
    average_estimated_round_trip_cost_bps: average(roundTripCosts),
    note: "Paper execution model only; no exchange order fills or realized market impact are measured."
  };
}
