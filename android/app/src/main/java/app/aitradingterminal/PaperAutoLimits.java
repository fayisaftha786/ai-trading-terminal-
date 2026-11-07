package app.aitradingterminal;

/** Small deterministic state gate for local automatic paper entries. */
public final class PaperAutoLimits {
    public static final int MAX_ENTRIES_PER_DAY = 3;
    public static final long SYMBOL_COOLDOWN_MS = 4L * 60L * 60L * 1000L;

    private PaperAutoLimits() {}

    /**
     * A manual paper fill must use a current two-sided quote. The book time is
     * the local retrieval time for the REST order-book request, not an exchange
     * event timestamp. Missing, future, or stale timestamps fail closed.
     */
    public static boolean isFreshExecutionQuote(double bid, double ask,
            long tickerTimestampMs, long bookRetrievedAtMs, long nowMs) {
        if (!Double.isFinite(bid) || !Double.isFinite(ask) ||
                bid <= 0 || ask <= 0 || ask < bid ||
                tickerTimestampMs <= 0 || bookRetrievedAtMs <= 0) return false;
        long tickerAge = nowMs - tickerTimestampMs;
        long bookAge = nowMs - bookRetrievedAtMs;
        return tickerAge >= -5_000L && tickerAge <= PaperSignal.MAX_TICKER_AGE_MS &&
                bookAge >= -1_000L && bookAge <= PaperSignal.MAX_BOOK_AGE_MS;
    }

    public static String rejectionReason(boolean autoEnabled, boolean emergencyStop,
            int openPositions, int entriesToday, long lastTradeAtMs, long nowMs,
            long lastAutoSignalCandleMs, long candidateSignalCandleMs) {
        if (!autoEnabled) return "auto_demo_disabled";
        if (emergencyStop) return "emergency_stop_active";
        if (openPositions > 0) return "position_already_open";
        if (entriesToday >= MAX_ENTRIES_PER_DAY) return "daily_entry_limit";
        if (lastTradeAtMs > 0 && (nowMs < lastTradeAtMs ||
                nowMs - lastTradeAtMs < SYMBOL_COOLDOWN_MS)) return "four_hour_cooldown";
        if (candidateSignalCandleMs <= 0) return "invalid_signal_candle";
        if (lastAutoSignalCandleMs > 0 && candidateSignalCandleMs <= lastAutoSignalCandleMs)
            return "signal_candle_already_processed";
        return "eligible";
    }
}
