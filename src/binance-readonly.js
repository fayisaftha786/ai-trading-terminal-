const API_BASE = "https://api.binance.com";
const encoder = new TextEncoder();
const DEFAULT_FEE_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
const READ_ONLY_DISABLED_FLAGS = [
  "enableWithdrawals",
  "enableInternalTransfer",
  "permitsUniversalTransfer",
  "enableMargin",
  "enableFutures",
  "enableVanillaOptions",
  "enableFixApiTrade",
  "enableSpotAndMarginTrading",
  "enablePortfolioMarginTrading"
];

function parseFeeSymbols(value) {
  const raw = String(value || DEFAULT_FEE_SYMBOLS.join(","));
  return [...new Set(raw.split(",").map((item) => item.trim().toUpperCase())
    .filter((item) => /^[A-Z0-9]{2,18}USDT$/.test(item)))].slice(0, 10);
}

function configuration(env = {}) {
  return {
    enabled: String(env.BINANCE_READONLY_ENABLED || "").trim().toLowerCase() === "true",
    apiKey: String(env.BINANCE_READONLY_API_KEY || "").trim(),
    apiSecret: String(env.BINANCE_READONLY_API_SECRET || "").trim(),
    feeSymbols: parseFeeSymbols(env.BINANCE_READONLY_FEE_SYMBOLS)
  };
}

export function binanceReadOnlyStatus(env = {}) {
  const config = configuration(env);
  const credentialsConfigured = !!config.apiKey && !!config.apiSecret;
  const blockers = [];
  if (!config.enabled) blockers.push("binance_readonly_connector_disabled");
  if (!credentialsConfigured) blockers.push("binance_readonly_credentials_not_configured");
  return {
    provider: "Binance Spot",
    environment: "production_read_only",
    status: config.enabled && credentialsConfigured ? "ready_for_read_only_preflight" : "not_configured",
    enabled: config.enabled,
    credentials_configured: credentialsConfigured,
    account_preflight_available: config.enabled && credentialsConfigured,
    order_execution_available: false,
    live_trading_enabled: false,
    withdrawals_enabled_by_app: false,
    fee_symbols: config.feeSymbols,
    allowed_operations: ["verify_api_key_permissions", "read_spot_account_balances", "read_pair_commission_rates"],
    blockers
  };
}

function toHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signQuery(query, secret) {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(query));
  return toHex(new Uint8Array(signature));
}

async function signedGet(path, config, fetchImpl, queryParams = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(queryParams)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  params.set("recvWindow", "5000");
  params.set("timestamp", String(Date.now()));
  const query = params.toString();
  const signature = await signQuery(query, config.apiSecret);
  const url = API_BASE + path + "?" + query + "&signature=" + signature;
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "X-MBX-APIKEY": config.apiKey
      },
      signal: AbortSignal.timeout(10000)
    });
  } catch {
    const error = new Error("binance_network_request_failed");
    error.code = "binance_network_request_failed";
    error.status = 502;
    throw error;
  }
  if (!response.ok) {
    const code = response.status === 418 || response.status === 429
      ? "binance_api_rate_limited"
      : response.status === 401 || response.status === 403
        ? "binance_api_auth_or_permission_rejected"
        : "binance_api_provider_error";
    const error = new Error(code);
    error.code = code;
    error.status = response.status === 429 || response.status === 418 ? 429
      : response.status === 401 || response.status === 403 ? 403 : 502;
    throw error;
  }
  try {
    return await response.json();
  } catch {
    const error = new Error("binance_api_response_invalid");
    error.code = "binance_api_response_invalid";
    error.status = 502;
    throw error;
  }
}

function permissionSummary(payload) {
  const permissions = {};
  for (const key of ["enableReading", ...READ_ONLY_DISABLED_FLAGS]) {
    permissions[key] = typeof payload?.[key] === "boolean" ? payload[key] : null;
  }
  return permissions;
}

function readOnlyPermissionBlockers(permissions) {
  const blockers = [];
  if (permissions.enableReading !== true) blockers.push("binance_api_read_permission_required");
  for (const key of READ_ONLY_DISABLED_FLAGS) {
    if (permissions[key] === true) blockers.push("binance_api_write_permission_must_be_disabled_" + key);
    else if (permissions[key] !== false) blockers.push("binance_api_permission_not_verified_" + key);
  }
  return blockers;
}

function safeBalances(account) {
  if (!Array.isArray(account?.balances)) return null;
  return account.balances
    .filter((row) => {
      if (!/^[A-Z0-9]{2,12}$/.test(String(row?.asset || ""))) return false;
      const free = Number(row?.free);
      const locked = Number(row?.locked);
      return Number.isFinite(free) && free >= 0 && Number.isFinite(locked) && locked >= 0 &&
        (free > 0 || locked > 0);
    })
    .slice(0, 500)
    .map((row) => ({
      asset: row.asset,
      free: String(row.free),
      locked: String(row.locked),
      total: (Number(row.free) + Number(row.locked)).toString()
    }));
}

function commissionRate(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const rate = Number(value);
  return Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : null;
}

