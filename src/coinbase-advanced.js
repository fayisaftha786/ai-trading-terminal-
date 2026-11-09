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
  return {
    apiKey,
    privateKeyPem,
    allowedProducts: allowedProducts.slice(0, MAX_ALLOWED_PRODUCTS),
    allowedProductsValid: allowedProducts.length > 0 && allowedProducts.length <= MAX_ALLOWED_PRODUCTS,
    maxOrderQuote,
    maxOrderQuoteValid: Number.isFinite(maxOrderQuote) && maxOrderQuote > 0,
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
    order_submission_available: false,
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
      !/^(?:0|[1-9]\\d*)(?:\\.\\d+)?$/.test(value) ||
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
  const quoteCurrencies = new Set(products.map((product) => String(product.quote_currency_id || "").toUpperCase()).filter(Boolean));
  const balances = {};
  for (const account of accounts) {
    const currency = String(account?.currency || "").toUpperCase();
    if (!quoteCurrencies.has(currency)) continue;
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
    if (permissions.can_trade !== true) blockers.push("api_key_trade_permission_required");
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
    if (permissions.can_view !== true || permissions.can_trade !== true || permissions.can_transfer !== false) {
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
    const code = typeof error?.code === "string" ? error.code : "coinbase_advanced_preflight_failed";
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
  { productId, quoteSize, limitPrice } = {},
  { fetchImpl = fetch } = {}
) {
  const config = configuration(env);
  if (!config.maxOrderQuoteValid || !config.allowedProductsValid) {
    return { status: "blocked", decision: "NO_ORDER", blockers: coinbaseAdvancedStatus(env).blockers, order_submission_available: false };
  }
  const selectedProduct = String(productId || "").trim().toUpperCase();
  if (!config.allowedProducts.includes(selectedProduct)) {
    return { status: "blocked", decision: "NO_ORDER", blockers: ["product_not_on_explicit_allowlist"], order_submission_available: false };
  }
  if (!validMoney(quoteSize) || !validMoney(limitPrice)) {
    return { status: "blocked", decision: "NO_ORDER", blockers: ["positive_decimal_quote_size_and_limit_price_required"], order_submission_available: false };
  }
  if (Number(quoteSize) > config.maxOrderQuote) {
    return { status: "blocked", decision: "NO_ORDER", blockers: ["live_order_quote_cap_exceeded"], order_submission_available: false };
  }

  const preflight = await preflightCoinbaseAdvanced(env, { fetchImpl });
  if (preflight.status !== "preflight_ready_for_manual_order_preview") {
    return {
      status: "blocked", decision: "NO_ORDER",
      blockers: preflight.blockers,
      order_submission_available: false,
      live_trading_enabled: false
    };
  }
  const product = preflight.products.find((item) => item.product_id === selectedProduct && item.eligible);
  if (!product) {
    return { status: "blocked", decision: "NO_ORDER", blockers: ["product_not_preflight_eligible"], order_submission_available: false };
  }
  if (compareDecimalStrings(quoteSize, product.quote_min_size) < 0 ||
      compareDecimalStrings(quoteSize, product.quote_max_size) > 0) {
    return { status: "blocked", decision: "NO_ORDER", blockers: ["quote_size_outside_exchange_product_limits"], order_submission_available: false };
  }
  if (!isIncrementMultiple(quoteSize, product.quote_increment)) {
    return { status: "blocked", decision: "NO_ORDER", blockers: ["quote_size_not_aligned_to_exchange_increment"], order_submission_available: false };
  }
  if (!isIncrementMultiple(limitPrice, product.price_increment)) {
    return { status: "blocked", decision: "NO_ORDER", blockers: ["limit_price_not_aligned_to_exchange_increment"], order_submission_available: false };
  }
  const available = preflight.balances[product.quote_currency_id];
  if (!validNonNegativeMoney(available) || compareDecimalStrings(available, quoteSize) < 0) {
    return { status: "blocked", decision: "NO_ORDER", blockers: ["insufficient_available_quote_balance"], order_submission_available: false };
  }

  const previewPath = API_PREFIX + "/orders/preview";
  const preview = await advancedRequest(env, "POST", previewPath, {
    product_id: selectedProduct,
    side: "BUY",
    order_configuration: {
      limit_limit_gtc: {
        quote_size: quoteSize,
        limit_price: limitPrice,
        post_only: true
      }
    }
  }, fetchImpl);

  const errors = Array.isArray(preview.errs) ? preview.errs.map((item) => String(item).slice(0, 120)) : [];
  const commission = validNonNegativeMoney(String(preview.commission_total ?? ""))
    ? String(preview.commission_total) : null;
  if (errors.length || typeof preview.preview_id !== "string" || !preview.preview_id || commission === null) {
    return {
      status: "preview_rejected",
      decision: "NO_ORDER",
      product_id: selectedProduct,
      side: "BUY",
      quote_size: quoteSize,
      limit_price: limitPrice,
      commission_total: commission,
      preview_errors: errors,
      order_submission_available: false,
      live_trading_enabled: false
    };
  }
  const requiredQuote = addDecimalStrings(quoteSize, commission);
  if (!requiredQuote || compareDecimalStrings(available, requiredQuote) < 0) {
    return {
      status: "blocked",
      decision: "NO_ORDER",
      product_id: selectedProduct,
      quote_size: quoteSize,
      limit_price: limitPrice,
      commission_total: commission,
      blockers: ["available_quote_balance_below_order_plus_previewed_fee"],
      order_submission_available: false
    };
  }
  return {
    status: "preview_ready",
    decision: "PREVIEW_ONLY",
    provider: "coinbase_advanced_trade",
    product_id: selectedProduct,
    side: "BUY",
    order_type: "LIMIT_GTC_POST_ONLY",
    quote_size: quoteSize,
    limit_price: limitPrice,
    commission_total: commission,
    estimated_order_total: preview.order_total || null,
    best_bid: preview.best_bid || null,
    best_ask: preview.best_ask || null,
    slippage: preview.slippage || null,
    preview_id: preview.preview_id,
    available_quote_balance: available,
    quote_currency: product.quote_currency_id,
    checked_at_ms: Date.now(),
    order_submission_available: false,
    live_trading_enabled: false,
    automatic_live_entries_enabled: false,
    warning: "Coinbase preview only. No order has been created, submitted, or reserved."
  };
}

export function coinbaseAdvancedErrorStatus(error) {
  const status = Number(error?.status);
  return status >= 400 && status < 600 ? status : 502;
}
