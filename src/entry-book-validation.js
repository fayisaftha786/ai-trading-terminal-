const INVALID_TIMESTAMP_CODE = "invalid_entry_book_retrieval_timestamp";

/**
 * Accept only a positive integer millisecond timestamp that is not in the future.
 * Invalid exchange metadata must fail closed before a quote/book can be used for
 * an entry decision; never replace an invalid provider timestamp with Date.now().
 */
export function validateEntryBookRetrievalTimestamp(value, nowMs = Date.now()) {
  const raw = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  if (!Number.isSafeInteger(raw) || raw <= 0 ||
      !Number.isSafeInteger(nowMs) || nowMs <= 0 || raw > nowMs) {
    const error = new Error(INVALID_TIMESTAMP_CODE);
    error.code = INVALID_TIMESTAMP_CODE;
    throw error;
  }
  return raw;
}
