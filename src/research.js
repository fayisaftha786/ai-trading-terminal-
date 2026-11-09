export function selectNewClosedCandles(rows, latestStoredMs, intervalMs, nowMs = Date.now()) {
  if (!Array.isArray(rows) || !Number.isFinite(intervalMs) || intervalMs <= 0 || !Number.isFinite(nowMs)) return [];
  const latest = Number.isFinite(latestStoredMs) ? latestStoredMs : Number.NEGATIVE_INFINITY;
  return rows
    .filter((row) => Number.isFinite(row?.time) &&
      row.time % intervalMs === 0 &&
      row.time > latest &&
      row.time + intervalMs <= nowMs)
    .sort((a, b) => a.time - b.time);
}

export function countMissingArchiveBars(previousLastMs, newRows, intervalMs) {
  if (!Number.isFinite(previousLastMs) || !Array.isArray(newRows) || !newRows.length ||
      !Number.isFinite(intervalMs) || intervalMs <= 0) return 0;
  const firstNewMs = Number(newRows[0]?.time);
  const distance = firstNewMs - previousLastMs;
  if (!Number.isFinite(firstNewMs) || distance <= 0) return 0;
  if (distance % intervalMs !== 0) return null;
  return Math.max(0, Math.round(distance / intervalMs) - 1);
}

export function buildResearchHistorySummary(records, nowMs = Date.now()) {
  if (!Array.isArray(records) || !Number.isFinite(nowMs)) return [];
  return records.map((record) => {
    const intervalSeconds = Number(record.timeframe_seconds);
    const intervalMs = intervalSeconds * 1000;
    const bars = Math.max(0, Number(record.bars_count) || 0);
    const firstValue = record.first_candle_ms;
    const lastValue = record.last_candle_ms;
    const first = firstValue == null ? null : (Number.isFinite(Number(firstValue)) ? Number(firstValue) : null);
    const last = lastValue == null ? null : (Number.isFinite(Number(lastValue)) ? Number(lastValue) : null);
    const aligned = first === null || last === null || (last >= first && (last - first) % intervalMs === 0);
    const expected = aligned && first !== null && last !== null
      ? Math.floor((last - first) / intervalMs) + 1 : null;
    const retainedMissing = expected === null ? null : Math.max(0, expected - bars);
    const latestClosedAt = last === null ? null : last + intervalMs;
    const rawAge = latestClosedAt === null ? null : nowMs - latestClosedAt;
    const ageMinutes = rawAge === null || rawAge < 0 ? null : Math.floor(rawAge / 60000);
    const coverageDays = expected === null || expected <= 0 ? 0 : (last - first + intervalMs) / 86400000;
    const quality = String(record.last_quality_status || "not_started");
    return {
      exchange: String(record.exchange || "coinbase_exchange"),
      product: String(record.product || ""),
      symbol: String(record.product || "").replace("-", "/"),
      timeframe_seconds: intervalSeconds,
      timeframe: intervalSeconds === 3600 ? "1H" : intervalSeconds === 21600 ? "6H" : intervalSeconds + "s",
      bars_count: bars,
      first_candle_ms: first,
      last_candle_ms: last,
      latest_closed_at_ms: latestClosedAt,
      latest_age_minutes: ageMinutes,
      coverage_days: Number(coverageDays.toFixed(2)),
      retained_missing_intervals: retainedMissing,
      cumulative_missing_intervals: Math.max(0, Number(record.cumulative_missing_intervals) || 0),
      last_quality_status: aligned ? quality : "archive_integrity_error",
      last_quality_check_at_ms: record.last_quality_check_at_ms == null ? null
        : (Number.isFinite(Number(record.last_quality_check_at_ms)) ? Number(record.last_quality_check_at_ms) : null),
      last_ingested_at_ms: record.last_ingested_at_ms == null ? null
        : (Number.isFinite(Number(record.last_ingested_at_ms)) ? Number(record.last_ingested_at_ms) : null)
    };
  }).sort((a, b) => a.product.localeCompare(b.product) || a.timeframe_seconds - b.timeframe_seconds);
}
