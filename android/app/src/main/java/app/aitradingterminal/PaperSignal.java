package app.aitradingterminal;

import java.util.ArrayList;
import java.util.List;

/**
 * Explainable local DEMO signal gate, ported from the backend's closed-candle
 * strategy and automatic paper-entry safety filters. It never places exchange orders.
 */
public final class PaperSignal {
    public static final int MIN_HISTORY = 150;
    public static final double MAX_SPREAD_BPS = 25.0;
    public static final double MIN_QUOTE_VOLUME_USD = 1_000_000.0;
    public static final double MIN_TOP10_DEPTH_USD = 5_000.0;
    public static final long MAX_TICKER_AGE_MS = 120_000L;
    public static final long MAX_BOOK_AGE_MS = 15_000L;
    public static final long MAX_PRIMARY_AGE_MS = 90L * 60_000L;
    public static final long MAX_HIGHER_AGE_MS = 5L * 60L * 60_000L;

    private PaperSignal() {}

    public static final class Bar {
        public final long openTime;
        public final long intervalMs;
        public final double open, high, low, close, volume;

        public Bar(long openTime, long intervalMs, double open, double high,
                   double low, double close, double volume) {
            this.openTime = openTime;
            this.intervalMs = intervalMs;
            this.open = open;
            this.high = high;
            this.low = low;
            this.close = close;
            this.volume = volume;
        }
    }

    public static final class Analysis {
        public final String signal, regime, reason;
        public final int score;
        public final double close, rsi14, atrPct, adx14, plusDi14, minusDi14, volumeRatio;
        public final long lastOpenTime, intervalMs;

        Analysis(String signal, String regime, String reason, int score, double close,
                 double rsi14, double atrPct, double adx14, double plusDi14,
                 double minusDi14, double volumeRatio, long lastOpenTime, long intervalMs) {
            this.signal = signal;
            this.regime = regime;
            this.reason = reason;
            this.score = score;
            this.close = close;
            this.rsi14 = rsi14;
            this.atrPct = atrPct;
            this.adx14 = adx14;
            this.plusDi14 = plusDi14;
            this.minusDi14 = minusDi14;
            this.volumeRatio = volumeRatio;
            this.lastOpenTime = lastOpenTime;
            this.intervalMs = intervalMs;
        }

        public long closeTimeExclusive() { return lastOpenTime + intervalMs; }
    }

    public static final class Quote {
        public final double last, bid, ask, bidDepthUsd, askDepthUsd, quoteVolumeUsd;
        public final long tickerTimestamp, bookTimestamp;

        public Quote(double last, double bid, double ask, double bidDepthUsd,
                     double askDepthUsd, double quoteVolumeUsd,
                     long tickerTimestamp, long bookTimestamp) {
            this.last = last;
            this.bid = bid;
            this.ask = ask;
            this.bidDepthUsd = bidDepthUsd;
            this.askDepthUsd = askDepthUsd;
            this.quoteVolumeUsd = quoteVolumeUsd;
            this.tickerTimestamp = tickerTimestamp;
            this.bookTimestamp = bookTimestamp;
        }
    }

    public static final class Decision {
        public final boolean eligible;
        public final String reason;
        public final double spreadBps, expectedRangeBps, roundTripCostBps;

        Decision(boolean eligible, String reason, double spreadBps,
                 double expectedRangeBps, double roundTripCostBps) {
            this.eligible = eligible;
            this.reason = reason;
            this.spreadBps = spreadBps;
            this.expectedRangeBps = expectedRangeBps;
            this.roundTripCostBps = roundTripCostBps;
        }
    }

