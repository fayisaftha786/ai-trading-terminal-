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

function parsePem(pem) {
  if (typeof pem !== "string" || pem.length > 12000) throw new Error("coinbase_private_key_missing_or_invalid");
  const match = pem.trim().match(/^-----BEGIN (EC PRIVATE KEY|PRIVATE KEY)-----([\s\S]+?)-----END \1-----$/);
  if (!match) throw new Error("coinbase_private_key_pem_format_invalid");
  const encoded = match[2].replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error("coinbase_private_key_pem_base64_invalid");
  let binary;
  try { binary = atob(encoded); } catch { throw new Error("coinbase_private_key_pem_base64_invalid"); }
  return {
    label: match[1],
    derBytes: Uint8Array.from(binary, (char) => char.charCodeAt(0))
  };
}

function sec1ToPkcs8(sec1Bytes) {
  // PKCS#8 PrivateKeyInfo wrapper for id-ecPublicKey / prime256v1 (P-256).
  // Coinbase Advanced Trade CDP keys use ECDSA P-256 / ES256.
  const ecPublicKeyOid = Uint8Array.of(0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01);
  const prime256v1Oid = Uint8Array.of(0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07);
  const algorithm = der(0x30, concatBytes(ecPublicKeyOid, prime256v1Oid));
  const version = der(0x02, Uint8Array.of(0x00));
  const privateKey = der(0x04, sec1Bytes);
  return der(0x30, concatBytes(version, algorithm, privateKey));
}

async function importPrivateKey(pem) {
  const parsed = parsePem(pem);
  const pkcs8 = parsed.label === "EC PRIVATE KEY"
    ? sec1ToPkcs8(parsed.derBytes)
    : parsed.derBytes;
  try {
    return await crypto.subtle.importKey(
      "pkcs8", pkcs8, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
    );
  } catch {
    throw new Error("coinbase_private_key_import_failed_check_ecdsa_p256_key");
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
  const key = await importPrivateKey(privateKeyPem);
  const uri = String(method).toUpperCase() + " " + API_HOST + path;
  const header = { alg: "ES256", kid: apiKey, nonce: nonce(), typ: "JWT" };
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
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput)
  );
  return signingInput + "." + base64Url(new Uint8Array(signature));
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
    allowed_products_configured: config.allowedProductsValid,
    allowed_products: config.allowedProducts,
    max_order_quote_configured: config.maxOrderQuoteValid,
    max_order_quote: config.maxOrderQuoteValid ? config.maxOrderQuote : null,
    account_preflight_available: config.credentialsConfigured,
    order_preview_available: blockers.length === 0,
    order_submission_available: config.orderExecutionEnabled && blockers.length === 0 && config.maxOpenOrders > 0 && config.maxDailyOrders > 0,
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
      order_submission_available: false,
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
    base_currency: product.base_currency_id,
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

export async function listCoinbaseAdvancedFills(
  env = {},
  { orderIds, limit = 100, maxPages = 5 } = {},
  { fetchImpl = fetch } = {}
) {
  const ids = Array.isArray(orderIds)
    ? [...new Set(orderIds.filter((id) => typeof id === "string" && id.length > 0 && id.length <= 160))]
    : [];
  if (!ids.length || ids.length > 50) {
    return { status: "blocked", fills: [], blockers: ["one_to_fifty_known_exchange_order_ids_required"] };
  }
  const pageLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(100, limit)) : 100;
  const pageCount = Number.isSafeInteger(maxPages) ? Math.max(1, Math.min(10, maxPages)) : 5;
  const fills = [];
  const seenCursors = new Set();
  let cursor = "";
  let pages = 0;
  for (let page = 0; page < pageCount; page += 1) {
    const query = new URLSearchParams();
    for (const id of ids) query.append("order_ids", id);
    query.set("limit", String(pageLimit));
    if (cursor) query.set("cursor", cursor);
    const payload = await advancedRequest(
      env, "GET", API_PREFIX + "/orders/historical/fills?" + query.toString(),
      undefined, fetchImpl
    );
    if (!Array.isArray(payload.fills)) {
      throw new Error("coinbase_advanced_fills_response_invalid");
    }
    for (const fill of payload.fills) {
      if (!fill || typeof fill !== "object" || !ids.includes(String(fill.order_id || ""))) continue;
      const price = String(fill.price ?? "");
      const size = String(fill.size ?? "");
      const commission = String(fill.commission ?? "0");
      const tradeId = typeof fill.trade_id === "string" ? fill.trade_id : "";
      const entryId = typeof fill.entry_id === "string" && fill.entry_id
        ? fill.entry_id : (tradeId && typeof fill.order_id === "string" ? tradeId + ":" + fill.order_id : "");
      if (!entryId || !tradeId || !validMoney(price) || !validMoney(size) ||
          !validNonNegativeMoney(commission) || typeof fill.product_id !== "string" ||
          typeof fill.trade_time !== "string" || !Number.isFinite(Date.parse(fill.trade_time))) {
        throw new Error("coinbase_advanced_fill_record_invalid");
      }
      fills.push({
        entry_id: entryId,
        trade_id: tradeId,
        order_id: String(fill.order_id),
        trade_time: fill.trade_time,
        sequence_timestamp: typeof fill.sequence_timestamp === "string" ? fill.sequence_timestamp : null,
        trade_type: typeof fill.trade_type === "string" ? fill.trade_type : "FILL",
        price,
        size,
        size_in_quote: fill.size_in_quote === true,
        commission,
        product_id: fill.product_id,
        side: fill.side === "BUY" || fill.side === "SELL" ? fill.side : null,
        liquidity_indicator: typeof fill.liquidity_indicator === "string" ? fill.liquidity_indicator : null
      });
    }
    pages += 1;
    const next = typeof payload.cursor === "string" ? payload.cursor : "";
    if (!next) {
      cursor = "";
      break;
    }
    if (seenCursors.has(next)) throw new Error("coinbase_advanced_fills_cursor_repeated");
    seenCursors.add(next);
    cursor = next;
  }
  if (cursor) throw new Error("coinbase_advanced_fills_pagination_incomplete");
  const unique = new Map();
  for (const fill of fills) unique.set(fill.entry_id, fill);
  return { status: "fills_loaded", fills: [...unique.values()], pages, complete: true };
}
