import test from "node:test";
import assert from "node:assert/strict";
import {
  createServerLivePreview,
  consumeServerLivePreview,
  LIVE_ORDER_PREVIEW_TTL_MS
} from "../src/live-order-authorization.js";

function preview(overrides = {}) {
  return {
    status: "preview_ready",
    order_submission_available: true,
    permissions: { can_view: true, can_trade: true, can_transfer: false },
    product_id: "BTC-USD",
    side: "BUY",
    quote_size: "5.00",
    base_size: null,
    limit_price: "90000.00",
    commission_total: "0.05",
    preview_id: "coinbase-preview-1",
    quote_currency: "USD",
    balance_currency: "USD",
    order_type: "LIMIT_GTC_POST_ONLY",
    ...overrides
  };
}

test("server preview copies exact exchange parameters and sets a short expiry", () => {
  const created = createServerLivePreview(preview(), "00000000-0000-4000-8000-000000000001", 1000);
  assert.equal(created.status, "READY");
  assert.equal(created.product_id, "BTC-USD");
  assert.equal(created.quote_size, "5.00");
  assert.equal(created.limit_price, "90000.00");
  assert.equal(created.provider_preview_id, "coinbase-preview-1");
  assert.equal(created.expires_at_ms, 1000 + LIVE_ORDER_PREVIEW_TTL_MS);
  assert.equal(created.order_submission_available, true);
});

test("preview cannot authorize submission without exchange Trade permission", () => {
  const created = createServerLivePreview(preview({
    order_submission_available: false,
    permissions: { can_view: true, can_trade: false, can_transfer: false }
  }), "00000000-0000-4000-8000-000000000002", 1000);
  assert.equal(created.order_submission_available, false);
  const consume = consumeServerLivePreview([created], created.preview_token, 1100);
  assert.equal(consume.ok, false);
  assert.equal(consume.reason, "preview_not_authorized_for_manual_live_submission");
  assert.equal(consume.previews[0].status, "READY");
});

test("preview authorization is atomically single-use and retains server-bound order fields", () => {
  const created = createServerLivePreview(preview(), "00000000-0000-4000-8000-000000000003", 1000);
  const first = consumeServerLivePreview([created], created.preview_token, 1500);
  assert.equal(first.ok, true);
  assert.equal(first.preview.provider_preview_id, "coinbase-preview-1");
  assert.equal(first.preview.quote_size, "5.00");
  assert.equal(first.previews[0].status, "CONSUMED");
  const second = consumeServerLivePreview(first.previews, created.preview_token, 1600);
  assert.equal(second.ok, false);
  assert.equal(second.reason, "server_preview_already_consumed");
});

test("expired preview is marked expired and rejected at the exact expiry boundary", () => {
  const created = createServerLivePreview(preview(), "00000000-0000-4000-8000-000000000004", 1000);
  const expired = consumeServerLivePreview([created], created.preview_token, created.expires_at_ms);
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, "server_preview_expired_refresh_required");
  assert.equal(expired.previews[0].status, "EXPIRED");
});
