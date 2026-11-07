package app.aitradingterminal;

/** Deterministic assumptions and conservative OHLC exit rules for the local paper ledger. */
public final class PaperMath {
    public static final double STARTING_CAPITAL_USD = 1_000.0;
    public static final double POSITION_NOTIONAL_USD = 100.0;
    public static final double FEE_RATE = 0.001;       // 10 bps per side
    public static final double SLIPPAGE_RATE = 0.0005; // 5 bps per fill
    public static final double STOP_LOSS_RATE = 0.02;
    public static final double TAKE_PROFIT_RATE = 0.04;

    private PaperMath() {}

    public static double entryFill(double referencePrice) {
        requirePrice(referencePrice);
        return referencePrice * (1.0 + SLIPPAGE_RATE);
    }

    public static double exitFill(double referencePrice) {
        requirePrice(referencePrice);
        return referencePrice * (1.0 - SLIPPAGE_RATE);
    }

    public static double fee(double fillPrice, double quantity) {
        requirePrice(fillPrice);
        if (!Double.isFinite(quantity) || quantity <= 0) {
            throw new IllegalArgumentException("Quantity must be finite and positive");
        }
        return fillPrice * quantity * FEE_RATE;
    }

    public static double netPnl(double entry, double quantity, double exit,
                                double entryFee, double exitFee) {
        requirePrice(entry);
        requirePrice(exit);
        if (!Double.isFinite(quantity) || quantity <= 0 ||
                !Double.isFinite(entryFee) || entryFee < 0 ||
                !Double.isFinite(exitFee) || exitFee < 0) {
            throw new IllegalArgumentException("Invalid paper trade accounting inputs");
        }
        return (exit - entry) * quantity - entryFee - exitFee;
    }

    /**
     * Stop is evaluated before target. If both are touched in one candle, assume
     * the adverse stop happened first. A gap below the stop fills at the candle open.
     */
    public static ExitDecision decideExit(double open, double high, double low,
                                          double stopLoss, double takeProfit) {
        requirePrice(open);
        requirePrice(high);
        requirePrice(low);
        requirePrice(stopLoss);
        requirePrice(takeProfit);
        if (high < low || high < open || low > open) {
            throw new IllegalArgumentException("Invalid candle OHLC range");
        }
        if (low <= stopLoss) {
            return new ExitDecision("STOP_LOSS", Math.min(open, stopLoss));
        }
        if (high >= takeProfit) {
            return new ExitDecision("TAKE_PROFIT", takeProfit);
        }
        return null;
    }

    private static void requirePrice(double value) {
        if (!Double.isFinite(value) || value <= 0) {
            throw new IllegalArgumentException("Price must be finite and positive");
        }
    }

    public static final class ExitDecision {
        public final String reason;
        public final double referencePrice;

        ExitDecision(String reason, double referencePrice) {
            this.reason = reason;
            this.referencePrice = referencePrice;
        }
    }
}