    public static Analysis analyze(List<Bar> bars, int barsPerDay) {
        if (bars == null || bars.size() < MIN_HISTORY) {
            return insufficient(bars == null ? 0 : bars.size(), 0, 0);
        }
        if (barsPerDay < 1 || barsPerDay > 1440) {
            throw new IllegalArgumentException("barsPerDay must be between 1 and 1440");
        }

        int n = bars.size();
        long interval = bars.get(0).intervalMs;
        if (interval <= 0) throw new IllegalArgumentException("Invalid candle interval");
        double[] close = new double[n], high = new double[n], low = new double[n], volume = new double[n];
        long previousTime = Long.MIN_VALUE;
        for (int i = 0; i < n; i++) {
            Bar b = bars.get(i);
            if (b == null || b.intervalMs != interval || b.openTime <= previousTime ||
                    (i > 0 && b.openTime - previousTime != interval) ||
                    !positive(b.open) || !positive(b.high) || !positive(b.low) ||
                    !positive(b.close) || !finite(b.volume) || b.volume < 0 ||
                    b.high < Math.max(b.open, Math.max(b.low, b.close)) ||
                    b.low > Math.min(b.open, Math.min(b.high, b.close))) {
                throw new IllegalArgumentException("Invalid, duplicate, or non-contiguous OHLCV candle");
            }
            close[i] = b.close; high[i] = b.high; low[i] = b.low; volume[i] = b.volume;
            previousTime = b.openTime;
        }

        double[] ema20 = ema(close, 20), ema50 = ema(close, 50);
        double currentRsi = rsi(close, 14);
        double[] ema12 = ema(close, 12), ema26 = ema(close, 26);
        double[] macd = new double[n];
        for (int i = 0; i < n; i++) macd[i] = ema12[i] - ema26[i];
        double[] macdSignal = ema(macd, 9);
        double histogram = macd[n - 1] - macdSignal[n - 1];
        double previousHistogram = macd[n - 2] - macdSignal[n - 2];
        double histogramSlope = histogram - previousHistogram;
        double roc5 = roc(close, 5), roc10 = roc(close, 10), roc20 = roc(close, 20);

        WilderMetrics metrics = wilder(bars, 14);
        if (!finite(currentRsi) || !finite(metrics.atr) || !finite(metrics.adx)) {
            return insufficient(n, bars.get(n - 1).openTime, interval);
        }

        double[] returns = new double[20];
        for (int i = n - 20, j = 0; i < n; i++, j++) returns[j] = close[i] / close[i - 1] - 1.0;
        double realizedVol = populationStdDev(returns) * Math.sqrt(barsPerDay) * 100.0;
        double atrPct = metrics.atr / close[n - 1] * 100.0;
        double recentVolume = mean(volume, n - 20, n);
        double priorVolume = mean(volume, n - 40, n - 20);
        double volumeRatio = priorVolume > 0 ? recentVolume / priorVolume : 0.0;
        double rangeHigh = max(high, n - 20, n - 1);
        double rangeLow = min(low, n - 20, n - 1);
        double slope = ema20[n - 6] > 0 ? (ema20[n - 1] / ema20[n - 6] - 1.0) * 100.0 : 0.0;

        boolean trendUp = ema20[n - 1] > ema50[n - 1] && close[n - 1] > ema50[n - 1] && slope > 0;
        boolean trendDown = ema20[n - 1] < ema50[n - 1] && close[n - 1] < ema50[n - 1] && slope < 0;
        boolean directionalUp = metrics.plusDi > metrics.minusDi;
        String regime;
        if (atrPct >= 8.0 || realizedVol >= 12.0) regime = "HIGH_VOLATILITY";
        else if (trendUp && metrics.adx >= 18.0 && directionalUp) regime = "UPTREND";
        else if (trendDown && metrics.adx >= 18.0 && !directionalUp) regime = "DOWNTREND";
        else regime = "RANGE_OR_TRANSITION";

        int score = 50;
        if (trendUp) score += 20;
        else if (trendDown) score -= 20;
        if (currentRsi >= 48 && currentRsi <= 66) score += 10;
        else if (currentRsi >= 72) score -= 15;
        else if (currentRsi <= 30) score -= 10;
        if (volumeRatio >= 1.25) score += 10;
        else if (volumeRatio < 0.65) score -= 8;
        if (close[n - 1] > rangeHigh) score += 10;
        if (metrics.adx >= 22.0 && directionalUp) score += 10;
        else if (metrics.adx < 15.0) score -= 10;
        if (atrPct >= 8.0 || realizedVol >= 12.0) score -= 20;
        else if (atrPct <= 0.15) score -= 5;
        score = Math.max(0, Math.min(100, score));

        boolean candidate = score >= 75 && regime.equals("UPTREND") &&
                atrPct < 8.0 && metrics.adx >= 18.0 &&
                directionalUp && currentRsi < 68.0;
        String signal = candidate ? "BUY_CANDIDATE" : "HOLD";
        String reason = "score=" + score + " · regime=" + regime + " · RSI=" +
                round(currentRsi) + " · ADX=" + round(metrics.adx) +
                " · ATR%=" + round(atrPct) + " · volume=" + round(volumeRatio) + "x" +
                (close[n - 1] > rangeHigh ? " · breakout" : "");
        return new Analysis(signal, regime, reason, score, close[n - 1], currentRsi,
                atrPct, metrics.adx, metrics.plusDi, metrics.minusDi, volumeRatio,
                bars.get(n - 1).openTime, interval);
    }

