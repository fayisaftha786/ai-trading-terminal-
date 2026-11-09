import test from "node:test";
import assert from "node:assert/strict";
import { createServerBoundPreview, consumeServerBoundPreview, LIVE_PREVIEW_TTL_MS } from "../src/live-preview.js";

const token = "123e4567-e89b-42d3-a456-426614174000";
const clientOrderId = "12345678-1234-1234-1234-123456789012";
const preview = {
  status: "preview_ready", product_id: "BTC-USD", side: "BUY",
  quote_size: "5.00", base_size: null, limit_price: "99000.00",
  commission_total: "0.05", preview_id: "coinbase-preview-123",
  quote_currency: "USD", base_currency: "BTC"
};

test("server-bound preview stores immutable order terms with a two-minute expiry", () => {
  const created = createServerBoundPreview([], preview, token, 1000);
  assert.equal(created.ok, true);
  assert.equal(created.record.token, token);
  assert.equal(created.record.expires_at_ms, 1000 + LIVE_PREVIEW_TTL_MS);
  assert.equal(created.record.coinbase_preview_id, "coinbase-preview-123");
  assert.equal(created.record.quote_size, "5.00");
});

test("server-bound preview can be consumed exactly once", () => {
  const created = createServerBoundPreview([], preview, token, 1000);
  const first = consumeServerBoundPreview(created.previews, token, clientOrderId, 2000);
  assert.equal(first.ok, true);
  assert.equal(first.preview.product_id, "BTC-USD");
  assert.equal(first.previews[0].status, "CONSUMED");
  const replay = consumeServerBoundPreview(first.previews, token, "abcdefab-cdef-abcd-efab-cdefabcdefab", 2100);
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, "preview_already_consumed_or_not_ready");
});

test("expired server-bound preview is rejected and marked expired", () => {
  const created = createServerBoundPreview([], preview, token, 1000);
  const consumed = consumeServerBoundPreview(created.previews, token, clientOrderId, 1000 + LIVE_PREVIEW_TTL_MS);
  assert.equal(consumed.ok, false);
  assert.equal(consumed.reason, "preview_expired_request_new_preview");
  assert.equal(consumed.previews[0].status, "EXPIRED");
});

test("server-bound preview rejects malformed tokens and malformed owner confirmation IDs", () => {
  assert.equal(createServerBoundPreview([], preview, "not-a-uuid", 1000).ok, false);
  const created = createServerBoundPreview([], preview, token, 1000);
  const invalid = consumeServerBoundPreview(created.previews, token, "bad", 2000);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.previews[0].status, "READY");
});

test("new preview creation prunes expired and consumed entries while bounding retained previews", () => {
  const existing = Array.from({ length: 105 }, (_, index) => ({
    token: "old-" + index, status: index % 2 ? "CONSUMED" : "READY", expires_at_ms: index < 100 ? 1 : 999999
  }));
  const created = createServerBoundPreview(existing, preview, token, 1000);
  assert.equal(created.previews.length, 6);
  assert.equal(created.previews.at(-1).token, token);
});
