import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReelGenerationPrompt, nextReelStatus, normalizeReelRequest,
  reelProviderReadiness, validateGeneratedReel, validateRenderedAsset
} from "../src/reel-core.js";

test("provider readiness never treats absent secrets as connected", () => {
  const result = reelProviderReadiness({});
  assert.equal(result.ready, false);
  assert.deepEqual(result.missing, ["cloudflare_ai", "video_renderer", "instagram_reels"]);
});

test("provider readiness requires AI, HTTPS renderer and Instagram credentials", () => {
  const env = {
    AI: { run() {} }, REEL_RENDER_API_URL: "https://renderer.example/api/render",
    REEL_RENDER_API_TOKEN: "configured", META_IG_USER_ID: "123", META_PAGE_ACCESS_TOKEN: "secret"
  };
  assert.equal(reelProviderReadiness(env).ready, true);
  assert.equal(reelProviderReadiness({ ...env, REEL_RENDER_API_URL: "http://renderer.example" }).ready, false);
});

test("reel request validation bounds input and idempotency key", () => {
  assert.throws(() => normalizeReelRequest({ topic: "short" }), /topic_must_be/);
  assert.throws(() => normalizeReelRequest({ topic: "A valid topic", idempotency_key: "bad" }), /invalid_idempotency/);
  assert.deepEqual(normalizeReelRequest({ topic: "  Explain Bitcoin custody  " }), {
    topic: "Explain Bitcoin custody", audience: "General audience", style: "educational", idempotencyKey: ""
  });
});

test("prompt asks for original safe 9:16 short-form content", () => {
  const prompt = buildReelGenerationPrompt({ topic: "safe topic", audience: "new learners", style: "documentary" });
  assert.match(prompt, /9:16/);
  assert.match(prompt, /copyrighted characters/);
  assert.match(prompt, /new learners/);
});

test("generated reel content is validated and hashtags are normalized", () => {
  const draft = validateGeneratedReel({
    hook: "A useful hook", voiceover_script: "Learn how this works in a simple way. ".repeat(8),
    caption: "A clear caption", hashtags: ["reels", "#learning", "not valid tag"],
    video_prompt: "Original animated scenes with captions"
  });
  assert.deepEqual(draft.hashtags, ["#reels", "#learning"]);
  assert.throws(() => validateGeneratedReel({ hook: "x", voiceover_script: "tiny", caption: "", video_prompt: "" }));
});

test("rendered assets must be public HTTPS URLs", () => {
  assert.equal(validateRenderedAsset({ asset_url: "https://cdn.example/video.mp4" }), "https://cdn.example/video.mp4");
  assert.throws(() => validateRenderedAsset("http://cdn.example/video.mp4"), /must_be_https/);
  assert.throws(() => validateRenderedAsset("file:///tmp/video.mp4"));
});

test("status distinguishes stopped, running and setup required", () => {
  assert.equal(nextReelStatus(false, { ready: false }), "setup_required");
  assert.equal(nextReelStatus(true, { ready: false }), "waiting_for_configuration");
  assert.equal(nextReelStatus(true, { ready: true }), "running");
});