    public static Decision assess(Analysis primary, Analysis higher, Quote quote, long nowMs) {
        if (primary == null || higher == null || quote == null) return reject("missing_market_evidence", 0, 0);
        if (!positive(quote.last) || !positive(quote.bid) || !positive(quote.ask) || quote.ask < quote.bid)
            return reject("invalid_live_quote", 0, 0);
        long tickerAge = nowMs - quote.tickerTimestamp;
        if (quote.tickerTimestamp <= 0 || tickerAge < -5_000L || tickerAge > MAX_TICKER_AGE_MS)
            return reject("stale_or_future_ticker", 0, 0);
        long bookAge = nowMs - quote.bookTimestamp;
        if (quote.bookTimestamp <= 0 || bookAge < -1_000L || bookAge > MAX_BOOK_AGE_MS)
            return reject("stale_orderbook", 0, 0);

        double mid = (quote.bid + quote.ask) / 2.0;
        double spread = mid > 0 ? ((quote.ask - quote.bid) / mid) * 10_000.0 : Double.POSITIVE_INFINITY;
        if (!finite(spread) || spread > MAX_SPREAD_BPS) return reject("spread_too_wide", spread, 0);
        if (!finite(quote.bidDepthUsd) || !finite(quote.askDepthUsd) ||
                quote.bidDepthUsd < MIN_TOP10_DEPTH_USD || quote.askDepthUsd < MIN_TOP10_DEPTH_USD)
            return reject("orderbook_depth_below_minimum", spread, 0);
        if (!finite(quote.quoteVolumeUsd) || quote.quoteVolumeUsd < MIN_QUOTE_VOLUME_USD)
            return reject("quote_volume_below_minimum", spread, 0);

        long primaryAge = nowMs - primary.closeTimeExclusive();
        long higherAge = nowMs - higher.closeTimeExclusive();
        if (primaryAge < -1_000L || primaryAge > MAX_PRIMARY_AGE_MS)
            return reject("primary_closed_candle_stale", spread, 0);
        if (higherAge < -1_000L || higherAge > MAX_HIGHER_AGE_MS)
            return reject("higher_timeframe_closed_candle_stale", spread, 0);
        if (!"BUY_CANDIDATE".equals(primary.signal) || primary.score < 75 || primary.score > 100)
            return reject("no_primary_buy_candidate", spread, 0);
        if (!"UPTREND".equals(primary.regime) || !"UPTREND".equals(higher.regime))
            return reject("higher_timeframe_not_uptrend", spread, 0);
        if (!finite(primary.atrPct) || !finite(primary.rsi14) || !finite(primary.adx14) ||
                !finite(primary.plusDi14) || !finite(primary.minusDi14) ||
                primary.atrPct < 0 || primary.rsi14 < 0 || primary.rsi14 > 100 ||
                primary.adx14 < 0 || primary.adx14 > 100 ||
                primary.plusDi14 < 0 || primary.plusDi14 > 100 ||
                primary.minusDi14 < 0 || primary.minusDi14 > 100)
            return reject("invalid_signal_metrics", spread, 0);
        if (primary.atrPct >= 5.0 || primary.rsi14 >= 68.0 ||
                primary.adx14 < 18.0 || primary.plusDi14 <= primary.minusDi14)
            return reject("volatility_or_momentum_guard", spread, 0);

        double roundTrip = 2.0 * ((PaperMath.FEE_RATE + PaperMath.SLIPPAGE_RATE) * 10_000.0) + spread;
        double expectedRange = primary.atrPct * 100.0;
        if (!finite(expectedRange) || roundTrip <= 0 || expectedRange < roundTrip * 2.5)
            return reject("expected_range_too_small_vs_cost", spread, expectedRange);
        return new Decision(true, "eligible", spread, expectedRange, roundTrip);
    }

    private static Analysis insufficient(int count, long timestamp, long interval) {
        return new Analysis("HOLD", "INSUFFICIENT_DATA",
                "Need " + MIN_HISTORY + " contiguous closed candles; received " + count,
                0, 0, 0, 0, 0, 0, 0, 0, timestamp, interval);
    }

    private static Decision reject(String reason, double spread, double range) {
        return new Decision(false, reason, spread, range, 0);
    }

    private static double[] ema(double[] values, int period) {
        double[] result = new double[values.length];
        if (values.length == 0) return result;
        if (values.length < period) {
            for (int i = 0; i < values.length; i++) result[i] = values[0];
            return result;
        }
        for (int i = 0; i < period - 1; i++) result[i] = values[0];
        double seed = 0;
        for (int i = 0; i < period; i++) seed += values[i];
        seed /= period;
        result[period - 1] = seed;
        double alpha = 2.0 / (period + 1.0);
        for (int i = period; i < values.length; i++)
            result[i] = alpha * values[i] + (1.0 - alpha) * result[i - 1];
        return result;
    }

