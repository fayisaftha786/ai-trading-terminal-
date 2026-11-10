const API_BASE = "https://api.binance.com";
const encoder = new TextEncoder();
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

function configuration(env = {}) {
  return {
    enabled: String(env.BINANCE_READONLY_ENABLED || "").trim().toLowerCase() === "true",
    apiKey: String(env.BINANCE_READONLY_API_KEY || "").trim(),
    apiSecret: String(env.BINANCE_READONLY_API_SECRET || "").trim()
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
    allowed_operations: ["verify_api_key_permissions", "read_spot_account_balances"],
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

async function signedGet(path, config, fetchImpl) {
  const params = new URLSearchParams({
    recvWindow: "5000",
    timestamp: String(Date.now())
  });
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
        connected: false,
        permissions,
        balances: [],
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
    return {
      ...staticStatus,
      status: "connected_read_only",
      connected: true,
      permissions,
      balances,
      balance_count: balances.length,
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
      blockers: [code],
      error_code: code,
      order_execution_available: false,
      live_trading_enabled: false
    };
  }
}
