from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JAVA = ROOT / "android/app/src/main/java/app/aitradingterminal"
TEST = ROOT / "android/app/src/test/java/app/aitradingterminal"


def test_auto_demo_is_opt_in_persistent_and_defaults_off():
    source = (JAVA / "LocalPaperActivity.java").read_text()
    assert 'autoButton=button(db.isAutoEnabled()?"AUTO DEMO: ON · FOREGROUND ONLY":"AUTO DEMO: OFF")' in source
    assert 'boolean enabled=!db.isAutoEnabled()' in source
    assert 'db.setAutoEnabled(enabled)' in source
    assert 'return "1".equals(flagValueInternal(getReadableDatabase(),"auto_demo"))' in source
    assert '"auto_demo",enabled?"1":"0"' in source
    assert "synchronized String openAuto" in source


def test_auto_demo_runs_only_in_foreground_and_keeps_open_trade_exit_checks():
    source = (JAVA / "LocalPaperActivity.java").read_text()
    assert "AUTO_REFRESH_MS=5L*60L*1000L" in source
    assert "onResume()" in source and "scheduleRefreshIfNeeded()" in source
    assert "onPause()" in source and "mainHandler.removeCallbacks(autoRefreshTask)" in source
    assert "db.isAutoEnabled()||db.openCount()>0" in source
    assert "onDestroy(){mainHandler.removeCallbacks(autoRefreshTask)" in source


def test_auto_demo_fetches_only_closed_contiguous_1h_and_4h_candles():
    source = (JAVA / "LocalPaperActivity.java").read_text()
    assert 'fetchCandles("1h",200,HOUR_MS,MAX_CANDLE_AGE_MS)' in source
    assert 'fetchCandles("4h",180,FOUR_HOURS_MS,PaperSignal.MAX_HIGHER_AGE_MS)' in source
    assert "if(closeTime>=now) continue" in source
    assert "openTime-previousOpen!=intervalMs" in source
    assert "At least "+'"+PaperSignal.MIN_HISTORY+"'+" closed "+'"+interval+"'"+" candles are required" in source


def test_auto_demo_checks_live_ticker_spread_depth_and_daily_quote_volume():
    source = (JAVA / "LocalPaperActivity.java").read_text()
    signal = (JAVA / "PaperSignal.java").read_text()
    assert "ticker.getLong(\"closeTime\")" in source
    assert "https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=10" in source
    assert "bidDepth,askDepth,ticker.getDouble(\"quoteVolume\")" in source
    assert "db.openAuto(snapshot.quote.ask,latest.openTime)" in source
    assert "Math.min(bookRetrievedAt,depthRetrievedAt)" in source
    assert "MAX_SPREAD_BPS = 25.0" in signal
    assert "MIN_QUOTE_VOLUME_USD = 1_000_000.0" in signal
    assert "MIN_TOP10_DEPTH_USD = 5_000.0" in signal
    assert "MAX_TICKER_AGE_MS = 120_000L" in signal
    assert "MAX_BOOK_AGE_MS = 15_000L" in signal


def test_auto_demo_requires_multi_timeframe_uptrend_and_cost_headroom():
    signal = (JAVA / "PaperSignal.java").read_text()
    assert "MIN_HISTORY = 150" in signal
    assert 'primary.regime.equals("UPTREND")' in signal or '"UPTREND".equals(primary.regime)' in signal
    assert '"UPTREND".equals(higher.regime)' in signal
    assert 'primary.signal' in signal
    assert "expectedRange < roundTrip * 2.5" in signal
    assert "primary.atrPct >= 5.0" in signal
    assert "primary.rsi14 >= 68.0" in signal
    assert "primary.adx14 < 18.0" in signal
    assert "primary.plusDi14 <= primary.minusDi14" in signal


def test_auto_demo_daily_cap_cooldown_and_signal_replay_are_enforced_transactionally():
    source = (JAVA / "LocalPaperActivity.java").read_text()
    limits = (JAVA / "PaperAutoLimits.java").read_text()
    assert "PaperAutoLimits.rejectionReason(" in source
    assert "d.beginTransaction()" in source[source.index("synchronized String openAuto"):source.index("private long utcDayStart")]
    assert "MAX_ENTRIES_PER_DAY = 3" in limits
    assert "SYMBOL_COOLDOWN_MS = 4L * 60L * 60L * 1000L" in limits
    assert '"signal_candle_already_processed"' in limits
    assert '"four_hour_cooldown"' in limits
    assert 'setFlagInternal(d,"auto_last_signal_candle"' in source


def test_auto_demo_remains_paper_only_and_live_execution_is_not_embedded():
    source = (JAVA / "LocalPaperActivity.java").read_text().lower()
    signal = (JAVA / "PaperSignal.java").read_text().lower()
    assert "no real order sent" in source
    assert "createorder" not in source
    assert "api_secret" not in source
    assert "private_key" not in source
    assert "news sentiment is unavailable" in source
    assert "deterministic" in signal or "explainable" in signal


def test_auto_demo_jvm_tests_are_part_of_android_test_suite():
    build = (ROOT / "build-android-debug.sh").read_text()
    assert "testdebugunittest" in build.lower()
    for name in ("PaperSignalTest.java", "PaperAutoLimitsTest.java"):
        assert (TEST / name).is_file()