function summarizeCommission(payload, symbol, balances) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      String(payload.symbol || "").toUpperCase() !== symbol) return null;
  const groups = ["standardCommission", "taxCommission", "specialCommission"];
  const components = {};
  for (const group of groups) {
    const source = payload[group];
    if (!source || typeof source !== "object" || Array.isArray(source)) return null;
    const maker = commissionRate(source.maker);
    const taker = commissionRate(source.taker);
    if (maker === null || taker === null) return null;
    components[group] = { maker_bps: maker * 10_000, taker_bps: taker * 10_000 };
  }

  const makerBps = components.standardCommission.maker_bps +
    components.taxCommission.maker_bps + components.specialCommission.maker_bps;
  const takerBps = components.standardCommission.taker_bps +
    components.taxCommission.taker_bps + components.specialCommission.taker_bps;
  const discount = payload.discount;
  const discountRate = commissionRate(discount?.discount);
  const discountFlagsEnabled = discount?.enabledForAccount === true &&
    discount?.enabledForSymbol === true;
  const bnbBalance = (balances || []).find((row) => row.asset === "BNB");
  const bnbTotal = bnbBalance ? Number(bnbBalance.total) : 0;
  const bnbScenarioAvailable = discountFlagsEnabled && discountRate !== null &&
    discountRate > 0 && Number.isFinite(bnbTotal) && bnbTotal > 0;
  const discountedMakerBps = bnbScenarioAvailable
    ? (components.standardCommission.maker_bps * (1 - discountRate)) +
      components.taxCommission.maker_bps + components.specialCommission.maker_bps
    : null;
  const discountedTakerBps = bnbScenarioAvailable
    ? (components.standardCommission.taker_bps * (1 - discountRate)) +
      components.taxCommission.taker_bps + components.specialCommission.taker_bps
    : null;

  return {
    symbol,
    conservative_maker_bps: Number(makerBps.toFixed(6)),
    conservative_taker_bps: Number(takerBps.toFixed(6)),
    components_bps: components,
    bnb_discount: {
      discount_asset: typeof discount?.discountAsset === "string" ? discount.discountAsset : null,
      enabled_for_account: discount?.enabledForAccount === true,
      enabled_for_symbol: discount?.enabledForSymbol === true,
      discount_fraction: discountRate,
      balance_total: Number.isFinite(bnbTotal) ? bnbTotal : 0,
      potential_maker_bps_with_bnb: Number.isFinite(discountedMakerBps)
        ? Number(discountedMakerBps.toFixed(6)) : null,
      potential_taker_bps_with_bnb: Number.isFinite(discountedTakerBps)
        ? Number(discountedTakerBps.toFixed(6)) : null,
      note: bnbScenarioAvailable
        ? "Potential rate only; BNB must remain sufficient at each fill."
        : "BNB discount is not counted in the conservative rate."
    }
  };
}

async function readPairCommissions(config, balances, fetchImpl) {
  const retrievedAt = Date.now();
  const symbols = await Promise.all(config.feeSymbols.map(async (symbol) => {
    try {
      const payload = await signedGet("/api/v3/account/commission", config, fetchImpl, { symbol });
      const summary = summarizeCommission(payload, symbol, balances);
      return summary
        ? { ...summary, status: "verified" }
        : { symbol, status: "invalid_response", error_code: "binance_commission_response_invalid" };
    } catch (error) {
      return {
        symbol,
        status: "unavailable",
        error_code: typeof error?.code === "string" ? error.code : "binance_commission_check_failed"
      };
    }
  }));
  const verifiedCount = symbols.filter((item) => item.status === "verified").length;
  return {
    status: verifiedCount === symbols.length && symbols.length > 0
      ? "verified" : verifiedCount > 0 ? "partial" : "unavailable",
    source: "GET /api/v3/account/commission",
    retrieved_at_ms: retrievedAt,
    verified_count: verifiedCount,
    requested_count: symbols.length,
    symbols
  };
}

export async function preflightBinanceReadOnly(env = {}, { fetchImpl = fetch } = {}) {
  const staticStatus = binanceReadOnlyStatus(env);
  const config = configuration(env);
  if (!staticStatus.account_preflight_available) {
    return {
      ...staticStatus,
      connected: false,
      status: "blocked",
      permissions: null,
      balances: [],
      fees: { status: "not_checked", symbols: [] },
      blockers: staticStatus.blockers
    };
  }

  try {
    const rawPermissions = await signedGet("/sapi/v1/account/apiRestrictions", config, fetchImpl);
    if (!rawPermissions || typeof rawPermissions !== "object" || Array.isArray(rawPermissions)) {
      throw Object.assign(new Error("binance_api_response_invalid"), {
        code: "binance_api_response_invalid", status: 502
      });
    }
    const permissions = permissionSummary(rawPermissions);
    const blockers = readOnlyPermissionBlockers(permissions);
    if (blockers.length) {
      return {
        ...staticStatus,
        status: "blocked",
        authenticated: true,
        connected: false,
        permissions,
        balances: [],
        fees: { status: "not_checked", symbols: [] },
        blockers,
        account_read_skipped: true,
        order_execution_available: false,
        live_trading_enabled: false
      };
    }

    const account = await signedGet("/api/v3/account", config, fetchImpl);
    const balances = safeBalances(account);
    if (!balances) {
      throw Object.assign(new Error("binance_account_response_invalid"), {
        code: "binance_account_response_invalid", status: 502
      });
    }
    const fees = await readPairCommissions(config, balances, fetchImpl);
    return {
      ...staticStatus,
      status: "connected_read_only",
      connected: true,
      permissions,
      balances,
      balance_count: balances.length,
      fees,
      account_retrieved_at_ms: Date.now(),
      blockers: [],
      order_execution_available: false,
      live_trading_enabled: false
    };
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "binance_read_only_preflight_failed";
    return {
      ...staticStatus,
      status: "provider_check_failed",
      connected: false,
      permissions: null,
      balances: [],
      fees: { status: "unavailable", symbols: [], error_code: code },
      blockers: [code],
      error_code: code,
      order_execution_available: false,
      live_trading_enabled: false
    };
  }
}
