import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, webcrypto } from "node:crypto";
import {
  coinbaseAdvancedStatus,
  createCoinbaseAdvancedJwt,
  preflightCoinbaseAdvanced,
  previewCoinbaseAdvancedLimitBuy
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

function mockApi(env, { permissions, accounts, product, preview, calls = [] } = {}) {
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
      return Response.json(permissions || { can_view: true, can_trade: true, can_transfer: false, portfolio_uuid: "portfolio-test" });
    }
    if (parsed.pathname.endsWith("/accounts")) {
      return Response.json(accounts || {
        accounts: [{ currency: "USD", available_balance: { value: "25.00" } }],
        has_next: false
      });
    }
    if (parsed.pathname.endsWith("/products/BTC-USD")) {
      return Response.json(product || {
        product_id: "BTC-USD", product_type: "SPOT", is_disabled: false,
        trading_disabled: false, cancel_only: false, view_only: false,
        quote_currency_id: "USD", base_currency_id: "BTC",
        quote_min_size: "1.00", quote_max_size: "10000.00",
        quote_increment: "0.01", price_increment: "0.01"
      });
    }
    if (parsed.pathname.endsWith("/orders/preview")) {
      return Response.json(preview || {
        preview_id: "preview-test-123", commission_total: "0.10",
        order_total: "10.00", best_bid: "99000.00", best_ask: "99010.00",
        slippage: "0.00", errs: [], warning: []
      });
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

test("preflight confirms view/trade permissions, transfer disabled, SPOT product and quote balance", async () => {
  const env = makeEnv();
  const { fetchImpl, calls } = mockApi(env);
  const result = await preflightCoinbaseAdvanced(env, { fetchImpl });
  assert.equal(result.status, "preflight_ready_for_manual_order_preview");
  assert.deepEqual(result.eligible_products, ["BTC-USD"]);
  assert.deepEqual(result.permissions, { can_view: true, can_trade: true, can_transfer: false });
  assert.equal(result.balances.USD, "25.00");
  assert.equal(result.order_submission_available, false);
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

test("account pagination uncertainty and incomplete provider data fail closed", async () => {
  const env = makeEnv();
  const fake = mockApi(env, {
    accounts: { accounts: [], has_next: true }
  });
  const result = await preflightCoinbaseAdvanced(env, { fetchImpl: fake.fetchImpl });
  assert.equal(result.status, "provider_check_failed");
  assert.ok(result.blockers.includes("coinbase_advanced_accounts_pagination_invalid"));
});
