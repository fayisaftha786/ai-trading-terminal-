export const REEL_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const MAX_REEL_TOPIC_LENGTH = 500;

export function reelProviderReadiness(env = {}) {
  const checks = {
    cloudflare_ai: Boolean(env.AI && typeof env.AI.run === "function"),
    video_renderer: isHttpsUrl(env.REEL_RENDER_API_URL) && Boolean(env.REEL_RENDER_API_TOKEN),
    instagram_reels: Boolean(env.META_IG_USER_ID && env.META_PAGE_ACCESS_TOKEN)
  };
  return {
    checks,
    ready: Object.values(checks).every(Boolean),
    missing: Object.entries(checks).filter(([, ready]) => !ready).map(([name]) => name)
  };
}

function isHttpsUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function normalizeReelRequest(input = {}) {
  const topic = typeof input.topic === "string" ? input.topic.trim() : "";
  const audience = typeof input.audience === "string" ? input.audience.trim() : "General audience";
  const style = typeof input.style === "string" ? input.style.trim() : "educational";
  const idempotencyKey = typeof input.idempotency_key === "string" ? input.idempotency_key.trim() : "";
  if (topic.length < 8 || topic.length > MAX_REEL_TOPIC_LENGTH) {
    throw new TypeError("topic_must_be_8_to_500_characters");
  }
  if (audience.length > 160 || style.length > 80) throw new TypeError("reel_preferences_too_long");
  if (idempotencyKey && !/^[a-zA-Z0-9._:-]{8,128}$/.test(idempotencyKey)) {
    throw new TypeError("invalid_idempotency_key");
  }
  return { topic, audience: audience || "General audience", style: style || "educational", idempotencyKey };
}

export function buildReelGenerationPrompt({ topic, audience, style }) {
  return [
    "Create an original vertical 9:16 short-form video concept for Instagram Reels.",
    "Return ONLY valid JSON with keys: hook, voiceover_script, caption, hashtags, video_prompt.",
    "The voiceover_script must be 65-110 words, natural and factual, with no fabricated claims.",
    "The caption must be concise. hashtags must be an array of at most 8 relevant tags.",
    "The video_prompt must describe original visuals, scene changes, on-screen captions and safe margins.",
    "Do not request copyrighted characters, existing creator footage, celebrity likenesses, or unlicensed music.",
    "Do not make medical, financial or guaranteed-income claims. Clearly qualify uncertain claims.",
    "Topic: " + topic,
    "Target audience: " + audience,
    "Creative style: " + style
  ].join("\n");
}

export function validateGeneratedReel(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid_generated_reel");
  const hook = clean(value.hook, 180);
  const voiceoverScript = clean(value.voiceover_script, 1400);
  const caption = clean(value.caption, 2200);
  const videoPrompt = clean(value.video_prompt, 1800);
  const hashtags = Array.isArray(value.hashtags)
    ? value.hashtags.slice(0, 8).map((tag) => clean(tag, 40).replace(/^#?/, "#")).filter((tag) => /^#[\p{L}\p{N}_]+$/u.test(tag))
    : [];
  if (!hook || voiceoverScript.split(/\s+/).length < 30 || !caption || !videoPrompt) {
    throw new TypeError("generated_reel_missing_required_content");
  }
  return { hook, voiceover_script: voiceoverScript, caption, hashtags, video_prompt: videoPrompt };
}

export function validateRenderedAsset(value) {
  const raw = typeof value === "string" ? value : value?.asset_url;
  let url;
  try { url = new URL(String(raw || "")); } catch { throw new TypeError("renderer_did_not_return_asset_url"); }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new TypeError("renderer_asset_url_must_be_https");
  }
  return url.toString();
}

export function nextReelStatus(enabled, readiness) {
  if (!readiness.ready) return enabled ? "waiting_for_configuration" : "setup_required";
  return enabled ? "running" : "stopped";
}

function clean(value, max) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
}
