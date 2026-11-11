import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateEntryBookRetrievalTimestamp } from "../src/entry-book-validation.js";

const NOW = 1_800_000_000_000;

test("accepts a positive integer timestamp no later than the current clock", () => {
  assert.equal(validateEntryBookRetrievalTimestamp(NOW - 10, NOW), NOW - 10);
  assert.equal(validateEntryBookRetrievalTimestamp(String(NOW - 20), NOW), NOW - 20);
  assert.equal(validateEntryBookRetrievalTimestamp(NOW, NOW), NOW);
});

test("rejects missing, null, blank, malformed, fractional and non-numeric timestamps", () => {
  for (const value of [undefined, null, "", " ", "abc", "1.5", 1.5, NaN, Infinity, true, false]) {
    assert.throws(
      () => validateEntryBookRetrievalTimestamp(value, NOW),
      (error) => error.code === "invalid_entry_book_retrieval_timestamp"
    );
  }
});

test("rejects zero, negative, unsafe and future timestamps", () => {
  for (const value of [0, -1, Number.MAX_SAFE_INTEGER + 1, NOW + 1]) {
    assert.throws(
      () => validateEntryBookRetrievalTimestamp(value, NOW),
      (error) => error.code === "invalid_entry_book_retrieval_timestamp"
    );
  }
});

test("rejects an invalid clock instead of treating an unverifiable timestamp as fresh", () => {
  for (const nowMs of [0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => validateEntryBookRetrievalTimestamp(NOW - 1, nowMs),
      (error) => error.code === "invalid_entry_book_retrieval_timestamp"
    );
  }
});

test("engine validates provider timestamp before applying the fetched book", () => {
  const engine = readFileSync(new URL("../src/engine.js", import.meta.url), "utf8");
  const fetchStart = engine.indexOf("const freshBook = provider === \"coinbase_exchange\"");
  const applyAt = engine.indexOf("Object.assign(market, freshBook)", fetchStart);
  assert.ok(fetchStart >= 0 && applyAt > fetchStart);
  const beforeApply = engine.slice(fetchStart, applyAt);
  assert.ok(beforeApply.includes("validateEntryBookRetrievalTimestamp"));
  assert.ok(beforeApply.indexOf("validateEntryBookRetrievalTimestamp") <
    beforeApply.indexOf("Object.assign(market, freshBook)"));
});
