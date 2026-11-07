package app.aitradingterminal;

import org.junit.Test;
import static org.junit.Assert.*;
import java.util.ArrayList;
import java.util.List;

public final class PaperSignalTest {
    private static final long NOW = 1_800_000_000_000L;

    private PaperSignal.Analysis primary() {
        return new PaperSignal.Analysis("BUY_CANDIDATE","UPTREND","test",82,100,
                56,1.2,25,30,20,1.3,NOW-90*60_000L,60*60_000L);
    }
    private PaperSignal.Analysis higher() {
        return new PaperSignal.Analysis("HOLD","UPTREND","test",70,100,
                55,1.0,24,28,20,1.1,NOW-6*60*60_000L,4*60*60_000L);
    }
    private PaperSignal.Quote quote() {
        return new PaperSignal.Quote(100.05,100.0,100.1,50_000,50_000,2_000_000,
                NOW-1_000,NOW-500);
    }

    @Test public void eligibleDecisionRequiresFreshAlignedSignalAndExecutionEvidence() {
        PaperSignal.Decision d=PaperSignal.assess(primary(),higher(),quote(),NOW);
        assertTrue(d.eligible);
        assertEquals("eligible",d.reason);
        assertTrue(d.spreadBps<PaperSignal.MAX_SPREAD_BPS);
        assertTrue(d.expectedRangeBps>=d.roundTripCostBps*2.5);
    }

    @Test public void staleTickerFailsClosed() {
        PaperSignal.Quote q=new PaperSignal.Quote(100.05,100,100.1,50_000,50_000,2_000_000,
                NOW-180_000,NOW-500);
        assertEquals("stale_or_future_ticker",PaperSignal.assess(primary(),higher(),q,NOW).reason);
    }

    @Test public void staleOrderbookFailsClosed() {
        PaperSignal.Quote q=new PaperSignal.Quote(100.05,100,100.1,50_000,50_000,2_000_000,
                NOW-1_000,NOW-20_000);
        assertEquals("stale_orderbook",PaperSignal.assess(primary(),higher(),q,NOW).reason);
    }

    @Test public void wideSpreadFailsClosed() {
        PaperSignal.Quote q=new PaperSignal.Quote(100.5,100,101,50_000,50_000,2_000_000,
                NOW-1_000,NOW-500);
        assertEquals("spread_too_wide",PaperSignal.assess(primary(),higher(),q,NOW).reason);
    }

    @Test public void insufficientBookDepthFailsClosed() {
        PaperSignal.Quote q=new PaperSignal.Quote(100.05,100,100.1,1_000,50_000,2_000_000,
                NOW-1_000,NOW-500);
        assertEquals("orderbook_depth_below_minimum",PaperSignal.assess(primary(),higher(),q,NOW).reason);
    }

    @Test public void lowQuoteVolumeFailsClosed() {
        PaperSignal.Quote q=new PaperSignal.Quote(100.05,100,100.1,50_000,50_000,500_000,
                NOW-1_000,NOW-500);
        assertEquals("quote_volume_below_minimum",PaperSignal.assess(primary(),higher(),q,NOW).reason);
    }

    @Test public void staleHigherTimeframeFailsClosed() {
        PaperSignal.Analysis stale=new PaperSignal.Analysis("HOLD","UPTREND","test",75,100,
                55,1,23,28,19,1.1,NOW-10*60*60_000L,4*60*60_000L);
        assertEquals("higher_timeframe_closed_candle_stale",
                PaperSignal.assess(primary(),stale,quote(),NOW).reason);
    }

    @Test public void mixedTrendFailsClosed() {
        PaperSignal.Analysis down=new PaperSignal.Analysis("HOLD","DOWNTREND","test",30,100,
                40,1,25,10,30,1.0,NOW-6*60*60_000L,4*60*60_000L);
        assertEquals("higher_timeframe_not_uptrend",PaperSignal.assess(primary(),down,quote(),NOW).reason);
    }

    @Test public void overextendedRsiFailsClosed() {
        PaperSignal.Analysis extended=new PaperSignal.Analysis("BUY_CANDIDATE","UPTREND","test",82,100,
                68,1.2,25,30,20,1.3,NOW-90*60_000L,60*60_000L);
        assertEquals("no_primary_buy_candidate",PaperSignal.assess(extended,higher(),quote(),NOW).reason);
    }

    @Test public void analysisNeedsAtLeast150ClosedBars() {
        List<PaperSignal.Bar> bars=new ArrayList<>();
        for(int i=0;i<149;i++) {
            double close=100+i*0.1;
            bars.add(new PaperSignal.Bar(i*60*60_000L,60*60_000L,close,close+1,close-1,close,10));
        }
        PaperSignal.Analysis a=PaperSignal.analyze(bars,24);
        assertEquals("HOLD",a.signal);
        assertEquals("INSUFFICIENT_DATA",a.regime);
    }

    @Test(expected=IllegalArgumentException.class)
    public void analysisRejectsMissingCandleIntervals() {
        List<PaperSignal.Bar> bars=new ArrayList<>();
        for(int i=0;i<150;i++) {
            long ts=(i+(i>80?1:0))*60*60_000L;
            double close=100+i*0.01;
            bars.add(new PaperSignal.Bar(ts,60*60_000L,close,close+1,close-1,close,10));
        }
        PaperSignal.analyze(bars,24);
    }

    @Test(expected=IllegalArgumentException.class)
    public void analysisRejectsNonFiniteCandlePrices() {
        List<PaperSignal.Bar> bars=new ArrayList<>();
        for(int i=0;i<150;i++) {
            double close=100+i*0.01;
            bars.add(new PaperSignal.Bar(i*60*60_000L,60*60_000L,
                    close,close+1,close-1,i==100?Double.NaN:close,10));
        }
        PaperSignal.analyze(bars,24);
    }
}
