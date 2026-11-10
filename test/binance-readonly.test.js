import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  binanceReadOnlyStatus,
  preflightBinanceReadOnly
} from "../src/binance-readonly.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const env = {
  BINANCE_READONLY_ENABLED: "true",
  BINANCE_READONLY_API_KEY: "test-api-key",
  BINANCE_READONLY_API_SECRET: "test-api-secret"
};

const safePermissions = {
  enableReading: true,
  enableWithdrawals: false,
  enableInternalTransfer: false,
  permitsUniversalTransfer: false,
  enableMargin: false,
  enableFutures: false,
  enableVanillaOptions: false,
  enableFixApiTrade: false,
  enableSpotAndMarginTrading: false,
  enablePortfolioMarginTrading: false
};

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("Binance production connection is disabled by default and never exposes order capability", () => {
  const status = binanceReadOnlyStatus({});
  assert.equal(status.enabled, false);
  assert.equal(status.credentials_configured, false);
  assert.equal(status.account_preflight_available, false);
  assert.equal(status.order_execution_available, false);
  assert.equal(status.live_trading_enabled, false);
});

test("Binance signed read-only preflight verifies key permissions then reads spot balances", async () => {
  const calls = [];
  const result = await preflightBinanceReadOnly(env, {
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      calls.push({ parsed, options });
      assert.equal(options.method, "GET");
      assert.equal(options.headers["X-MBX-APIKEY"], env.BINANCE_READONLY_API_KEY);
      assert.equal(parsed.searchParams.get("recvWindow"), "5000");
      assert.ok(parsed.searchParams.get("timestamp"));
      assert.match(parsed.searchParams.get("signature"), /^[a-f0-9]{64}$/);
      if (parsed.pathname.endsWith("/apiRestrictions")) return jsonResponse(safePermissions);
      if (parsed.pathname === "/api/v3/account/commission") return jsonResponse({
        symbol: parsed.searchParams.get("symbol"),
        standardCommission: { maker: "0.001", taker: "0.001", buyer: "0.001", seller: "0.001" },
        taxCommission: { maker: "0", taker: "0", buyer: "0", seller: "0" },
        specialCommission: { maker: "0", taker: "0", buyer: "0", seller: "0" },
        discount: { enabledForAccount: true, enabledForSymbol: true, discountAsset: "BNB", discount: "0.75" }
      });
      if (parsed.pathname === "/api/v3/account") {
        return jsonResponse({
          balances: [
            { asset: "BTC", free: "0.01000000", locked: "0.00200000" },
            { asset: "USDT", free: "25.50", locked: "0.00" },
            { asset: "ETH", free: "0", locked: "0" },
            { asset: "BNB", free: "0.10", locked: "0" }
          ]
        });
      }
      return jsonResponse({ code: -1 }, 404);
    }
  });

  assert.equal(result.status, "connected_read_only");
  assert.equal(result.connected, true);
  assert.deepEqual(result.balances, [
    { asset: "BTC", free: "0.01000000", locked: "0.00200000", total: "0.012" },
    { asset: "USDT", free: "25.50", locked: "0.00", total: "25.5" },
    { asset: "BNB", free: "0.10", locked: "0", total: "0.1" }
  ]);
  assert.equal(result.order_execution_available, false);
  assert.equal(result.live_trading_enabled, false);
  assert.equal(result.fees.status, "verified");
  assert.equal(result.fees.verified_count, 3);
  assert.equal(result.fees.symbols[0].conservative_maker_bps, 10);
  assert.equal(result.fees.symbols[0].conservative_taker_bps, 10);
  assert.equal(result.fees.symbols[0].bnb_discount.potential_taker_bps_with_bnb, 2.5);
  assert.deepEqual(calls.map((call) => call.parsed.pathname), [
    "/sapi/v1/account/apiRestrictions",
    "/api/v3/account",
    "/api/v3/account/commission",
    "/api/v3/account/commission",
    "/api/v3/account/commission"
  ]);
  assert.deepEqual(calls.slice(2).map((call) => call.parsed.searchParams.get("symbol")).sort(),
    ["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
});

test("Binance strategy can request a bounded custom pair set for account fee verification", async () => {
  const result = await preflightBinanceReadOnly(env, {
    feeSymbols: ["xrpUSDT", "invalid", "ADAUSDT", "XRPUSDT"],
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/apiRestrictions")) return jsonResponse(safePermissions);
      if (parsed.pathname === "/api/v3/account") return jsonResponse({ balances: [] });
      if (parsed.pathname === "/api/v3/account/commission") return jsonResponse({
        symbol: parsed.searchParams.get("symbol"),
        standardCommission: { maker: "0.001", taker: "0.001" },
        taxCommission: { maker: "0", taker: "0" },
        specialCommission: { maker: "0", taker: "0" },
        discount: { enabledForAccount: false, enabledForSymbol: false, discountAsset: "BNB", discount: "0.75" }
      });
      return jsonResponse({}, 404);
    }
  });
  assert.deepEqual(result.fee_symbols, ["XRPUSDT", "ADAUSDT"]);
  assert.deepEqual(result.fees.symbols.map((item) => item.symbol), ["XRPUSDT", "ADAUSDT"]);
  assert.equal(result.fees.verified_count, 2);
});

test("Binance connector refuses account sync when Spot trading permission is enabled", async () => {
  let accountRead = false;
  const result = await preflightBinanceReadOnly(env, {
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/apiRestrictions")) {
        return jsonResponse({ ...safePermissions, enableSpotAndMarginTrading: true });
      }
      accountRead = true;
      return jsonResponse({ balances: [] });
    }
  });
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.includes(
    "binance_api_write_permission_must_be_disabled_enableSpotAndMarginTrading"
  ));
  assert.equal(result.account_read_skipped, true);
  assert.equal(accountRead, false);
  assert.equal(result.order_execution_available, false);
});

test("Binance connector requires read permission and rejects withdrawal/transfer capabilities", async () => {
  const result = await preflightBinanceReadOnly(env, {
    fetchImpl: async () => jsonResponse({
      ...safePermissions,
      enableReading: false,
      enableWithdrawals: true,
      enableInternalTransfer: true
    })
  });
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.includes("binance_api_read_permission_required"));
  assert.ok(result.blockers.includes(
    "binance_api_write_permission_must_be_disabled_enableWithdrawals"
  ));
  assert.ok(result.blockers.includes(
    "binance_api_write_permission_must_be_disabled_enableInternalTransfer"
  ));
});

test("Binance credentials are never required from browser payloads and missing secrets fail closed", async () => {
  let called = false;
  const result = await preflightBinanceReadOnly({ BINANCE_READONLY_ENABLED: "true" }, {
    fetchImpl: async () => { called = true; return jsonResponse({}); }
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.connected, false);
  assert.equal(called, false);
  assert.ok(result.blockers.includes("binance_readonly_credentials_not_configured"));
});

test("Binance provider errors are normalized without returning exchange messages", async () => {
  const result = await preflightBinanceReadOnly(env, {
    fetchImpl: async () => jsonResponse({ msg: "sensitive provider detail" }, 401)
  });
  assert.equal(result.status, "provider_check_failed");
  assert.deepEqual(result.blockers, ["binance_api_auth_or_permission_rejected"]);
  assert.equal(JSON.stringify(result).includes("sensitive provider detail"), false);
  assert.equal(result.order_execution_available, false);
});
