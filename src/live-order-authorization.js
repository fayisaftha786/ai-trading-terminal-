export const LIVE_ORDER_PREVIEW_TTL_MS = 60_000;

export function createServerLivePreview(preview, previewToken, nowMs = Date.now()) {
  if (!preview || preview.status !== "preview_ready" ||
      typeof previewToken !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(previewToken) ||
      !Number.isFinite(nowMs)) return null;
  if (!["BUY", "SELL"].includes(preview.side) ||
      typeof preview.product_id !== "string" ||
      typeof preview.limit_price !== "string" ||
      typeof preview.commission_total !== "string" ||
      typeof preview.preview_id !== "string") return null;
  return {
    preview_token: previewToken,
    status: "READY",
    created_at_ms: nowMs,
    expires_at_ms: nowMs + LIVE_ORDER_PREVIEW_TTL_MS,
    order_submission_available: preview.order_submission_available === true &&
      preview.permissions?.can_trade === true,
    product_id: preview.product_id,
    side: preview.side,
    quote_size: preview.quote_size || null,
    base_size: preview.base_size || null,
    limit_price: preview.limit_price,
    commission_total: preview.commission_total,
    provider_preview_id: preview.preview_id,
    quote_currency: preview.quote_currency || null,
    balance_currency: preview.balance_currency || null,
    order_type: preview.order_type || null
  };
}

export function consumeServerLivePreview(previews, previewToken, nowMs = Date.now()) {
  const rows = Array.isArray(previews) ? previews : [];
  const index = rows.findIndex((item) => item?.preview_token === previewToken);
  if (index < 0) return { ok: false, reason: "server_preview_not_found_or_already_consumed", previews: rows };
  const record = rows[index];
  if (record.status !== "READY") {
    return { ok: false, reason: "server_preview_already_consumed", previews: rows };
  }
  if (!Number.isFinite(record.expires_at_ms) || record.expires_at_ms <= nowMs ||
      !Number.isFinite(record.created_at_ms) || nowMs - record.created_at_ms > LIVE_ORDER_PREVIEW_TTL_MS) {
    const expired = { ...record, status: "EXPIRED", expired_at_ms: nowMs };
    const updated = rows.slice();
    updated[index] = expired;
    return { ok: false, reason: "server_preview_expired_refresh_required", previews: updated };
  }
  if (record.order_submission_available !== true ||
      !record.provider_preview_id || !record.product_id ||
      !["BUY", "SELL"].includes(record.side) ||
      !record.limit_price || !record.commission_total) {
    return { ok: false, reason: "preview_not_authorized_for_manual_live_submission", previews: rows };
  }
  const consumed = {
    ...record,
    status: "CONSUMED",
    consumed_at_ms: nowMs
  };
  const updated = rows.slice();
  updated[index] = consumed;
  return { ok: true, preview: record, previews: updated };
}
