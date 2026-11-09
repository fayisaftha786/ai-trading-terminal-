import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, webcrypto } from "node:crypto";
import {
  coinbaseAdvancedStatus,
  createCoinbaseAdvancedJwt,
  preflightCoinbaseAdvanced,
  previewCoinbaseAdvancedLimitBuy,
  submitCoinbaseAdvancedLimitBuy,
  listCoinbaseAdvancedFills
} from "../src/coinbase-advanced.js";

globalThis.crypto ||= webcrypto;

function makeCredentials() {
  const pair = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "sec1", format: "pem" }
  });
  return {
    apiKey: "organizations/test-org/apiKeys/test-key",
    privateKeyPem: pair.privateKey,
    publicKeyPem: pair.publicKey
  };
}

function makeEnv(overrides = {}) {
  const credentials = makeCredentials();
  return {
    COINBASE_ADVANCED_API_KEY: credentials.apiKey,
    COINBASE_ADVANCED_API_SECRET: credentials.privateKeyPem,
    COINBASE_ADVANCED_ALLOWED_PRODUCTS: "BTC-USD",
    COINBASE_ADVANCED_MAX_ORDER_QUOTE: "10",
    ...overrides,
    _testPublicKeyPem: credentials.publicKeyPem
  };
}

async function verifyJwt(token, publicKeyPem) {
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  const decode = (value) => {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return Buffer.from(padded, "base64");
  };
  const header = JSON.parse(decode(encodedHeader).toString("utf8"));
  const payload = JSON.parse(decode(encodedPayload).toString("utf8"));
  const publicKey = await webcrypto.subtle.importKey(
    "spki",
    Buffer.from(publicKeyPem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64"),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
  const valid = await webcrypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    decode(encodedSignature),
    new TextEncoder().encode(encodedHeader + "." + encodedPayload)
  );
  return { header, payload, valid };
}

function mockApi(env, { permissions, accounts, product, preview, fillsResponses = [], calls = [] } = {}) {
  let fillsPage = 0;
  const publicKeyPem = env._testPublicKeyPem;
  const fetchImpl = async (url, options) => {
    const parsed = new URL(String(url));
    const auth = String(options.headers?.Authorization || "");
    assert.match(auth, /^Bearer [A-Za-z0-9_.-]+$/);
    const token = auth.slice("Bearer ".length);
    const checked = await verifyJwt(token, publicKeyPem);
    assert.equal(checked.valid, true, "request JWT must be a valid ES256 signature");
    assert.equal(checked.header.alg, "ES256");
    assert.equal(checked.header.kid, env.COINBASE_ADVANCED_API_KEY);
    assert.equal(checked.payload.uri, options.method + " api.coinbase.com" + parsed.pathname + parsed.search);
    calls.push({ method: options.method, path: parsed.pathname + parsed.search, body: options.body ? JSON.parse(options.body) : null });
    if (parsed.pathname.endsWith("/key_permissions")) {
      return Response.json(permissions || { can_view: true, can_trade: false, can_transfer: false, portfolio_uuid: "portfolio-test" });
    }
    if (parsed.pathname.endsWith("/accounts")) {
      return Response.json(accounts || {
        accounts: [{ currency: "USD", available_balance: { value: "25.00" } }, { currency: "BTC", available_balance: { value: "0.5" } }],
        has_next: false
      });
    }
    if (parsed.pathname.endsWith("/products/BTC-USD")) {
      return Response.json(product || {
        product_id: "BTC-USD", product_type: "SPOT", is_disabled: false,
        trading_disabled: false, cancel_only: false, view_only: false,
        quote_currency_id: "USD", base_currency_id: "BTC",
        quote_min_size: "1.00", quote_max_size: "10000.00",
        quote_increment: "0.01", base_min_size: "0.00001", base_max_size: "100", base_increment: "0.00001", price_increment: "0.01"
      });
    }
    if (parsed.pathname.endsWith("/orders/preview")) {
      return Response.json(preview || {
        preview_id: "preview-test-123", commission_total: "0.10",
        order_total: "10.00", best_bid: "99000.00", best_ask: "99010.00",
        slippage: "0.00", errs: [], warning: []
      });
    }
    if (parsed.pathname.endsWith("/orders/historical/fills")) {
      const payload = fillsResponses[fillsPage] || { fills: [], cursor: "" };
      fillsPage += 1;
      return Response.json(payload);
    }
    throw new Error("Unexpected endpoint " + parsed.pathname);
  };
  return { fetchImpl, calls };
}

test("live readiness status defaults closed and exposes no API secret", () => {
  const status = coinbaseAdvancedStatus({});
  assert.equal(status.mode, "live_setup_locked");
  assert.equal(status.credentials_configured, false);
  assert.equal(status.order_submission_available, false);
  assert.equal(status.live_trading_enabled, false);
  assert.equal(status.automatic_live_entries_enabled, false);
  assert.ok(status.blockers.includes("coinbase_advanced_credentials_not_configured"));
  assert.equal(JSON.stringify(status).includes("PRIVATE KEY"), false);
});

test("guarded order switch remains closed by default and requires strict daily/open-order caps", () => {
  const off = coinbaseAdvancedStatus(makeEnv());
  assert.equal(off.order_submission_available, false);
  assert.equal(off.automatic_live_entries_enabled, false);
  const on = coinbaseAdvancedStatus(makeEnv({
    COINBASE_ADVANCED_ORDER_ENABLED: "true",
    COINBASE_ADVANCED_MAX_OPEN_ORDERS: "1",
    COINBASE_ADVANCED_MAX_DAILY_ORDERS: "1"
  }));
  assert.equal(on.order_submission_available, true, "the guarded manual route is available only when explicitly configured");
  assert.equal(on.max_open_orders, 1);
  assert.equal(on.max_daily_orders, 1);
  const invalid = coinbaseAdvancedStatus(makeEnv({
    COINBASE_ADVANCED_ORDER_ENABLED: "true",
    COINBASE_ADVANCED_MAX_OPEN_ORDERS: "9",
    COINBASE_ADVANCED_MAX_DAILY_ORDERS: "9"
  }));
  assert.equal(invalid.order_submission_available, false);
  assert.equal(invalid.max_open_orders, null);
  assert.equal(invalid.max_daily_orders, null);
});

test("ES256 JWT from Coinbase SEC1 EC private key verifies and binds exact request URI", async () => {
  const env = makeEnv();
  const jwt = await createCoinbaseAdvancedJwt({
    apiKey: env.COINBASE_ADVANCED_API_KEY,
    privateKeyPem: env.COINBASE_ADVANCED_API_SECRET,
    method: "GET",
    path: "/api/v3/brokerage/key_permissions?sample=1",
    nowSeconds: 1800000000
  });
  const verified = await verifyJwt(jwt, env._testPublicKeyPem);
  assert.equal(verified.valid, true);
  assert.equal(verified.header.kid, env.COINBASE_ADVANCED_API_KEY);
  assert.equal(verified.payload.iss, "cdp");
  assert.equal(verified.payload.sub, env.COINBASE_ADVANCED_API_KEY);
  assert.equal(verified.payload.nbf, 1800000000);
  assert.equal(verified.payload.exp - verified.payload.nbf, 90);
  assert.equal(verified.payload.uri, "GET api.coinbase.com/api/v3/brokerage/key_permissions?sample=1");
});

test("preflight supports view-only permissions, transfer disabled, SPOT product and quote balance", async () => {
  const env = makeEnv();
  const { fetchImpl, calls } = mockApi(env);
  const result = await preflightCoinbaseAdvanced(env, { fetchImpl });
  assert.equal(result.status, "preflight_ready_for_manual_order_preview");
  assert.deepEqual(result.eligible_products, ["BTC-USD"]);
  assert.deepEqual(result.permissions, { can_view: true, can_trade: false, can_transfer: false });
  assert.equal(result.balances.USD, "25.00");
  assert.equal(result.order_submission_available, false);
  assert.equal(result.permissions.can_trade, false);
  assert.equal(result.live_trading_enabled, false);
  assert.equal(calls.some((call) => call.path.endsWith("/orders")), false);
});

test("preflight blocks keys with transfer enabled", async () => {
  const env = makeEnv();
  const { fetchImpl, calls } = mockApi(env, {
    permissions: { can_view: true, can_trade: true, can_transfer: true }
  });
  const result = await preflightCoinbaseAdvanced(env, { fetchImpl });
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.includes("api_key_transfer_permission_must_be_disabled"));
  assert.equal(calls.some((call) => call.path.endsWith("/accounts")), false);
});

