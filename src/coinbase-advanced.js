const API_HOST = "api.coinbase.com";
const API_BASE = "https://" + API_HOST;
const API_PREFIX = "/api/v3/brokerage";
const REQUEST_TIMEOUT_MS = 10000;
const MAX_ALLOWED_PRODUCTS = 12;

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function concatBytes(...parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function derLength(length) {
  if (!Number.isSafeInteger(length) || length < 0) throw new Error("coinbase_key_der_length_invalid");
  if (length < 128) return Uint8Array.of(length);
  const bytes = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function der(tag, content) {
  return concatBytes(Uint8Array.of(tag), derLength(content.length), content);
}

function decodeBase64(value, errorCode) {
  const encoded = String(value || "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
    throw new Error(errorCode);
  }
  const padded = encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
  let binary;
  try { binary = atob(padded); } catch { throw new Error(errorCode); }
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function parsePem(pem) {
  if (typeof pem !== "string" || pem.length > 12000) {
    throw new Error("coinbase_private_key_missing_or_invalid");
  }
  const match = pem.trim().match(/^-----BEGIN (EC PRIVATE KEY|PRIVATE KEY)-----([\s\S]+?)-----END \1-----$/);
  if (!match) return null;
  return {
    label: match[1],
    derBytes: decodeBase64(match[2], "coinbase_private_key_pem_base64_invalid")
  };
}

function sec1ToPkcs8(sec1Bytes) {
  // PKCS#8 PrivateKeyInfo wrapper for id-ecPublicKey / prime256v1 (P-256).
  const ecPublicKeyOid = Uint8Array.of(0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01);
  const prime256v1Oid = Uint8Array.of(0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07);
  const algorithm = der(0x30, concatBytes(ecPublicKeyOid, prime256v1Oid));
  const version = der(0x02, Uint8Array.of(0x00));
  const privateKey = der(0x04, sec1Bytes);
  return der(0x30, concatBytes(version, algorithm, privateKey));
}

function ed25519SeedToPkcs8(seed) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) {
    throw new Error("coinbase_ed25519_seed_length_invalid");
  }
  // RFC 8410 PrivateKeyInfo: id-Ed25519 OID + nested 32-byte private seed.
  const ed25519Oid = Uint8Array.of(0x06, 0x03, 0x2b, 0x65, 0x70);
  const algorithm = der(0x30, ed25519Oid);
  const version = der(0x02, Uint8Array.of(0x00));
  const privateKey = der(0x04, der(0x04, seed));
  return der(0x30, concatBytes(version, algorithm, privateKey));
}

async function importPrivateKey(secret) {
  if (typeof secret !== "string" || !secret.trim() || secret.length > 12000) {
    throw new Error("coinbase_private_key_missing_or_invalid");
  }
  const value = secret.trim();
  const parsed = parsePem(value);

  if (!parsed) {
    // Current CDP keys may be downloaded as raw Base64 Ed25519 seed or
    // seed||public-key (32 or 64 bytes). Match Coinbase's official SDK.
    const raw = decodeBase64(value, "coinbase_private_key_base64_invalid");
    if (raw.length !== 32 && raw.length !== 64) {
      throw new Error("coinbase_ed25519_raw_key_length_invalid");
    }
    const key = await crypto.subtle.importKey(
      "pkcs8", ed25519SeedToPkcs8(raw.subarray(0, 32)), { name: "Ed25519" }, false, ["sign"]
    );
    return { key, jwtAlgorithm: "EdDSA", signAlgorithm: { name: "Ed25519" }, keyFormat: "ed25519_base64" };
  }

  if (parsed.label === "EC PRIVATE KEY") {
    try {
      const key = await crypto.subtle.importKey(
        "pkcs8", sec1ToPkcs8(parsed.derBytes), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
      );
      return { key, jwtAlgorithm: "ES256", signAlgorithm: { name: "ECDSA", hash: "SHA-256" }, keyFormat: "ecdsa_sec1_pem" };
    } catch {
      throw new Error("coinbase_private_key_import_failed_check_ecdsa_p256_key");
    }
  }

  // PKCS#8 PEM is used by both Ed25519 and ECDSA CDP credentials.
  // Try the recommended Ed25519 type first, then retain P-256 compatibility.
  try {
    const key = await crypto.subtle.importKey(
      "pkcs8", parsed.derBytes, { name: "Ed25519" }, false, ["sign"]
    );
    return { key, jwtAlgorithm: "EdDSA", signAlgorithm: { name: "Ed25519" }, keyFormat: "ed25519_pkcs8_pem" };
  } catch {
    try {
      const key = await crypto.subtle.importKey(
        "pkcs8", parsed.derBytes, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
      );
      return { key, jwtAlgorithm: "ES256", signAlgorithm: { name: "ECDSA", hash: "SHA-256" }, keyFormat: "ecdsa_pkcs8_pem" };
    } catch {
      throw new Error("coinbase_private_key_import_failed_check_ed25519_or_ecdsa_p256");
    }
  }
}

function nonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function createCoinbaseAdvancedJwt({
  apiKey,
  privateKeyPem,
  method,
  path,
  nowSeconds = Math.floor(Date.now() / 1000)
}) {
  if (typeof apiKey !== "string" || !apiKey.trim() ||
      typeof path !== "string" || !path.startsWith(API_PREFIX + "/") ||
      !["GET", "POST", "DELETE"].includes(String(method).toUpperCase()) ||
      !Number.isSafeInteger(nowSeconds)) {
    throw new Error("coinbase_jwt_request_invalid");
  }
  const imported = await importPrivateKey(privateKeyPem);
  const uri = String(method).toUpperCase() + " " + API_HOST + path;
  const header = { alg: imported.jwtAlgorithm, kid: apiKey, nonce: nonce(), typ: "JWT" };
  const payload = {
    iss: "cdp",
    sub: apiKey,
    nbf: nowSeconds,
    exp: nowSeconds + 90,
    uri
  };
  const encodedHeader = base64Url(new TextEncoder().encode(JSON.stringify(header)));
  const encodedPayload = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = encodedHeader + "." + encodedPayload;
  const signature = await crypto.subtle.sign(
    imported.signAlgorithm,
    imported.key,
    new TextEncoder().encode(signingInput)
  );
  return signingInput + "." + base64Url(new Uint8Array(signature));
}

function credentialKeyFormatHint(value) {
  const secret = String(value || "").trim();
  if (!secret) return "missing";
  if (secret.startsWith("-----BEGIN EC PRIVATE KEY-----")) return "ecdsa_p256_sec1_pem";
  if (secret.startsWith("-----BEGIN PRIVATE KEY-----")) return "pkcs8_ed25519_or_ecdsa_pem";
  if (/^[A-Za-z0-9+/=\\s]+$/.test(secret)) return "ed25519_base64_candidate";
  return "unknown_format";
}

function configuration(env = {}) {
  const apiKey = String(env.COINBASE_ADVANCED_API_KEY || "").trim();
  const privateKeyPem = String(env.COINBASE_ADVANCED_API_SECRET || "").replace(/\\n/g, "\n");
  const allowedProducts = String(env.COINBASE_ADVANCED_ALLOWED_PRODUCTS || "")
    .split(",").map((item) => item.trim().toUpperCase())
    .filter(Boolean).filter((item, index, all) => all.indexOf(item) === index);
  const maxOrderQuote = Number(env.COINBASE_ADVANCED_MAX_ORDER_QUOTE);
  const orderExecutionEnabled = String(env.COINBASE_ADVANCED_ORDER_ENABLED || "").trim().toLowerCase() === "true";
  const maxOpenOrders = Number(env.COINBASE_ADVANCED_MAX_OPEN_ORDERS || 1);
  const maxDailyOrders = Number(env.COINBASE_ADVANCED_MAX_DAILY_ORDERS || 1);
  return {
    apiKey,
    privateKeyPem,
    privateKeyFormatHint: credentialKeyFormatHint(privateKeyPem),
    allowedProducts: allowedProducts.slice(0, MAX_ALLOWED_PRODUCTS),
    allowedProductsValid: allowedProducts.length > 0 && allowedProducts.length <= MAX_ALLOWED_PRODUCTS,
    maxOrderQuote,
    maxOrderQuoteValid: Number.isFinite(maxOrderQuote) && maxOrderQuote > 0,
    orderExecutionEnabled,
    maxOpenOrders: Number.isSafeInteger(maxOpenOrders) && maxOpenOrders >= 1 && maxOpenOrders <= 3 ? maxOpenOrders : 0,
    maxDailyOrders: Number.isSafeInteger(maxDailyOrders) && maxDailyOrders >= 1 && maxDailyOrders <= 5 ? maxDailyOrders : 0,
    credentialsConfigured: !!apiKey && !!privateKeyPem
  };
}

export function coinbaseAdvancedStatus(env = {}) {
  const config = configuration(env);
  const blockers = [];
  if (!config.credentialsConfigured) blockers.push("coinbase_advanced_credentials_not_configured");
  if (!config.allowedProductsValid) blockers.push("explicit_spot_product_allowlist_required");
  if (!config.maxOrderQuoteValid) blockers.push("maximum_order_quote_cap_required");
  return {
    provider: "coinbase_advanced_trade",
    mode: "live_setup_locked",
    credentials_configured: config.credentialsConfigured,
    credential_key_format_hint: config.privateKeyFormatHint,
    supported_private_key_formats: ["Ed25519 Base64 (32/64 bytes)", "Ed25519 PKCS#8 PEM", "ECDSA P-256 SEC1 PEM"],
    allowed_products_configured: config.allowedProductsValid,
    allowed_products: config.allowedProducts,
    max_order_quote_configured: config.maxOrderQuoteValid,
    max_order_quote: config.maxOrderQuoteValid ? config.maxOrderQuote : null,
    account_preflight_available: config.credentialsConfigured,
    order_preview_available: blockers.length === 0,
    // Static status cannot prove the key has Trade permission or that a fresh
    // account preflight succeeded. Only the authenticated preflight may report
    // order_submission_available=true.
    order_submission_available: false,
    order_submission_configured: config.credentialsConfigured &&
      config.orderExecutionEnabled && blockers.length === 0 &&
      config.maxOpenOrders > 0 && config.maxDailyOrders > 0,
    order_execution_configured: config.orderExecutionEnabled,
    max_open_orders: config.maxOpenOrders || null,
    max_daily_orders: config.maxDailyOrders || null,
    live_trading_enabled: false,
    automatic_live_entries_enabled: false,
    withdrawal_permission_required: false,
    blockers
  };
}

async function advancedRequest(env, method, path, body, fetchImpl) {
  const config = configuration(env);
  if (!config.credentialsConfigured) {
    const error = new Error("coinbase_advanced_credentials_not_configured");
    error.code = "coinbase_advanced_credentials_not_configured";
    error.status = 503;
    throw error;
  }
  const jwt = await createCoinbaseAdvancedJwt({
    apiKey: config.apiKey,
    privateKeyPem: config.privateKeyPem,
    method,
    path
  });
  let response;
  try {
    response = await fetchImpl(API_BASE + path, {
      method,
      headers: {
        Authorization: "Bearer " + jwt,
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch {
    const error = new Error("coinbase_advanced_network_request_failed");
    error.code = "coinbase_advanced_network_request_failed";
    error.status = 502;
    throw error;
  }
  let payload = {};
  try { payload = await response.json(); } catch { /* Sanitized below. */ }
  if (!response.ok) {
    const status = response.status === 429 ? 429 : response.status >= 500 ? 502 : 409;
    const error = new Error(
      response.status === 401 || response.status === 403
        ? "coinbase_advanced_auth_or_permission_rejected"
        : response.status === 429
          ? "coinbase_advanced_rate_limited"
          : "coinbase_advanced_provider_rejected_request"
    );
    error.code = response.status === 401 || response.status === 403
      ? "coinbase_advanced_auth_or_permission_rejected"
      : response.status === 429
        ? "coinbase_advanced_rate_limited"
        : "coinbase_advanced_provider_rejected_request";
    error.status = status;
    throw error;
  }
  return payload;
}

function validMoney(value) {
  return typeof value === "string" && value.length <= 40 &&
    /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && Number(value) > 0 && Number.isFinite(Number(value));
}

function decimalParts(value) {
  if (typeof value !== "string" || value.length > 40 ||
      !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) ||
      !Number.isFinite(Number(value)) || Number(value) < 0) return null;
  const [whole, fractional = ""] = value.split(".");
  return { digits: BigInt(whole + fractional), scale: fractional.length };
}

function decimalAlign(left, right) {
  const scale = Math.max(left.scale, right.scale);
  return {
    left: left.digits * (10n ** BigInt(scale - left.scale)),
    right: right.digits * (10n ** BigInt(scale - right.scale))
  };
}

function isIncrementMultiple(value, increment) {
  const left = decimalParts(value);
  const right = decimalParts(increment);
  if (!left || !right || right.digits <= 0n) return false;
  const aligned = decimalAlign(left, right);
  return aligned.left % aligned.right === 0n;
}

function compareDecimalStrings(left, right) {
  const a = decimalParts(left);
  const b = decimalParts(right);
  if (!a || !b) return null;
  const aligned = decimalAlign(a, b);
  return aligned.left < aligned.right ? -1 : aligned.left > aligned.right ? 1 : 0;
}

function addDecimalStrings(left, right) {
  const a = decimalParts(left);
  const b = decimalParts(right);
  if (!a || !b) return null;
  const aligned = decimalAlign(a, b);
  const scale = Math.max(a.scale, b.scale);
  const sum = aligned.left + aligned.right;
  const digits = sum.toString().padStart(scale + 1, "0");
  if (!scale) return digits;
  return digits.slice(0, -scale) + "." + digits.slice(-scale);
}

async function loadAccounts(env, fetchImpl) {
  const accounts = [];
  let cursor = "";
  for (let page = 0; page < 5; page += 1) {
    const query = cursor ? "?limit=250&cursor=" + encodeURIComponent(cursor) : "?limit=250";
    const payload = await advancedRequest(
      env, "GET", API_PREFIX + "/accounts" + query, undefined, fetchImpl
    );
    if (!Array.isArray(payload.accounts)) throw new Error("coinbase_advanced_accounts_response_invalid");
    accounts.push(...payload.accounts);
    if (payload.has_next !== true) return accounts;
    if (typeof payload.cursor !== "string" || !payload.cursor) {
      throw new Error("coinbase_advanced_accounts_pagination_invalid");
    }
    cursor = payload.cursor;
  }
  throw new Error("coinbase_advanced_accounts_pagination_incomplete");
}

function accountBalancesForProducts(accounts, products) {
  const currencies = new Set(products.flatMap((product) => [
    String(product.quote_currency_id || "").toUpperCase(),
    String(product.base_currency_id || "").toUpperCase()
  ]).filter(Boolean));
  const balances = {};
  for (const account of accounts) {
    const currency = String(account?.currency || "").toUpperCase();
    if (!currencies.has(currency)) continue;
    const available = account?.available_balance?.value;
    if (!validNonNegativeMoney(available)) continue;
    balances[currency] = addDecimalStrings(balances[currency] || "0", String(available)) || "0";
  }
  return balances;
}

function validNonNegativeMoney(value) {
  return typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) &&
    Number.isFinite(Number(value));
}

function inspectProduct(product, productId) {
  const blockers = [];
  if (!product || product.product_id !== productId) blockers.push("product_id_mismatch");
  if (product?.product_type !== "SPOT") blockers.push("product_not_verified_spot");
  if (product?.is_disabled === true || product?.trading_disabled === true) blockers.push("product_trading_disabled");
  if (product?.cancel_only === true || product?.view_only === true) blockers.push("product_not_open_for_new_orders");
  if (!validMoney(String(product?.quote_min_size || "")) ||
      !validMoney(String(product?.quote_max_size || "")) ||
      compareDecimalStrings(String(product.quote_max_size), String(product.quote_min_size)) < 0) {
    blockers.push("product_quote_size_limits_unavailable");
  }
  if (!validMoney(String(product?.quote_increment || "")) ||
      !validMoney(String(product?.price_increment || ""))) {
    blockers.push("product_increment_metadata_unavailable");
  }
  if (!product?.quote_currency_id) blockers.push("product_quote_currency_unavailable");
  return { eligible: blockers.length === 0, blockers };
}

export async function preflightCoinbaseAdvanced(env = {}, { fetchImpl = fetch } = {}) {
  const config = configuration(env);
  const staticStatus = coinbaseAdvancedStatus(env);
  if (!config.credentialsConfigured) {
    return {
      ...staticStatus,
      status: "not_configured",
      permissions: null,
      balances: {},
      products: [],
      blockers: staticStatus.blockers
    };
  }
  try {
    const permissions = await advancedRequest(
      env, "GET", API_PREFIX + "/key_permissions", undefined, fetchImpl
    );
    const blockers = [...staticStatus.blockers];
    if (permissions.can_view !== true) blockers.push("api_key_view_permission_required");
    if (permissions.can_transfer !== false) blockers.push("api_key_transfer_permission_must_be_disabled");
    if (!config.allowedProductsValid) {
      return {
        ...staticStatus, status: "blocked", permissions: {
          can_view: permissions.can_view === true,
          can_trade: permissions.can_trade === true,
          can_transfer: permissions.can_transfer === true
        }, balances: {}, products: [], blockers: [...new Set(blockers)]
      };
    }
    if (permissions.can_view !== true || permissions.can_transfer !== false) {
      return {
        ...staticStatus, status: "blocked", permissions: {
          can_view: permissions.can_view === true,
          can_trade: permissions.can_trade === true,
          can_transfer: permissions.can_transfer === true
        }, balances: {}, products: [], blockers: [...new Set(blockers)]
      };
    }
    const accounts = await loadAccounts(env, fetchImpl);
    const products = [];
    for (const productId of config.allowedProducts) {
      const payload = await advancedRequest(
        env, "GET", API_PREFIX + "/products/" + encodeURIComponent(productId), undefined, fetchImpl
      );
      const check = inspectProduct(payload, productId);
      products.push({
        product_id: productId,
        eligible: check.eligible,
        blockers: check.blockers,
        quote_currency_id: payload.quote_currency_id || null,
        base_currency_id: payload.base_currency_id || null,
        product_type: payload.product_type || null,
        quote_min_size: payload.quote_min_size || null,
        quote_max_size: payload.quote_max_size || null,
        quote_increment: payload.quote_increment || null,
        base_min_size: payload.base_min_size || null,
        base_max_size: payload.base_max_size || null,
        base_increment: payload.base_increment || null,
        price_increment: payload.price_increment || null,
        is_disabled: payload.is_disabled === true,
        trading_disabled: payload.trading_disabled === true,
        cancel_only: payload.cancel_only === true
      });
      if (!check.eligible) blockers.push(...check.blockers.map((item) => productId + ":" + item));
    }
    const balances = accountBalancesForProducts(accounts, products);
    const eligibleProducts = products.filter((product) => product.eligible);
    for (const product of eligibleProducts) {
      if (!Object.hasOwn(balances, product.quote_currency_id)) {
        blockers.push(product.product_id + ":quote_currency_account_not_found");
      }
    }
    const blocking = [...new Set(blockers)];
    const ready = blocking.length === 0 && eligibleProducts.length > 0;
    return {
      ...staticStatus,
      status: ready ? "preflight_ready_for_manual_order_preview" : "blocked",
      permissions: {
        can_view: permissions.can_view === true,
        can_trade: permissions.can_trade === true,
        can_transfer: permissions.can_transfer === true
      },
      portfolio_uuid: typeof permissions.portfolio_uuid === "string" ? permissions.portfolio_uuid : null,
      balances,
      products,
      eligible_products: eligibleProducts.map((product) => product.product_id),
      account_count: accounts.length,
      account_pagination_complete: true,
      order_submission_available: ready && config.orderExecutionEnabled &&
        config.maxOpenOrders > 0 && config.maxDailyOrders > 0 &&
        permissions.can_trade === true,
      order_submission_configured: config.credentialsConfigured &&
        config.orderExecutionEnabled && config.maxOpenOrders > 0 &&
        config.maxDailyOrders > 0,
      live_trading_enabled: false,
      automatic_live_entries_enabled: false,
      blockers: blocking
    };
  } catch (error) {
    const messageCode = typeof error?.message === "string" &&
      /^[a-z0-9_]{1,100}$/.test(error.message) ? error.message : null;
    const code = typeof error?.code === "string" ? error.code
      : messageCode || "coinbase_advanced_preflight_failed";
    return {
      ...staticStatus,
      status: "provider_check_failed",
      permissions: null,
      balances: {},
      products: [],
      order_submission_available: false,
      live_trading_enabled: false,
      automatic_live_entries_enabled: false,
      blockers: [...staticStatus.blockers, code]
    };
  }
}

export async function previewCoinbaseAdvancedLimitBuy(
  env = {},
  { productId, quoteSize, baseSize, limitPrice, side = "BUY" } = {},
  { fetchImpl = fetch } = {}
) {
  const config = configuration(env);
  const selectedSide = String(side || "BUY").toUpperCase();
  if (!["BUY", "SELL"].includes(selectedSide)) {
    return { status: "blocked", decision: "NO_ORDER", blockers: ["supported_order_side_required"], order_submission_available: false };
  }
  if (!config.maxOrderQuoteValid || !config.allowedProductsValid) {
    return { status: "blocked", decision: "NO_ORDER", blockers: coinbaseAdvancedStatus(env).blockers, order_submission_available: false };
  }
  const selectedProduct = String(productId || "").trim().toUpperCase();
  if (!config.allowedProducts.includes(selectedProduct)) {
    return { status: "blocked", decision: "NO_ORDER", blockers: ["product_not_on_explicit_allowlist"], order_submission_available: false };
  }
  const size = selectedSide === "BUY" ? quoteSize : baseSize;
  if (!validMoney(size) || !validMoney(limitPrice)) {
    return { status: "blocked", decision: "NO_ORDER", blockers: [selectedSide === "BUY" ? "positive_decimal_quote_size_and_limit_price_required" : "positive_decimal_base_size_and_limit_price_required"], order_submission_available: false };
  }
  const estimatedQuote = selectedSide === "BUY" ? Number(quoteSize) : Number(baseSize) * Number(limitPrice);
  if (!Number.isFinite(estimatedQuote) || estimatedQuote <= 0 || estimatedQuote > config.maxOrderQuote) {
    return { status: "blocked", decision: "NO_ORDER", blockers: ["live_order_quote_cap_exceeded"], order_submission_available: false };
  }

  const preflight = await preflightCoinbaseAdvanced(env, { fetchImpl });
  if (preflight.status !== "preflight_ready_for_manual_order_preview") {
    return { status: "blocked", decision: "NO_ORDER", blockers: preflight.blockers, order_submission_available: false, live_trading_enabled: false };
  }
  const product = preflight.products.find((item) => item.product_id === selectedProduct && item.eligible);
  if (!product) return { status: "blocked", decision: "NO_ORDER", blockers: ["product_not_preflight_eligible"], order_submission_available: false };

  if (selectedSide === "BUY") {
    if (compareDecimalStrings(quoteSize, product.quote_min_size) < 0 ||
        compareDecimalStrings(quoteSize, product.quote_max_size) > 0) {
      return { status: "blocked", decision: "NO_ORDER", blockers: ["quote_size_outside_exchange_product_limits"], order_submission_available: false };
    }
    if (!isIncrementMultiple(quoteSize, product.quote_increment)) {
      return { status: "blocked", decision: "NO_ORDER", blockers: ["quote_size_not_aligned_to_exchange_increment"], order_submission_available: false };
    }
  } else {
    if (!validMoney(String(product.base_min_size || "")) ||
        !validMoney(String(product.base_max_size || "")) ||
        !validMoney(String(product.base_increment || "")) ||
        compareDecimalStrings(baseSize, product.base_min_size) < 0 ||
        compareDecimalStrings(baseSize, product.base_max_size) > 0) {
      return { status: "blocked", decision: "NO_ORDER", blockers: ["base_size_outside_exchange_product_limits"], order_submission_available: false };
    }
    if (!isIncrementMultiple(baseSize, product.base_increment)) {
      return { status: "blocked", decision: "NO_ORDER", blockers: ["base_size_not_aligned_to_exchange_increment"], order_submission_available: false };
    }
  }
  if (!isIncrementMultiple(limitPrice, product.price_increment)) {
    return { status: "blocked", decision: "NO_ORDER", blockers: ["limit_price_not_aligned_to_exchange_increment"], order_submission_available: false };
  }
  const balanceCurrency = selectedSide === "BUY" ? product.quote_currency_id : product.base_currency_id;
  const available = preflight.balances[balanceCurrency];
  if (!validNonNegativeMoney(available) || compareDecimalStrings(available, size) < 0) {
    return { status: "blocked", decision: "NO_ORDER", blockers: [selectedSide === "BUY" ? "insufficient_available_quote_balance" : "insufficient_available_base_balance"], order_submission_available: false };
  }

  const sizeField = selectedSide === "BUY" ? { quote_size: quoteSize } : { base_size: baseSize };
  const preview = await advancedRequest(env, "POST", API_PREFIX + "/orders/preview", {
    product_id: selectedProduct,
    side: selectedSide,
    order_configuration: { limit_limit_gtc: { ...sizeField, limit_price: limitPrice, post_only: true } }
  }, fetchImpl);

  const errors = Array.isArray(preview.errs) ? preview.errs.map((item) => String(item).slice(0, 120)) : [];
  const commission = validNonNegativeMoney(String(preview.commission_total ?? "")) ? String(preview.commission_total) : null;
  if (errors.length || typeof preview.preview_id !== "string" || !preview.preview_id || commission === null) {
    return { status: "preview_rejected", decision: "NO_ORDER", product_id: selectedProduct, side: selectedSide,
      quote_size: selectedSide === "BUY" ? quoteSize : null, base_size: selectedSide === "SELL" ? baseSize : null,
      limit_price: limitPrice, commission_total: commission, preview_errors: errors,
      order_submission_available: false, live_trading_enabled: false };
  }
  if (selectedSide === "BUY") {
    const requiredQuote = addDecimalStrings(quoteSize, commission);
    if (!requiredQuote || compareDecimalStrings(available, requiredQuote) < 0) {
      return { status: "blocked", decision: "NO_ORDER", product_id: selectedProduct, quote_size: quoteSize,
        limit_price: limitPrice, commission_total: commission, blockers: ["available_quote_balance_below_order_plus_previewed_fee"], order_submission_available: false };
    }
  }
  return {
    status: "preview_ready", decision: "PREVIEW_ONLY", provider: "coinbase_advanced_trade",
    product_id: selectedProduct, side: selectedSide, order_type: "LIMIT_GTC_POST_ONLY",
    quote_size: selectedSide === "BUY" ? quoteSize : null,
    base_size: selectedSide === "SELL" ? baseSize : null,
    limit_price: limitPrice, commission_total: commission,
    estimated_order_total: preview.order_total || null, best_bid: preview.best_bid || null,
    best_ask: preview.best_ask || null, slippage: preview.slippage || null,
    preview_id: preview.preview_id, available_balance: available,
    balance_currency: balanceCurrency, quote_currency: product.quote_currency_id,
    permissions: preflight.permissions,
    checked_at_ms: Date.now(),
    order_submission_available: config.orderExecutionEnabled && config.maxOpenOrders > 0 && config.maxDailyOrders > 0 && preflight.permissions?.can_trade === true,
    live_trading_enabled: false, automatic_live_entries_enabled: false,
    warning: "Preview only. No order has been submitted. A separate explicit confirmation is required."
  };
}

export function coinbaseAdvancedErrorStatus(error) {
  const status = Number(error?.status);
  return status >= 400 && status < 600 ? status : 502;
}


const ACTIVE_ORDER_STATUSES = new Set(["SUBMITTING", "UNKNOWN", "PENDING", "OPEN", "QUEUED", "PARTIALLY_FILLED"]);

function validClientOrderId(value) {
  return typeof value === "string" && /^[A-Za-z0-9-]{16,64}$/.test(value);
}

function sanitizeOrder(order) {
  if (!order || typeof order !== "object") return null;
  const status = String(order.status || "").toUpperCase();
  const known = new Set([
    "PENDING", "OPEN", "FILLED", "CANCELLED", "CANCELED", "EXPIRED",
    "FAILED", "QUEUED", "CANCEL_QUEUED", "EDIT_QUEUED", "UNKNOWN"
  ]);
  return {
    order_id: typeof order.order_id === "string" ? order.order_id : null,
    client_order_id: typeof order.client_order_id === "string" ? order.client_order_id : null,
    product_id: typeof order.product_id === "string" ? order.product_id : null,
    side: order.side === "BUY" || order.side === "SELL" ? order.side : null,
    status: known.has(status) ? status : "UNKNOWN",
    filled_size: validNonNegativeMoney(String(order.filled_size ?? "")) ? String(order.filled_size) : "0",
    average_filled_price: validNonNegativeMoney(String(order.average_filled_price ?? "")) ? String(order.average_filled_price) : null,
    filled_value: validNonNegativeMoney(String(order.filled_value ?? "")) ? String(order.filled_value) : null,
    total_fees: validNonNegativeMoney(String(order.total_fees ?? "")) ? String(order.total_fees) : null,
    total_fees_native: order.total_fees_native && typeof order.total_fees_native === "object" &&
      validNonNegativeMoney(String(order.total_fees_native.value ?? "")) &&
      typeof order.total_fees_native.currency === "string" &&
      /^[A-Z0-9]{2,12}$/.test(order.total_fees_native.currency)
      ? { value: String(order.total_fees_native.value), currency: order.total_fees_native.currency } : null,
    total_value_after_fees_native: order.total_value_after_fees_native &&
      typeof order.total_value_after_fees_native === "object" &&
      validNonNegativeMoney(String(order.total_value_after_fees_native.value ?? "")) &&
      typeof order.total_value_after_fees_native.currency === "string" &&
      /^[A-Z0-9]{2,12}$/.test(order.total_value_after_fees_native.currency)
      ? { value: String(order.total_value_after_fees_native.value), currency: order.total_value_after_fees_native.currency } : null,
    commission_detail_total: order.commission_detail_total && typeof order.commission_detail_total === "object"
      ? Object.fromEntries(["total_commission", "gst_commission", "withholding_commission",
        "client_commission", "venue_commission", "regulatory_commission", "clearing_commission"]
        .map((key) => [key, validNonNegativeMoney(String(order.commission_detail_total[key] ?? ""))
          ? String(order.commission_detail_total[key]) : null]))
      : null,
    completion_percentage: validNonNegativeMoney(String(order.completion_percentage ?? "")) ? String(order.completion_percentage) : "0",
    created_time: typeof order.created_time === "string" ? order.created_time : null,
    last_update_time: typeof order.last_update_time === "string" ? order.last_update_time : null,
    pending_cancel: order.pending_cancel === true,
    reject_reason: typeof order.reject_reason === "string" ? order.reject_reason.slice(0, 80) : null
  };
}

export async function submitCoinbaseAdvancedLimitBuy(
  env = {},
  { productId, quoteSize, baseSize, limitPrice, commissionTotal, previewId, clientOrderId, side = "BUY" } = {},
  { fetchImpl = fetch } = {}
) {
  const config = configuration(env);
  const selectedSide = String(side || "BUY").toUpperCase();
  if (!config.orderExecutionEnabled || config.maxOpenOrders < 1 || config.maxDailyOrders < 1) {
    return { status: "blocked", decision: "NO_ORDER", blockers: ["live_order_execution_switch_is_off"], order_submission_available: false };
  }
  if (!["BUY", "SELL"].includes(selectedSide)) {
    return { status: "blocked", decision: "NO_ORDER", blockers: ["supported_order_side_required"], order_submission_available: false };
  }
  const selectedProduct = String(productId || "").trim().toUpperCase();
  const size = selectedSide === "BUY" ? quoteSize : baseSize;
  const estimatedQuote = selectedSide === "BUY" ? Number(quoteSize) : Number(baseSize) * Number(limitPrice);
  if (!config.allowedProducts.includes(selectedProduct)) {
    return { status: "blocked", decision: "NO_ORDER", blockers: ["product_not_on_explicit_allowlist"], order_submission_available: false };
  }
  if (!config.maxOrderQuoteValid || !validMoney(size) || !validMoney(limitPrice) ||
      !Number.isFinite(estimatedQuote) || estimatedQuote <= 0 || estimatedQuote > config.maxOrderQuote ||
      typeof previewId !== "string" || previewId.length < 8 || previewId.length > 200 || !validClientOrderId(clientOrderId)) {
    return { status: "blocked", decision: "NO_ORDER", blockers: ["live_order_request_invalid_or_over_cap"], order_submission_available: false };
  }
  const preflight = await preflightCoinbaseAdvanced(env, { fetchImpl });
  if (preflight.status !== "preflight_ready_for_manual_order_preview" || preflight.permissions?.can_trade !== true) {
    return { status: "blocked", decision: "NO_ORDER", blockers: [...(preflight.blockers || []), ...(preflight.permissions?.can_trade === true ? [] : ["api_key_trade_permission_required_for_manual_orders"])], order_submission_available: false };
  }
  const product = preflight.products.find((item) => item.product_id === selectedProduct && item.eligible);
  if (!product) return { status: "blocked", decision: "NO_ORDER", blockers: ["product_not_preflight_eligible"], order_submission_available: false };
  if (selectedSide === "BUY") {
    if (compareDecimalStrings(quoteSize, product.quote_min_size) < 0 ||
        compareDecimalStrings(quoteSize, product.quote_max_size) > 0 ||
        !isIncrementMultiple(quoteSize, product.quote_increment)) {
      return { status: "blocked", decision: "NO_ORDER", blockers: ["live_order_exchange_size_or_price_filter_failed"], order_submission_available: false };
    }
  } else if (!validMoney(String(product.base_min_size || "")) ||
      !validMoney(String(product.base_max_size || "")) ||
      !validMoney(String(product.base_increment || "")) ||
      compareDecimalStrings(baseSize, product.base_min_size) < 0 ||
      compareDecimalStrings(baseSize, product.base_max_size) > 0 ||
      !isIncrementMultiple(baseSize, product.base_increment)) {
    return { status: "blocked", decision: "NO_ORDER", blockers: ["live_order_base_size_filter_failed"], order_submission_available: false };
  }
  if (!isIncrementMultiple(limitPrice, product.price_increment) || !validNonNegativeMoney(String(commissionTotal ?? ""))) {
    return { status: "blocked", decision: "NO_ORDER", blockers: ["live_order_price_increment_or_preview_fee_invalid"], order_submission_available: false };
  }
  const balanceCurrency = selectedSide === "BUY" ? product.quote_currency_id : product.base_currency_id;
  const available = preflight.balances[balanceCurrency];
  if (!validNonNegativeMoney(available) || compareDecimalStrings(available, size) < 0) {
    return { status: "blocked", decision: "NO_ORDER", blockers: [selectedSide === "BUY" ? "insufficient_available_quote_balance_for_order" : "insufficient_available_base_balance_for_order"], order_submission_available: false };
  }
  if (selectedSide === "BUY") {
    const requiredQuote = addDecimalStrings(quoteSize, String(commissionTotal));
    if (!requiredQuote || compareDecimalStrings(available, requiredQuote) < 0) {
      return { status: "blocked", decision: "NO_ORDER", blockers: ["insufficient_available_quote_balance_for_order_and_fee"], order_submission_available: false };
    }
  }
  const sizeField = selectedSide === "BUY" ? { quote_size: quoteSize } : { base_size: baseSize };
  let response;
  try {
    response = await advancedRequest(env, "POST", API_PREFIX + "/orders", {
      client_order_id: clientOrderId, product_id: selectedProduct, side: selectedSide,
      order_configuration: { limit_limit_gtc: { ...sizeField, limit_price: limitPrice, post_only: true } },
      preview_id: previewId
    }, fetchImpl);
  } catch (error) {
    error.ambiguousSubmission = Number(error?.status) >= 500 || error?.code === "coinbase_advanced_network_request_failed";
    throw error;
  }
  if (response.success === true && typeof response.success_response?.order_id === "string" && response.success_response.order_id) {
    return {
      status: "PENDING", decision: "LIVE_ORDER_ACCEPTED", client_order_id: clientOrderId,
      exchange_order_id: response.success_response.order_id, product_id: selectedProduct,
      side: selectedSide, order_type: "LIMIT_GTC_POST_ONLY",
      quote_size: selectedSide === "BUY" ? quoteSize : null,
      base_size: selectedSide === "SELL" ? baseSize : null,
      limit_price: limitPrice, quote_currency: product.quote_currency_id,
      order_submission_available: true, live_trading_enabled: true,
      automatic_live_entries_enabled: false,
      warning: "Exchange accepted the order. It may remain open or partially fill; reconcile status and confirm fills before assuming a trade occurred."
    };
  }
  if (response.success === false) {
    return {
      status: "REJECTED", decision: "NO_ORDER", client_order_id: clientOrderId,
      product_id: selectedProduct, side: selectedSide,
      error: typeof response.error_response?.message === "string" ? response.error_response.message.slice(0, 180) : "coinbase_order_rejected",
      error_code: typeof response.error_response?.error === "string" ? response.error_response.error.slice(0, 80) : null,
      order_submission_available: true, live_trading_enabled: false
    };
  }
  const error = new Error("coinbase_order_submission_response_ambiguous");
  error.code = "coinbase_order_submission_response_ambiguous";
  error.status = 502;
  error.ambiguousSubmission = true;
  throw error;
}

export async function reconcileCoinbaseAdvancedOrder(
  env = {},
  { productId, clientOrderId, exchangeOrderId, createdAtMs } = {},
  { fetchImpl = fetch } = {}
) {
  if (!configuration(env).credentialsConfigured ||
      !validClientOrderId(clientOrderId)) {
    return { status: "blocked", found: false, blockers: ["order_reconciliation_inputs_invalid"] };
  }
  if (typeof exchangeOrderId === "string" && exchangeOrderId) {
    const payload = await advancedRequest(
      env, "GET", API_PREFIX + "/orders/historical/" + encodeURIComponent(exchangeOrderId),
      undefined, fetchImpl
    );
    const order = sanitizeOrder(payload.order);
    if (order?.client_order_id !== clientOrderId) {
      return { status: "mismatch", found: false, blockers: ["exchange_order_client_id_mismatch"] };
    }
    return { status: order.status, found: true, order };
  }

  if (typeof productId !== "string" || !productId || !Number.isFinite(createdAtMs) || createdAtMs <= 0) {
    return { status: "blocked", found: false, blockers: ["order_reconciliation_inputs_invalid"] };
  }
  const startDate = new Date(Math.max(0, createdAtMs - 120000)).toISOString();
  let cursor = "";
  for (let page = 0; page < 3; page += 1) {
    const query = new URLSearchParams({
      product_ids: productId,
      start_date: startDate,
      limit: "100"
    });
    if (cursor) query.set("cursor", cursor);
    const payload = await advancedRequest(
      env, "GET", API_PREFIX + "/orders/historical/batch?" + query.toString(),
      undefined, fetchImpl
    );
    if (!Array.isArray(payload.orders)) throw new Error("coinbase_advanced_order_history_response_invalid");
    const matched = payload.orders.find((order) => order?.client_order_id === clientOrderId);
    if (matched) {
      const order = sanitizeOrder(matched);
      return { status: order.status, found: true, order };
    }
    if (payload.has_next !== true) return { status: "UNKNOWN", found: false, blockers: ["order_not_yet_visible_in_exchange_history"] };
    if (typeof payload.cursor !== "string" || !payload.cursor) {
      throw new Error("coinbase_advanced_order_history_pagination_invalid");
    }
    cursor = payload.cursor;
  }
  return { status: "UNKNOWN", found: false, blockers: ["order_history_pagination_incomplete"] };
}

export async function cancelCoinbaseAdvancedOrder(
  env = {},
  { exchangeOrderId } = {},
  { fetchImpl = fetch } = {}
) {
  if (typeof exchangeOrderId !== "string" || !exchangeOrderId || exchangeOrderId.length > 160) {
    return { status: "blocked", canceled: false, blockers: ["exchange_order_id_required"] };
  }
  const payload = await advancedRequest(env, "POST", API_PREFIX + "/orders/batch_cancel", {
    order_ids: [exchangeOrderId]
  }, fetchImpl);
  const results = Array.isArray(payload.results) ? payload.results : [];
  const result = results.find((item) => item?.order_id === exchangeOrderId);
  return {
    status: result?.success === true ? "CANCEL_QUEUED" : "UNKNOWN",
    canceled: result?.success === true,
    order_id: exchangeOrderId,
    error: result?.failure_reason ? String(result.failure_reason).slice(0, 100) : null
  };
}

// Normalize an exchange fill without inventing missing values. Coinbase may
// emit FILL, REVERSAL, CORRECTION or SYNTHETIC records; callers must retain the
// trade_type because corrections are not ordinary additional executions.
function sanitizeFill(fill) {
  if (!fill || typeof fill !== "object") return null;
  const entryId = typeof fill.entry_id === "string" ? fill.entry_id : "";
  const orderId = typeof fill.order_id === "string" ? fill.order_id : "";
  const productId = typeof fill.product_id === "string" ? fill.product_id : "";
  const side = fill.side === "BUY" || fill.side === "SELL" ? fill.side : null;
  const tradeType = String(fill.trade_type || "").toUpperCase();
  const tradeTime = typeof fill.trade_time === "string" ? fill.trade_time : "";
  const price = String(fill.price ?? "");
  const size = String(fill.size ?? "");
  const commission = String(fill.commission ?? "");
  if (!entryId || entryId.length > 160 || !orderId || orderId.length > 160 ||
      !productId || productId.length > 48 || !side ||
      !["FILL", "REVERSAL", "CORRECTION", "SYNTHETIC"].includes(tradeType) ||
      !Number.isFinite(Date.parse(tradeTime)) ||
      !validMoney(price) || !validMoney(size) ||
      !validNonNegativeMoney(commission)) return null;
  const sequenceTimestamp = typeof fill.sequence_timestamp === "string" &&
    Number.isFinite(Date.parse(fill.sequence_timestamp)) ? fill.sequence_timestamp : null;
  const liquidity = typeof fill.liquidity_indicator === "string"
    ? fill.liquidity_indicator.slice(0, 40) : null;
  // The public fill schema reports a commission amount but does not specify
  // its currency. Preserve explicit fee components if supplied; never infer
  // that this amount is denominated in quote or base currency.
  const commissionDetail = fill.commission_detail_total && typeof fill.commission_detail_total === "object"
    ? Object.fromEntries(["total_commission", "gst_commission", "withholding_commission",
      "client_commission", "venue_commission", "regulatory_commission", "clearing_commission"]
      .map((key) => [key, validNonNegativeMoney(String(fill.commission_detail_total[key] ?? ""))
        ? String(fill.commission_detail_total[key]) : null]))
    : null;
  return {
    entry_id: entryId,
    trade_id: typeof fill.trade_id === "string" ? fill.trade_id.slice(0, 160) : null,
    order_id: orderId,
    product_id: productId,
    side,
    trade_type: tradeType,
    trade_time: tradeTime,
    sequence_timestamp: sequenceTimestamp,
    price,
    size,
    commission,
    commission_currency: typeof fill.commission_currency === "string" && /^[A-Z0-9]{2,12}$/.test(fill.commission_currency)
      ? fill.commission_currency : null,
    commission_currency_source: typeof fill.commission_currency === "string" ? "exchange_explicit_field" : "not_exposed_by_fill_schema",
    commission_detail_total: commissionDetail,
    fill_source: typeof fill.fillSource === "string" ? fill.fillSource.slice(0, 80) : null,
    order_data_source: typeof fill.order_data_source === "string" ? fill.order_data_source.slice(0, 80) : null,
    liquidity_indicator: liquidity,
    size_in_quote: fill.size_in_quote === true
  };
}

// Retrieve only fills belonging to a known exchange order. Pagination is
// bounded; an incomplete result is explicitly reported rather than presented
// as a complete fill history.
export async function listCoinbaseAdvancedFills(
  env = {},
  { orderId, productId, limit = 100, maxPages = 5 } = {},
  { fetchImpl = fetch } = {}
) {
  if (!configuration(env).credentialsConfigured) {
    const error = new Error("coinbase_advanced_credentials_not_configured");
    error.code = "coinbase_advanced_credentials_not_configured";
    error.status = 503;
    throw error;
  }
  const selectedOrderId = typeof orderId === "string" ? orderId.trim() : "";
  const selectedProductId = typeof productId === "string" ? productId.trim().toUpperCase() : "";
  if ((!selectedOrderId && !selectedProductId) ||
      selectedOrderId.length > 160 || selectedProductId.length > 48) {
    const error = new Error("fill_query_order_or_product_required");
    error.code = "fill_query_order_or_product_required";
    error.status = 400;
    throw error;
  }
  const pageLimit = Math.max(1, Math.min(100, Number.isSafeInteger(limit) ? limit : 100));
  const pageCount = Math.max(1, Math.min(5, Number.isSafeInteger(maxPages) ? maxPages : 5));
  const fills = [];
  const seenEntryIds = new Set();
  let cursor = "";
  let pages = 0;
  let paginationComplete = true;
  let proofTokenRequired = false;
  const seenCursors = new Set();
  for (let page = 0; page < pageCount; page += 1) {
    const query = new URLSearchParams({ limit: String(pageLimit) });
    if (selectedOrderId) query.append("order_ids", selectedOrderId);
    if (selectedProductId) query.append("product_ids", selectedProductId);
    if (cursor) query.set("cursor", cursor);
    const payload = await advancedRequest(
      env, "GET", API_PREFIX + "/orders/historical/fills?" + query.toString(),
      undefined, fetchImpl
    );
    if (!Array.isArray(payload.fills)) {
      const error = new Error("coinbase_advanced_fills_response_invalid");
      error.code = "coinbase_advanced_fills_response_invalid";
      throw error;
    }
    pages += 1;
    if (payload.proof_token_required === true) {
      proofTokenRequired = true;
      paginationComplete = false;
    }
    for (const rawFill of payload.fills) {
      const fill = sanitizeFill(rawFill);
      if (!fill) {
        const error = new Error("coinbase_advanced_fill_record_invalid");
        error.code = "coinbase_advanced_fill_record_invalid";
        throw error;
      }
      if (selectedOrderId && fill.order_id !== selectedOrderId) {
        const error = new Error("coinbase_advanced_fill_order_id_mismatch");
        error.code = "coinbase_advanced_fill_order_id_mismatch";
        throw error;
      }
      if (!seenEntryIds.has(fill.entry_id)) {
        seenEntryIds.add(fill.entry_id);
        fills.push(fill);
      }
    }
    if (proofTokenRequired) break;
    const nextCursor = typeof payload.cursor === "string" ? payload.cursor : "";
    if (!nextCursor) break;
    if (seenCursors.has(nextCursor) || page === pageCount - 1) {
      paginationComplete = false;
      break;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return {
    fills,
    count: fills.length,
    pages,
    pagination_complete: paginationComplete && !proofTokenRequired,
    proof_token_required: proofTokenRequired,
    query: { order_id: selectedOrderId || null, product_id: selectedProductId || null }
  };
}

