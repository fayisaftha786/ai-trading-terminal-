const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const LIVE_PREVIEW_TTL_MS = 120000;

export function createServerBoundPreview(previews, result, token, nowMs = Date.now()) {
  if (!result || result.status !== "preview_ready" ||
      typeof token !== "string" || !UUID_V4.test(token) ||
      !Number.isFinite(nowMs)) {
    return { ok: false, reason: "server_preview_inputs_invalid", previews: Array.isArray(previews) ? previews : [] };
  }
  const rows = Array.isArray(previews) ? previews : [];
  const retained = rows.filter((item) =>
    item && item.status === "READY" && Number(item.expires_at_ms) > nowMs
  ).slice(-99);
  const record = {
    token,
    status: "READY",
    created_at_ms: nowMs,
    expires_at_ms: nowMs + LIVE_PREVIEW_TTL_MS,
    product_id: result.product_id,
    side: result.side,
    quote_size: result.quote_size || null,
    base_size: result.base_size || null,
    limit_price: result.limit_price,
    commission_total: result.commission_total,
    coinbase_preview_id: result.preview_id,
    quote_currency: result.quote_currency || null,
    base_currency: result.base_currency || null
  };
  retained.push(record);
  return { ok: true, record, previews: retained };
}

export function consumeServerBoundPreview(previews, token, clientOrderId, nowMs = Date.now()) {
  const rows = Array.isArray(previews) ? previews.slice() : [];
  if (typeof token !== "string" || !UUID_V4.test(token) ||
      typeof clientOrderId !== "string" || !/^[A-Za-z0-9-]{16,64}$/.test(clientOrderId) ||
      !Number.isFinite(nowMs)) {
    return { ok: false, reason: "server_preview_consume_inputs_invalid", previews: rows };
  }
  const index = rows.findIndex((item) => item?.token === token);
  if (index < 0) return { ok: false, reason: "server_bound_preview_not_found", previews: rows };
  const record = rows[index];
  if (record.status !== "READY") {
    return { ok: false, reason: "preview_already_consumed_or_not_ready", previews: rows };
  }
  if (!Number.isFinite(record.expires_at_ms) || record.expires_at_ms <= nowMs) {
    rows[index] = { ...record, status: "EXPIRED", consumed_at_ms: nowMs };
    return { ok: false, reason: "preview_expired_request_new_preview", previews: rows };
  }
  rows[index] = {
    ...record,
    status: "CONSUMED",
    consumed_at_ms: nowMs,
    consumed_by_order_id: clientOrderId
  };
  return { ok: true, preview: record, previews: rows };
}
