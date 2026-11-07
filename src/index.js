import { TradingEngine } from "./engine.js";

export { TradingEngine };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const loginAttempts = new Map();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, private",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "permissions-policy": "camera=(), microphone=(), geolocation=()"
    }
  });
}

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function fromBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function equalBytes(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function sign(payload, secret) {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  return body + "." + toBase64Url(signature);
}

async function verify(token, secret) {
  if (!secret || typeof token !== "string" || token.length > 4096) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  let payload;
  try { payload = JSON.parse(decoder.decode(fromBase64Url(parts[0]))); } catch { return false; }
  const expectedToken = await sign(payload, secret);
  const expected = fromBase64Url(expectedToken.split(".")[1]);
  let supplied;
  try { supplied = fromBase64Url(parts[1]); } catch { return false; }
  if (!equalBytes(expected, supplied)) return false;
  return payload?.sub === "owner" && Number.isFinite(payload.exp) && payload.exp > Math.floor(Date.now() / 1000);
}

function addSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "no-referrer");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  headers.set("content-security-policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function login(request, env) {
  const expectedUsername = env.ADMIN_USERNAME || "admin";
  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
    return json({ error: "deployment_secrets_missing_or_invalid" }, 503);
  }
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 4096) return json({ error: "request_too_large" }, 413);
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const username = String(body.username || "");
  const password = String(body.password || "");
  if (username.length > 128 || password.length > 256) return json({ error: "invalid_credentials" }, 401);
  const key = request.headers.get("cf-connecting-ip") || "unknown";
  const now = Date.now();
  const recent = (loginAttempts.get(key) || []).filter((stamp) => now - stamp < 10 * 60 * 1000);
  if (recent.length >= 8) return json({ error: "too_many_login_attempts" }, 429);
  recent.push(now);
  loginAttempts.set(key, recent);
  const usernameMatch = equalBytes(await sha256(username), await sha256(expectedUsername));
  const passwordMatch = equalBytes(await sha256(password), await sha256(env.ADMIN_PASSWORD));
  if (!usernameMatch || !passwordMatch) return json({ error: "invalid_credentials" }, 401);
  loginAttempts.delete(key);
  const token = await sign({ sub: "owner", exp: Math.floor(now / 1000) + (8 * 60 * 60) }, env.SESSION_SECRET);
  return json({ access_token: token, token_type: "Bearer", expires_in: 28800 });
}

async function routeApi(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/api/auth/status" && request.method === "GET") return json({ required: true, mode: "paper_only" });
  if (url.pathname === "/api/auth/login" && request.method === "POST") return login(request, env);
  const health = url.pathname === "/api/health" && request.method === "GET";
  if (!health) {
    const authorization = request.headers.get("authorization") || "";
    const [scheme, token] = authorization.split(" ", 2);
    if (scheme?.toLowerCase() !== "bearer" || !(await verify(token, env.SESSION_SECRET))) {
      return json({ error: "authentication_required" }, 401);
    }
  }
  const id = env.TRADING_ENGINE.idFromName("single-owner-paper-ledger");
  const stub = env.TRADING_ENGINE.get(id);
  return stub.fetch(request);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return addSecurityHeaders(await routeApi(request, env));
    return addSecurityHeaders(await env.ASSETS.fetch(request));
  }
};
