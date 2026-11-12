import { DurableObject } from "cloudflare:workers";
import { buildReelGenerationPrompt, nextReelStatus, normalizeReelRequest, reelProviderReadiness, validateGeneratedReel, validateRenderedAsset } from "./reel-core.js";

const GRAPH_VERSION = "v24.0";
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store, private" }
});

export class ReelAutomation extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS reel_state(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0,updated_at_ms INTEGER NOT NULL)");
    this.sql.exec("INSERT OR IGNORE INTO reel_state(id,enabled,updated_at_ms) VALUES(1,0,0)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS reel_jobs(id TEXT PRIMARY KEY,idempotency_key TEXT UNIQUE,platform TEXT NOT NULL,status TEXT NOT NULL,topic TEXT NOT NULL,hook TEXT NOT NULL,voiceover_script TEXT NOT NULL,caption TEXT NOT NULL,hashtags_json TEXT NOT NULL,video_prompt TEXT NOT NULL,asset_url TEXT NOT NULL,container_id TEXT,published_media_id TEXT,error_code TEXT,created_at_ms INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS idx_reel_jobs_status_created ON reel_jobs(status,created_at_ms)");
  }

  state() {
    return this.sql.exec("SELECT enabled,updated_at_ms FROM reel_state WHERE id=1").toArray()[0] || { enabled: 0 };
  }

  counts() {
    const rows = this.sql.exec("SELECT status,COUNT(*) AS count FROM reel_jobs GROUP BY status").toArray();
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "GET" && path === "/api/reels/status") {
      const state = this.state();
      const readiness = reelProviderReadiness(this.env);
      return json({
        enabled: Boolean(state.enabled),
        status: nextReelStatus(Boolean(state.enabled), readiness),
        providers: readiness.checks,
        missing_configuration: readiness.missing,
        queue: this.counts(),
        supported_publish_platforms: ["instagram_reels"],
        note: "Auto-publishing is available only after AI, video renderer and Instagram publishing credentials are configured."
      });
    }
    if (request.method === "GET" && path === "/api/reels/jobs") {
      const rows = this.sql.exec("SELECT id,platform,status,topic,hook,caption,asset_url,published_media_id,error_code,created_at_ms,updated_at_ms FROM reel_jobs ORDER BY created_at_ms DESC LIMIT 30").toArray();
      return json({ jobs: rows });
    }
    if (request.method === "POST" && path === "/api/reels/start") {
      const readiness = reelProviderReadiness(this.env);
      if (!readiness.ready) return json({ error: "reel_providers_not_configured", missing_configuration: readiness.missing }, 409);
      this.sql.exec("UPDATE reel_state SET enabled=1,updated_at_ms=? WHERE id=1", Date.now());
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      return json({ enabled: true, status: "running", message: "Automatic Instagram Reel publishing queue started." });
    }
    if (request.method === "POST" && path === "/api/reels/stop") {
      this.sql.exec("UPDATE reel_state SET enabled=0,updated_at_ms=? WHERE id=1", Date.now());
      await this.ctx.storage.deleteAlarm();
      return json({ enabled: false, status: "stopped" });
    }
    if (request.method === "POST" && path === "/api/reels/generate") {
      let body;
      try {
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > 8192) return json({ error: "request_too_large" }, 413);
        body = JSON.parse(raw);
      } catch { return json({ error: "invalid_json" }, 400); }
      let requestData;
      try { requestData = normalizeReelRequest(body); }
      catch (error) { return json({ error: error.message }, 400); }
      const readiness = reelProviderReadiness(this.env);
      if (!readiness.checks.cloudflare_ai || !readiness.checks.video_renderer) {
        return json({ error: "content_generation_not_configured", missing_configuration: readiness.missing.filter((name) => name !== "instagram_reels") }, 409);
      }
      if (requestData.idempotencyKey) {
        const existing = this.sql.exec("SELECT id,status FROM reel_jobs WHERE idempotency_key=? LIMIT 1", requestData.idempotencyKey).toArray()[0];
        if (existing) return json({ job: existing, duplicate: true }, 200);
      }
      try {
        const generated = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
          messages: [{ role: "system", content: "You are a careful short-form video producer. Follow the requested JSON schema exactly." },
            { role: "user", content: buildReelGenerationPrompt(requestData) }],
          max_tokens: 900
        });
        const rawText = generated?.response || generated?.result?.response || "";
        let parsed;
        try { parsed = JSON.parse(String(rawText).replace(/^\s*```json\s*/i, "").replace(/\s*```\s*$/, "")); }
        catch { throw new Error("ai_returned_invalid_json"); }
        const draft = validateGeneratedReel(parsed);
        const renderResponse = await fetch(this.env.REEL_RENDER_API_URL, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer " + this.env.REEL_RENDER_API_TOKEN },
          body: JSON.stringify({
            aspect_ratio: "9:16", duration_seconds: 30, hook: draft.hook,
            voiceover_script: draft.voiceover_script, caption: draft.caption,
            hashtags: draft.hashtags, video_prompt: draft.video_prompt,
            subtitles: true, safe_margins: true, original_assets_only: true
          })
        });
        if (!renderResponse.ok) throw new Error("video_renderer_http_" + renderResponse.status);
        const rendered = await renderResponse.json();
        const assetUrl = validateRenderedAsset(rendered);
        const id = crypto.randomUUID();
        const now = Date.now();
        const enabled = Boolean(this.state().enabled);
        const status = enabled && readiness.checks.instagram_reels ? "queued" : "draft_ready";
        this.sql.exec(
          "INSERT INTO reel_jobs(id,idempotency_key,platform,status,topic,hook,voiceover_script,caption,hashtags_json,video_prompt,asset_url,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
          id, requestData.idempotencyKey || null, "instagram_reels", status, requestData.topic,
          draft.hook, draft.voiceover_script, draft.caption, JSON.stringify(draft.hashtags),
          draft.video_prompt, assetUrl, now, now
        );
        if (status === "queued") await this.ctx.storage.setAlarm(Date.now() + 1000);
        return json({ job: { id, platform: "instagram_reels", status, topic: requestData.topic, hook: draft.hook, caption: draft.caption, asset_url: assetUrl }, duplicate: false }, 201);
      } catch (error) {
        return json({ error: "reel_generation_failed", detail: String(error?.message || error).slice(0, 180) }, 502);
      }
    }
    return json({ error: "not_found" }, 404);
  }

  async alarm() {
    const state = this.state();
    if (!state.enabled) return;
    const readiness = reelProviderReadiness(this.env);
    if (!readiness.ready) return;
    const job = this.sql.exec("SELECT * FROM reel_jobs WHERE status IN ('queued','publishing') ORDER BY created_at_ms LIMIT 1").toArray()[0];
    if (!job) {
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      return;
    }
    try {
      const base = "https://graph.facebook.com/" + (this.env.META_GRAPH_VERSION || GRAPH_VERSION);
      if (job.status === "queued") {
        const form = new URLSearchParams({
          media_type: "REELS", video_url: job.asset_url, caption: [job.caption, JSON.parse(job.hashtags_json).join(" ")].filter(Boolean).join("\n\n"),
          share_to_feed: "true", access_token: this.env.META_PAGE_ACCESS_TOKEN
        });
        const response = await fetch(base + "/" + encodeURIComponent(this.env.META_IG_USER_ID) + "/media", { method: "POST", body: form });
        const data = await response.json();
        if (!response.ok || !data.id) throw new Error("instagram_container_create_failed");
        this.sql.exec("UPDATE reel_jobs SET status='publishing',container_id=?,updated_at_ms=? WHERE id=?", data.id, Date.now(), job.id);
        await this.ctx.storage.setAlarm(Date.now() + 20_000);
        return;
      }
      const statusUrl = new URL(base + "/" + encodeURIComponent(job.container_id));
      statusUrl.searchParams.set("fields", "status_code");
      statusUrl.searchParams.set("access_token", this.env.META_PAGE_ACCESS_TOKEN);
      const statusResponse = await fetch(statusUrl);
      const statusData = await statusResponse.json();
      if (!statusResponse.ok) throw new Error("instagram_container_status_failed");
      if (statusData.status_code === "IN_PROGRESS" || statusData.status_code === "PUBLISHED") {
        if (statusData.status_code === "PUBLISHED") {
          this.sql.exec("UPDATE reel_jobs SET status='published',updated_at_ms=? WHERE id=?", Date.now(), job.id);
        } else {
          await this.ctx.storage.setAlarm(Date.now() + 20_000);
        }
        return;
      }
      if (statusData.status_code !== "FINISHED") throw new Error("instagram_container_" + String(statusData.status_code || "unknown").toLowerCase());
      const publishForm = new URLSearchParams({ creation_id: job.container_id, access_token: this.env.META_PAGE_ACCESS_TOKEN });
      const publishResponse = await fetch(base + "/" + encodeURIComponent(this.env.META_IG_USER_ID) + "/media_publish", { method: "POST", body: publishForm });
      const publishData = await publishResponse.json();
      if (!publishResponse.ok || !publishData.id) throw new Error("instagram_publish_failed");
      this.sql.exec("UPDATE reel_jobs SET status='published',published_media_id=?,updated_at_ms=? WHERE id=?", publishData.id, Date.now(), job.id);
    } catch (error) {
      this.sql.exec("UPDATE reel_jobs SET status='failed',error_code=?,updated_at_ms=? WHERE id=?", String(error?.message || error).slice(0, 100), Date.now(), job.id);
    }
    await this.ctx.storage.setAlarm(Date.now() + 1000);
  }
}