test("preflight blocks non-SPOT and disabled products", async () => {
  const env = makeEnv();
  const { fetchImpl } = mockApi(env, {
    product: {
      product_id: "BTC-USD", product_type: "FUTURE", is_disabled: false,
      trading_disabled: false, cancel_only: false,
      quote_currency_id: "USD", quote_min_size: "1", quote_max_size: "100",
      quote_increment: "0.01", price_increment: "0.01"
    }
  });
  const result = await preflightCoinbaseAdvanced(env, { fetchImpl });
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.includes("BTC-USD:product_not_verified_spot"));
});

test("preview uses post-only LIMIT GTC preview endpoint only and displays fee/quotes", async () => {
  const env = makeEnv();
  const { fetchImpl, calls } = mockApi(env);
  const result = await previewCoinbaseAdvancedLimitBuy(
    env, { productId: "BTC-USD", quoteSize: "10.00", limitPrice: "99000.00" }, { fetchImpl }
  );
  assert.equal(result.status, "preview_ready");
  assert.equal(result.decision, "PREVIEW_ONLY");
  assert.equal(result.side, "BUY");
  assert.equal(result.order_type, "LIMIT_GTC_POST_ONLY");
  assert.equal(result.commission_total, "0.10");
  assert.equal(result.preview_id, "preview-test-123");
  assert.equal(result.order_submission_available, false);
  assert.equal(result.live_trading_enabled, false);
  const previewCall = calls.find((call) => call.path.endsWith("/orders/preview"));
  assert.ok(previewCall);
  assert.deepEqual(previewCall.body, {
    product_id: "BTC-USD",
    side: "BUY",
    order_configuration: {
      limit_limit_gtc: { quote_size: "10.00", limit_price: "99000.00", post_only: true }
    }
  });
  assert.equal(calls.some((call) => call.path === "/api/v3/brokerage/orders"), false,
    "the adapter must never call the order-submission endpoint");
});