    private static double rsi(double[] closes, int period) {
        double gain = 0, loss = 0;
        for (int i = 1; i <= period; i++) {
            double change = closes[i] - closes[i - 1];
            gain += Math.max(change, 0);
            loss += Math.max(-change, 0);
        }
        gain /= period; loss /= period;
        for (int i = period + 1; i < closes.length; i++) {
            double change = closes[i] - closes[i - 1];
            gain = (gain * (period - 1) + Math.max(change, 0)) / period;
            loss = (loss * (period - 1) + Math.max(-change, 0)) / period;
        }
        if (loss <= 0) return gain > 0 ? 100.0 : 50.0;
        return 100.0 - (100.0 / (1.0 + gain / loss));
    }

    private static final class WilderMetrics {
        final double atr, adx, plusDi, minusDi;
        WilderMetrics(double atr, double adx, double plusDi, double minusDi) {
            this.atr = atr; this.adx = adx; this.plusDi = plusDi; this.minusDi = minusDi;
        }
    }

    private static WilderMetrics wilder(List<Bar> bars, int period) {
        int size = bars.size() - 1;
        double[] tr = new double[size], plus = new double[size], minus = new double[size];
        for (int i = 1; i < bars.size(); i++) {
            Bar previous = bars.get(i - 1), current = bars.get(i);
            tr[i - 1] = Math.max(current.high - current.low,
                    Math.max(Math.abs(current.high - previous.close), Math.abs(current.low - previous.close)));
            double highMove = current.high - previous.high;
            double lowMove = previous.low - current.low;
            plus[i - 1] = highMove > lowMove && highMove > 0 ? highMove : 0;
            minus[i - 1] = lowMove > highMove && lowMove > 0 ? lowMove : 0;
        }
        double atr = 0, plusSmooth = 0, minusSmooth = 0;
        for (int i = 0; i < period; i++) {
            atr += tr[i]; plusSmooth += plus[i]; minusSmooth += minus[i];
        }
        atr /= period;
        List<Double> dx = new ArrayList<>();
        double latestPlus = 0, latestMinus = 0;
        for (int i = period - 1; i < tr.length; i++) {
            if (i >= period) {
                atr = (atr * (period - 1) + tr[i]) / period;
                plusSmooth = plusSmooth - plusSmooth / period + plus[i];
                minusSmooth = minusSmooth - minusSmooth / period + minus[i];
            }
            double p = atr > 0 ? 100.0 * plusSmooth / (period * atr) : 0;
            double m = atr > 0 ? 100.0 * minusSmooth / (period * atr) : 0;
            latestPlus = p; latestMinus = m;
            double denom = p + m;
            dx.add(denom > 0 ? 100.0 * Math.abs(p - m) / denom : 0.0);
        }
        if (dx.size() < period) return new WilderMetrics(atr, Double.NaN, latestPlus, latestMinus);
        double adx = 0;
        for (int i = 0; i < period; i++) adx += dx.get(i);
        adx /= period;
        for (int i = period; i < dx.size(); i++) adx = (adx * (period - 1) + dx.get(i)) / period;
        return new WilderMetrics(atr, adx, latestPlus, latestMinus);
    }

    private static double roc(double[] values, int period) {
        double base = values[values.length - period - 1];
        return base > 0 ? (values[values.length - 1] / base - 1.0) * 100.0 : 0;
    }
    private static double mean(double[] values, int start, int end) {
        double sum = 0; for (int i = start; i < end; i++) sum += values[i];
        return end > start ? sum / (end - start) : 0;
    }
    private static double max(double[] values, int start, int end) {
        double value = -Double.MAX_VALUE; for (int i = start; i < end; i++) value = Math.max(value, values[i]); return value;
    }
    private static double min(double[] values, int start, int end) {
        double value = Double.MAX_VALUE; for (int i = start; i < end; i++) value = Math.min(value, values[i]); return value;
    }
    private static double populationStdDev(double[] values) {
        double mean = 0; for (double v : values) mean += v; mean /= values.length;
        double sum = 0; for (double v : values) { double d = v - mean; sum += d * d; }
        return Math.sqrt(sum / values.length);
    }
    private static boolean finite(double v) { return Double.isFinite(v); }
    private static boolean positive(double v) { return finite(v) && v > 0; }
    private static double round(double v) { return Math.round(v * 100.0) / 100.0; }
}
