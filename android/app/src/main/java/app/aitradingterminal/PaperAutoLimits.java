package app.aitradingterminal;

/** Small deterministic state gate for local automatic paper entries. */
public final class PaperAutoLimits {
    public static final int MAX_ENTRIES_PER_DAY = 3;
    public static final long SYMBOL_COOLDOWN_MS = 4L * 60L * 60L * 1000L;

    private PaperAutoLimits() {}

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