test("preview blocks missing allowlist and over-cap size before any exchange call", async () => {
  const env = makeEnv();
  const { fetchImpl, calls } = mockApi(env);
  const notAllowed = await previewCoinbaseAdvancedLimitBuy(
    env, { productId: "ETH-USD", quoteSize: "5", limitPrice: "2000" }, { fetchImpl }
  );
  assert.equal(notAllowed.status, "blocked");
  assert.equal(calls.length, 0);
  const overCap = await previewCoinbaseAdvancedLimitBuy(
    env, { productId: "BTC-USD", quoteSize: "10.01", limitPrice: "99000.00" }, { fetchImpl }
  );
  assert.equal(overCap.status, "blocked");
  assert.equal(calls.length, 0);
});

test("preview rejects off-increment size and price before external preview", async () => {
  const env = makeEnv();
  const { fetchImpl, calls } = mockApi(env);
  const result = await previewCoinbaseAdvancedLimitBuy(
    env, { productId: "BTC-USD", quoteSize: "9.995", limitPrice: "99000.001" }, { fetchImpl }
  );
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.includes("quote_size_not_aligned_to_exchange_increment"));
  assert.equal(calls.filter((call) => call.path.endsWith("/orders/preview")).length, 0,
    "invalid exchange increments must be rejected before the exchange order-preview endpoint");
});

test("preview blocks insufficient quote balance and provider preview errors", async () => {
  const env = makeEnv();
  const lowBalance = mockApi(env, {
    accounts: { accounts: [{ currency: "USD", available_balance: { value: "5.00" } }], has_next: false }
  });
  const noFunds = await previewCoinbaseAdvancedLimitBuy(
    env, { productId: "BTC-USD", quoteSize: "10.00", limitPrice: "99000.00" },
    { fetchImpl: lowBalance.fetchImpl }
  );
  assert.equal(noFunds.status, "blocked");
  assert.ok(noFunds.blockers.includes("insufficient_available_quote_balance"));
  assert.equal(lowBalance.calls.some((call) => call.path.endsWith("/orders/preview")), false);

  const rejected = mockApi(env, {
    preview: { preview_id: "preview-bad", commission_total: "0.10", errs: ["INSUFFICIENT_FUND"] }
  });
  const rejectedResult = await previewCoinbaseAdvancedLimitBuy(
    env, { productId: "BTC-USD", quoteSize: "10.00", limitPrice: "99000.00" },
    { fetchImpl: rejected.fetchImpl }
  );
  assert.equal(rejectedResult.status, "preview_rejected");
  assert.deepEqual(rejectedResult.preview_errors, ["INSUFFICIENT_FUND"]);
  assert.equal(rejected.calls.some((call) => call.path === "/api/v3/brokerage/orders"), false);
});

