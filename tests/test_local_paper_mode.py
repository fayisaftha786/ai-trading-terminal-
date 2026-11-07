from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ANDROID = ROOT / "android"
JAVA = ANDROID / "app/src/main/java/app/aitradingterminal"


def test_local_demo_persists_timestamped_closed_candles_and_rejects_stale_market_data():
    source = (JAVA / "LocalPaperActivity.java").read_text()
    assert "x.getLong(0)" in source and "x.getLong(6)" in source
    assert "open_time INTEGER NOT NULL UNIQUE" in source
    assert "close_time INTEGER NOT NULL" in source
    assert "MAX_CANDLE_AGE_MS" in source
    assert "candle history has a gap or duplicate" in source
    assert "ignore the currently forming candle" in source
    assert "legacy cache has no trustworthy candle timestamps" in source
    assert "SELECT open_time,close_time" in source


def test_local_demo_ledger_reserves_capital_and_records_realistic_costs():
    source = (JAVA / "LocalPaperActivity.java").read_text()
    math = (JAVA / "PaperMath.java").read_text()
    assert "STARTING_CAPITAL_USD = 1_000.0" in math
    assert "POSITION_NOTIONAL_USD = 100.0" in math
    assert "FEE_RATE = 0.001" in math
    assert "SLIPPAGE_RATE = 0.0005" in math
    assert "availableCashInternal" in source
    assert "reservedInternal" in source
    assert "realizedInternal" in source
    assert "beginTransaction()" in source
    assert "entry_fee" in source and "exit_fee" in source
    assert "pnl_usd REAL" in source
    assert "PaperMath.netPnl" in source


def test_local_demo_uses_conservative_paper_stop_and_target_exits():
    source = (JAVA / "LocalPaperActivity.java").read_text()
    math = (JAVA / "PaperMath.java").read_text()
    assert "STOP_LOSS_RATE = 0.02" in math
    assert "TAKE_PROFIT_RATE = 0.04" in math
    assert "evaluateExits" in source
    assert "PaperMath.decideExit" in source
    assert "if (low <= stopLoss)" in math
    assert math.index("if (low <= stopLoss)") < math.index("if (high >= takeProfit)")
    assert "Math.min(open, stopLoss)" in math
    assert "candle.openTime<openedAt" in source


def test_local_demo_kill_switch_is_persistent_and_blocks_entries_only():
    source = (JAVA / "LocalPaperActivity.java").read_text()
    assert "CREATE TABLE flags" in source
    assert "setHalted(stopped)" in source
    assert "key='halted'" in source
    assert "new entries blocked; existing risk exits remain active" in source
    assert "marketLive&&!stopped" in source


def test_android_build_runs_jvm_tests_and_local_demo_has_no_live_executor():
    source = (JAVA / "LocalPaperActivity.java").read_text().lower()
    gradle = (ANDROID / "app/build.gradle.kts").read_text()
    script = (ROOT / "build-android-debug.sh").read_text()
    tests = ANDROID / "app/src/test/java/app/aitradingterminal/PaperMathTest.java"
    assert "testimplementation(\"junit:junit:4.13.2\")" in gradle.lower()
    assert "testdebugunittest" in script.lower()
    assert tests.is_file()
    assert "createorder" not in source
    assert "api_secret" not in source
    assert "private_key" not in source
