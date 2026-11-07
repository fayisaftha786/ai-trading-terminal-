package app.aitradingterminal;

import org.junit.Test;
import static org.junit.Assert.*;

public final class PaperAutoLimitsTest {
    private static final long NOW=1_800_000_000_000L;

    @Test public void autoModeMustBeExplicitlyEnabled() {
        assertEquals("auto_demo_disabled",PaperAutoLimits.rejectionReason(
                false,false,0,0,0,NOW,0,NOW-60_000));
    }

    @Test public void emergencyStopBlocksNewAutomaticEntries() {
        assertEquals("emergency_stop_active",PaperAutoLimits.rejectionReason(
                true,true,0,0,0,NOW,0,NOW-60_000));
    }

    @Test public void anExistingPositionBlocksAnotherEntry() {
        assertEquals("position_already_open",PaperAutoLimits.rejectionReason(
                true,false,1,0,0,NOW,0,NOW-60_000));
    }

    @Test public void dailyEntryLimitIsThree() {
        assertEquals(3,PaperAutoLimits.MAX_ENTRIES_PER_DAY);
        assertEquals("daily_entry_limit",PaperAutoLimits.rejectionReason(
                true,false,0,3,0,NOW,0,NOW-60_000));
    }

    @Test public void cooldownMustExpireBeforeNextEntry() {
        assertEquals("four_hour_cooldown",PaperAutoLimits.rejectionReason(
                true,false,0,1,NOW-3*60*60_000L,NOW,0,NOW-60_000));
        assertEquals("eligible",PaperAutoLimits.rejectionReason(
                true,false,0,1,NOW-4*60*60_000L,NOW,0,NOW-60_000));
    }

    @Test public void clockGoingBackwardsFailsClosed() {
        assertEquals("four_hour_cooldown",PaperAutoLimits.rejectionReason(
                true,false,0,0,NOW+1,NOW,0,NOW-60_000));
    }

    @Test public void sameOrOlderSignalCandleCannotBeReplayed() {
        assertEquals("signal_candle_already_processed",PaperAutoLimits.rejectionReason(
                true,false,0,0,0,NOW,NOW-60_000,NOW-60_000));
        assertEquals("signal_candle_already_processed",PaperAutoLimits.rejectionReason(
                true,false,0,0,0,NOW,NOW-60_000,NOW-120_000));
    }

    @Test public void freshNewSignalCanPassAllStateLimits() {
        assertEquals("eligible",PaperAutoLimits.rejectionReason(
                true,false,0,2,NOW-5*60*60_000L,NOW,NOW-120_000,NOW-60_000));
    }

    @Test public void manualPaperExecutionRequiresFreshTwoSidedQuote() {
        assertTrue(PaperAutoLimits.isFreshExecutionQuote(100.0,100.1,NOW-1_000,NOW-500,NOW));
        assertFalse(PaperAutoLimits.isFreshExecutionQuote(100.0,100.1,NOW-121_000,NOW-500,NOW));
        assertFalse(PaperAutoLimits.isFreshExecutionQuote(100.0,100.1,NOW-1_000,NOW-16_000,NOW));
        assertFalse(PaperAutoLimits.isFreshExecutionQuote(100.0,100.1,0,NOW-500,NOW));
        assertFalse(PaperAutoLimits.isFreshExecutionQuote(100.0,100.1,NOW-1_000,0,NOW));
        assertFalse(PaperAutoLimits.isFreshExecutionQuote(100.1,100.0,NOW-1_000,NOW-500,NOW));
        assertFalse(PaperAutoLimits.isFreshExecutionQuote(0,100.1,NOW-1_000,NOW-500,NOW));
    }

    @Test public void futureOrClockSkewedQuotesFailClosed() {
        assertFalse(PaperAutoLimits.isFreshExecutionQuote(100.0,100.1,NOW+6_000,NOW-500,NOW));
        assertFalse(PaperAutoLimits.isFreshExecutionQuote(100.0,100.1,NOW-500,NOW+2_000,NOW));
    }
}