test("SELL preview uses base balance, base increment and a post-only limit preview", async () => {
  const env = makeEnv();
  const { fetchImpl, calls } = mockApi(env);
  const result = await previewCoinbaseAdvancedLimitBuy(
    env, { productId: "BTC-USD", side: "SELL", baseSize: "0.00010", limitPrice: "99000.00" },
    { fetchImpl }
  );
  assert.equal(result.status, "preview_ready");
  assert.equal(result.side, "SELL");
  assert.equal(result.base_size, "0.00010");
  assert.equal(result.balance_currency, "BTC");
  const previewCall = calls.find((call) => call.path.endsWith("/orders/preview"));
  assert.deepEqual(previewCall.body.order_configuration.limit_limit_gtc, {
    base_size: "0.00010", limit_price: "99000.00", post_only: true
  });
});

test("manual submission requires explicit execution switch and Coinbase Trade permission", async () => {
  const env = makeEnv({
    COINBASE_ADVANCED_ORDER_ENABLED: "true",
    COINBASE_ADVANCED_MAX_OPEN_ORDERS: "1",
    COINBASE_ADVANCED_MAX_DAILY_ORDERS: "1"
  });
  const noTrade = mockApi(env);
  const blocked = await submitCoinbaseAdvancedLimitBuy(env, {
    productId: "BTC-USD", quoteSize: "5.00", limitPrice: "99000.00",
    commissionTotal: "0.10", previewId: "preview-test-123", clientOrderId: "12345678-1234-1234-1234-123456789012"
  }, { fetchImpl: noTrade.fetchImpl });
  assert.equal(blocked.status, "blocked");
  assert.ok(blocked.blockers.includes("api_key_trade_permission_required_for_manual_orders"));
  assert.equal(noTrade.calls.some((call) => call.path === "/api/v3/brokerage/orders"), false);
});

test("Coinbase fills adapter paginates and restricts results to requested bot order IDs", async () => {
  const env = makeEnv();
  const firstFill = {
    entry_id: "entry-1", trade_id: "trade-1", order_id: "order-1",
    trade_time: "2026-11-09T10:00:00Z", price: "10000", size: "0.001",
    commission: "0.10", product_id: "BTC-USD", side: "BUY", size_in_quote: false
  };
  const secondFill = {
    ...firstFill, entry_id: "entry-2", trade_id: "trade-2", order_id: "order-2",
    trade_time: "2026-11-09T10:01:00Z", side: "SELL"
  };
  const fake = mockApi(env, {
    fillsResponses: [
      { fills: [firstFill], cursor: "cursor-next" },
      { fills: [secondFill, { ...secondFill, order_id: "outside-order", entry_id: "unlinked" }], cursor: "" }
    ]
  });
  const result = await listCoinbaseAdvancedFills(env, {
    orderIds: ["order-1", "order-2"], limit: 50, maxPages: 3
  }, { fetchImpl: fake.fetchImpl });
  assert.equal(result.status, "fills_loaded");
  assert.equal(result.complete, true);
  assert.equal(result.pages, 2);
  assert.equal(result.fills.length, 2);
  assert.ok(fake.calls[0].path.includes("order_ids=order-1"));
  assert.ok(fake.calls[0].path.includes("order_ids=order-2"));
  assert.ok(fake.calls[1].path.includes("cursor=cursor-next"));
});

test("Coinbase fills adapter blocks when the provider requires an EU SCA proof token", async () => {
  const env = makeEnv();
  const fake = mockApi(env, { fillsResponses: [{ fills: [], cursor: "", proof_token_required: true }] });
  await assert.rejects(
    listCoinbaseAdvancedFills(env, { orderIds: ["order-1"] }, { fetchImpl: fake.fetchImpl }),
    /fills_proof_token_required/
  );
});

test("Coinbase fills adapter fails closed when fill pagination does not finish", async () => {
  const env = makeEnv();
  const fake = mockApi(env, {
    fillsResponses: [{ fills: [], cursor: "still-more" }]
  });
  await assert.rejects(
    listCoinbaseAdvancedFills(env, { orderIds: ["order-1"], maxPages: 1 }, { fetchImpl: fake.fetchImpl }),
    /fills_pagination_incomplete/
  );
});

test("account pagination uncertainty and incomplete provider data fail closed", async () => {
  const env = makeEnv();
  const fake = mockApi(env, {
    accounts: { accounts: [], has_next: true }
  });
  const result = await preflightCoinbaseAdvanced(env, { fetchImpl: fake.fetchImpl });
  assert.equal(result.status, "provider_check_failed");
  assert.ok(result.blockers.includes("coinbase_advanced_accounts_pagination_invalid"));
});
