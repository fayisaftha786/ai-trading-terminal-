import { DurableObject } from "cloudflare:workers";

export class AuthRateLimiter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS auth_login_attempts (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT," +
      "ip_hash TEXT NOT NULL," +
      "attempted_at_ms INTEGER NOT NULL)"
    );
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_auth_login_attempts_ip_time " +
      "ON auth_login_attempts(ip_hash,attempted_at_ms)"
    );
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/internal/auth/login-attempts") {
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
      });
    }

    try {
      let body;
      try { body = await request.json(); } catch {
        return new Response(JSON.stringify({ error: "invalid_request" }), {
          status: 400,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
        });
      }
      const ipHash = typeof body?.ip_hash === "string" ? body.ip_hash : "";
      const action = body?.action;
      if (!/^[A-Za-z0-9_-]{40,64}$/.test(ipHash) ||
          (action !== "reserve" && action !== "clear")) {
        return new Response(JSON.stringify({ error: "invalid_request" }), {
          status: 400,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
        });
      }

      const nowMs = Date.now();
      const windowMs = 10 * 60 * 1000;
      const attemptLimit = 8;
      this.sql.exec(
        "DELETE FROM auth_login_attempts WHERE attempted_at_ms < ?",
        nowMs - windowMs
      );

      if (action === "clear") {
        this.sql.exec("DELETE FROM auth_login_attempts WHERE ip_hash=?", ipHash);
        return new Response(JSON.stringify({ cleared: true }), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
        });
      }

      const attempts = Number(this.sql.exec(
        "SELECT COUNT(*) AS count FROM auth_login_attempts WHERE ip_hash=? AND attempted_at_ms>=?",
        ipHash, nowMs - windowMs
      ).toArray()[0]?.count || 0);
      if (attempts >= attemptLimit) {
        return new Response(JSON.stringify({ allowed: false, error: "too_many_login_attempts" }), {
          status: 429,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
        });
      }

      this.sql.exec(
        "INSERT INTO auth_login_attempts(ip_hash,attempted_at_ms) VALUES(?,?)",
        ipHash, nowMs
      );
      this.sql.exec(
        "DELETE FROM auth_login_attempts WHERE id IN (" +
        "SELECT id FROM auth_login_attempts ORDER BY attempted_at_ms DESC,id DESC LIMIT -1 OFFSET 10000)"
      );
      return new Response(JSON.stringify({
        allowed: true,
        attempts_remaining: attemptLimit - attempts - 1
      }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
      });
    } catch (error) {
      console.error("Auth rate limiter storage operation failed", {
        name: typeof error?.name === "string" ? error.name : "Error",
        message: String(error?.message || error).slice(0, 180)
      });
      return new Response(JSON.stringify({ error: "rate_limit_storage_unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
      });
    }
  }
}
