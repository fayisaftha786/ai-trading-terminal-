package app.aitradingterminal;

import org.junit.Test;
import static org.junit.Assert.*;

public final class PaperMathTest {
    @Test public void fillsIncludeConfiguredSlippage() {
        assertEquals(100.05, PaperMath.entryFill(100.0), 0.000001);
        assertEquals(99.95, PaperMath.exitFill(100.0), 0.000001);
    }

    @Test public void netPnlIncludesBothFees() {
        double pnl = PaperMath.netPnl(100.0, 1.0, 110.0, 0.10, 0.11);
        assertEquals(9.79, pnl, 0.000001);
    }

    @Test public void stopWinsWhenBothStopAndTargetAreTouched() {
        PaperMath.ExitDecision decision = PaperMath.decideExit(
                100.0, 105.0, 95.0, 98.0, 104.0
        );
        assertNotNull(decision);
        assertEquals("STOP_LOSS", decision.reason);
        assertEquals(98.0, decision.referencePrice, 0.000001);
    }

    @Test public void stopUsesWorseOpenWhenMarketGapsDown() {
        PaperMath.ExitDecision decision = PaperMath.decideExit(
                95.0, 101.0, 94.0, 98.0, 104.0
        );
        assertEquals("STOP_LOSS", decision.reason);
        assertEquals(95.0, decision.referencePrice, 0.000001);
    }

    @Test public void targetUsesTargetPriceRatherThanFavorableCandleHigh() {
        PaperMath.ExitDecision decision = PaperMath.decideExit(
                100.0, 110.0, 99.0, 98.0, 104.0
        );
        assertEquals("TAKE_PROFIT", decision.reason);
        assertEquals(104.0, decision.referencePrice, 0.000001);
    }

    @Test public void noExitWhenNeitherThresholdIsTouched() {
        assertNull(PaperMath.decideExit(100.0, 103.0, 99.0, 98.0, 104.0));
    }

    @Test(expected = IllegalArgumentException.class)
    public void invalidPriceIsRejected() {
        PaperMath.entryFill(Double.NaN);
    }
}
