from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
VERSION = "0.5.0"
ARCHIVE_NAME = f"AITradingTerminal-v{VERSION}-source.zip"


def run_step(name: str, command: list[str]) -> dict[str, object]:
    proc = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
    return {
        "name": name,
        "command": command,
        "exit_code": proc.returncode,
        "stdout": proc.stdout[-12000:],
        "stderr": proc.stderr[-6000:],
        "status": "PASS" if proc.returncode == 0 else "FAIL",
    }


def build_archive(destination: Path) -> None:
    excluded_dirs = {".git", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", "data", "dist", "build", "outputs"}
    excluded_suffixes = {".pyc", ".pyo", ".db", ".sqlite", ".sqlite3"}
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(ROOT.rglob("*")):
            if not path.is_file():
                continue
            rel = path.relative_to(ROOT)
            if any(part in excluded_dirs for part in rel.parts):
                continue
            if path.suffix in excluded_suffixes or path.name == ".env":
                continue
            archive.write(path, Path("ai-trading-terminal") / rel)


def main() -> int:
    DIST.mkdir(exist_ok=True)
    checks = [
        run_step("python_compile", [sys.executable, "-m", "compileall", "-q", "app", "tests"]),
        run_step("pytest", [sys.executable, "-m", "pytest", "-q"]),
        run_step("javascript_syntax", ["node", "--check", "static/app.js"]),
        run_step("android_build_script_syntax", ["bash", "-n", "build-android-debug.sh"]),
    ]
    main_source = (ROOT / "app/main.py").read_text(encoding="utf-8")
    storage_source = (ROOT / "app/storage.py").read_text(encoding="utf-8")
    strategy_source = (ROOT / "app/services/strategy.py").read_text(encoding="utf-8")
    market_data_source = (ROOT / "app/services/market_data.py").read_text(encoding="utf-8")
    backtest_source = (ROOT / "app/services/backtest.py").read_text(encoding="utf-8")
    risk_source = (ROOT / "app/services/risk.py").read_text(encoding="utf-8")
    paper_source = (ROOT / "app/services/paper.py").read_text(encoding="utf-8")
    automation_source = (ROOT / "app/services/automation.py").read_text(encoding="utf-8")
    storage_source = (ROOT / "app/storage.py").read_text(encoding="utf-8")
    testnet_source = (ROOT / "app/services/testnet.py").read_text(encoding="utf-8")
    testnet_auto_source = (ROOT / "app/services/testnet_auto.py").read_text(encoding="utf-8")
    testnet_auto_tests_source = (ROOT / "tests/test_testnet.py").read_text(encoding="utf-8")
    schema_source = (ROOT / "app/schemas.py").read_text(encoding="utf-8")
    android_activity = (ROOT / "android/app/src/main/java/app/aitradingterminal/MainActivity.java").read_text(encoding="utf-8")
    android_manifest = (ROOT / "android/app/src/main/AndroidManifest.xml").read_text(encoding="utf-8")
    android_gradle = (ROOT / "android/app/build.gradle.kts").read_text(encoding="utf-8")
    android_workflow = (ROOT / ".github/workflows/cloud-apk.yml").read_text(encoding="utf-8")
    frontend_source = "\n".join(
        path.read_text(encoding="utf-8").lower()
        for path in (ROOT / "static").glob("*")
        if path.is_file() and path.suffix in {".html", ".js", ".css", ".webmanifest"}
    )
    safety_checks = {
        "release_version_is_consistent": 'version="0.5.0-cloud"' in main_source and "CLOUD EDITION" in (ROOT / "static/index.html").read_text() and "VERSION = \"0.5.0\"" in (ROOT / "scripts/master_release.py").read_text(),
        "live_endpoint_explicitly_locked": "HTTPException(status_code=423" in main_source,
        "twelve_worker_read_only_manager_present": "WorkerManager(concurrency=4" in main_source and "execution_authorized" in (ROOT / "app/services/workers.py").read_text() and '"live_trading_enabled": False' in (ROOT / "app/services/workers.py").read_text(),
        "worker_dashboard_and_tests_present": 'id="workers"' in (ROOT / "static/index.html").read_text() and (ROOT / "tests/test_workers.py").is_file() and (ROOT / "docs/MULTI_AGENT_WORKERS.md").is_file(),
        "worker_sentiment_not_fabricated": '"status": "unavailable"' in (ROOT / "app/services/workers.py").read_text() and "No licensed news feed" in (ROOT / "app/services/workers.py").read_text(),
        "paper_auto_entry_defaults_off_and_persists_opt_in": 'app.state.auto_paper_enabled = bool(db.get_setting("auto_paper_enabled", False))' in main_source and 'db.set_setting("auto_paper_enabled", False)' in main_source,
        "kill_switch_route_present": '@app.post("/api/automation/kill-switch")' in main_source,
        "sqlite_unique_open_market_guard_present": "idx_trades_one_open_per_market" in storage_source,
        "no_exchange_or_wallet_secrets_in_frontend": not any(
            marker in frontend_source for marker in ("api_secret", "secret_key", "private_key", "seed_phrase")
        ),
        "solana_discovery_not_mislabelled_as_sniper": "solana discovery" in frontend_source and "solana sniper" not in frontend_source,
        "backtest_strategy_scope_disclosed": "separate ema20/50" in frontend_source and "not the automatic-entry strategy" in frontend_source,
        "pwa_manifest_present": (ROOT / "static/manifest.webmanifest").is_file(),
        "cloud_deploy_blueprint_present": (ROOT / "render.yaml").is_file(),
        "pwa_service_worker_present": (ROOT / "static/sw.js").is_file(),
        "pwa_offline_page_present": (ROOT / "static/offline.html").is_file(),
        "pwa_icons_present": all((ROOT / f"static/icons/icon-{size}.png").is_file() for size in (192, 512)),
        "android_gradle_project_present": (ROOT / "android/settings.gradle.kts").is_file() and (ROOT / "android/app/build.gradle.kts").is_file(),
        "android_native_shell_present": (ROOT / "android/app/src/main/java/app/aitradingterminal/MainActivity.java").is_file(),
        "android_cleartext_disabled_for_all_hosts": "android:usesCleartextTraffic=\"false\"" in android_manifest and "cleartextTrafficPermitted=\"false\"" in (ROOT / "android/app/src/main/res/xml/network_security_config.xml").read_text(),
        "android_https_cloud_backend_allowlist_present": 'return "https".equals(scheme)' in android_activity and 'your-service.onrender.com' in android_activity and 'http".equals(scheme)' not in android_activity,
        "android_no_webview_file_access": "setAllowFileAccess(false)" in android_activity and "setAllowContentAccess(false)" in android_activity,
        "android_ci_apk_job_present": "AITradingTerminal-Android-v0.7.0-debug-apk" in android_workflow and "build-android-debug.sh" in android_workflow and "upload-artifact@v7" in android_workflow,
        "android_ci_uploads_apk_checksum_and_metadata": all(name in android_workflow for name in ("AITradingTerminal-Android-v0.7.0-debug.apk", "AITradingTerminal-Android-v0.7.0-debug.apk.sha256", "AITradingTerminal-Android-v0.7.0-build-info.txt")),
        "android_local_build_verifies_sdk_and_signature": all(marker in (ROOT / "build-android-debug.sh").read_text() for marker in ("platforms/android-35/android.jar", "apksigner", "sha256sum")),
        "android_build_script_restricts_gradle_to_compatible_8x": "EXPECTED_GRADLE_MAX_MAJOR=\"8\"" in (ROOT / "build-android-debug.sh").read_text() and "parts[0] != 8" in (ROOT / "build-android-debug.sh").read_text(),
        "android_apk_metadata_verified_after_build": all(marker in (ROOT / "build-android-debug.sh").read_text() for marker in ("aapt dump badging", "versionCode='47'", "sdkVersion:'26'", "targetSdkVersion:'35'")),
        "android_gradle_version_code_matches_apk_verifier": 'versionCode = 47' in android_gradle and 'versionName = "0.7.0"' in android_gradle and "versionCode='47' versionName='0.7.0-debug'" in (ROOT / "build-android-debug.sh").read_text(),
        "android_auto_demo_is_opt_in_and_foreground_only": all(marker in (ROOT / "android/app/src/main/java/app/aitradingterminal/LocalPaperActivity.java").read_text() for marker in ("AUTO DEMO: OFF", "AUTO_REFRESH_MS=5L*60L*1000L", "onPause()", "PaperAutoLimits.rejectionReason", "fetchCandles(\"4h\"")) and all(marker in (ROOT / "android/app/src/main/java/app/aitradingterminal/PaperSignal.java").read_text() for marker in ("MAX_SPREAD_BPS = 25.0", "MIN_TOP10_DEPTH_USD = 5_000.0", "MIN_QUOTE_VOLUME_USD = 1_000_000.0", "expectedRange < roundTrip * 2.5")),
        "android_ci_action_versions_currently_pinned": all(marker in android_workflow for marker in ("actions/setup-python@v7", "actions/setup-node@v7", "actions/upload-artifact@v7", "actions/checkout@v7", "actions/setup-java@v6", "android-actions/setup-android@v4", "gradle/actions/setup-gradle@v6")),
        "android_gradle_cache_uses_open_source_provider": "cache-provider: basic" in android_workflow,
        "production_api_authentication_present": "private_api_guard" in main_source and "create_access_token" in main_source and "APP_PASSWORD" in (ROOT / "app/settings.py").read_text(),
        "production_health_endpoint_minimizes_public_information": 'if auth_required:\n            return {"status": "ok", "mode": "paper_only", "live_trading_enabled": False,' in main_source,
        "api_responses_marked_no_store": '"Cache-Control", "no-store, private"' in main_source and '"Pragma", "no-cache"' in main_source,
        "render_auto_deploy_waits_for_manual_release": "autoDeploy: false" in (ROOT / "render.yaml").read_text(),
        "cloud_login_frontend_present": "/api/auth/login" in frontend_source and "att_cloud_token" in frontend_source,
        "render_persistent_disk_configuration_present": "mountPath: /var/data" in (ROOT / "render.yaml").read_text() and "sizeGB: 1" in (ROOT / "render.yaml").read_text(),
        "single_worker_container_command_present": "--workers 1" in (ROOT / "Dockerfile").read_text(),
        "termux_runtime_files_removed": not (ROOT / "run-termux.sh").exists() and not (ROOT / "requirements-termux.txt").exists() and "termux" not in (ROOT / "android/app/src/main/java/app/aitradingterminal/MainActivity.java").read_text().lower(),
        "android_edge_to_edge_insets_handled": "setOnApplyWindowInsetsListener" in android_activity and "WindowInsets.Type.systemBars()" in android_activity and "WindowInsets.Type.displayCutout()" in android_activity,
        "android_cloud_backend_uses_https_only": 'return "https".equals(scheme)' in android_activity and 'http://127.0.0.1' not in android_activity,
        "browser_only_apk_guide_present": (ROOT / "docs/GET_ANDROID_APK.md").is_file() and "No Termux is required" in (ROOT / "docs/GET_ANDROID_APK.md").read_text(),
        "android_apk_checksum_is_relocatable": 'cd "$ROOT/dist" && sha256sum "$(basename "$OUT")"' in (ROOT / "build-android-debug.sh").read_text(),
        "android_artifact_retention_30_days": "retention-days: 30" in android_workflow,
        "android_source_does_not_claim_to_contain_apk": not any(path.suffix.lower() == ".apk" for path in ROOT.rglob("*" ) if path.is_file() and "dist" not in path.parts and "build" not in path.parts),
        "android_apk_download_guide_present": (ROOT / "docs/GET_ANDROID_APK.md").is_file(),
        "performance_reporting_present": (ROOT / "app/services/performance.py").is_file(),
        "performance_tests_present": (ROOT / "tests/test_performance.py").is_file(),
        "restart_exit_recovery_present": "startup_exit_recovery" in main_source,
        "testnet_connection_is_sandboxed": "exchange.set_sandbox_mode(True)" in (ROOT / "app/services/testnet.py").read_text(),
        "testnet_orders_require_explicit_local_gate": "binance_testnet_order_enabled" in (ROOT / "app/services/testnet.py").read_text() and "BINANCE_TESTNET_ORDER_ENABLED=false" in (ROOT / ".env.example").read_text(),
        "testnet_limit_only_order_path": '"limit", side, amount, price' in (ROOT / "app/services/testnet.py").read_text(),
        "testnet_idempotency_ledger_present": "idempotency_key TEXT NOT NULL UNIQUE" in storage_source and "client_order_id TEXT NOT NULL UNIQUE" in storage_source,
        "testnet_unknown_state_blocks_retry": "state {existing['status']}" in (ROOT / "app/services/testnet.py").read_text() and '"UNKNOWN"' in (ROOT / "app/services/testnet.py").read_text(),
        "testnet_orders_have_refresh_and_cancel_routes": all(route in main_source for route in ('/api/testnet/orders/{client_order_id}/refresh', '/api/testnet/orders/{client_order_id}/cancel')),
        "testnet_emergency_lock_is_persistent": 'storage.set_setting("testnet_order_halted", True)' in (ROOT / "app/services/testnet.py").read_text() and '/api/testnet/kill-switch/reset' in main_source,
        "testnet_submit_and_emergency_stop_serialized": "threading.RLock()" in (ROOT / "app/services/testnet.py").read_text() and "with self._order_lock:" in (ROOT / "app/services/testnet.py").read_text(),
        "testnet_orders_ui_present": 'id="testnetOrderForm"' in (ROOT / "static/index.html").read_text() and "loadtestnet" in frontend_source and 'id="testnetStopBtn"' in (ROOT / "static/index.html").read_text(),
        "testnet_does_not_enable_live_orders": "live_trading_enabled: bool = False" in (ROOT / "app/settings.py").read_text(),
        "testnet_strategy_auto_engine_present": "class TestnetAutoTrader" in testnet_auto_source,
        "testnet_strategy_auto_requires_fresh_restart_opt_in": "app.state.auto_testnet_enabled = False" in main_source and 'db.set_setting("testnet_auto_trading_enabled", False)' in main_source and "test_testnet_auto_entries_require_fresh_opt_in_after_restart_and_reconciliation_continues" in (ROOT / "tests/test_api.py").read_text(),
        "testnet_fee_recovery_keeps_background_scheduler_alive": "db.testnet_auto_unaccounted_closed_count() > 0" in main_source and "testnet_closed_trades_awaiting_accounting" in main_source,
        "testnet_auto_idempotency_uses_closed_candle": 'candle_stamp = item.get("last_closed_candle_timestamp_ms") or ticker.get("timestamp")' in testnet_auto_source and "test_testnet_auto_idempotency_uses_closed_candle_not_live_ticker_timestamp" in testnet_auto_tests_source,
        "testnet_strategy_auto_uses_native_opoco_fok": '"orderList/opoco"' in testnet_auto_source and '"workingTimeInForce": "FOK"' in testnet_auto_source and '"pendingAboveType": "TAKE_PROFIT"' in testnet_auto_source and '"pendingBelowType": "STOP_LOSS"' in testnet_auto_source,
        "testnet_strategy_auto_requires_complete_entry_and_exit_fills": "_is_fully_filled_order" in testnet_auto_source and "PARTIALLY_FILLED_ENTRY_WITHOUT_PROTECTED_EXIT" in testnet_auto_source and "FILLED_ENTRY_WITHOUT_CONFIRMED_EXIT" in testnet_auto_source,
        "testnet_strategy_auto_fee_ledger_uses_trade_level_fills": "fetch_order_trades" in testnet_auto_source and "fetch_my_trades" in testnet_auto_source and "commission" in testnet_auto_tests_source.lower(),
        "testnet_strategy_auto_retries_unresolved_fee_ledger": "list_unaccounted_testnet_auto_orders" in storage_source and "accounting_retried" in testnet_auto_source,
        "testnet_strategy_auto_loss_guard_and_recovery_present": "_daily_loss_guard" in testnet_auto_source and "testnet_auto_loss_halt_day" in testnet_auto_source and "emergency_stop" in testnet_auto_source,
        "testnet_strategy_auto_safety_regressions_present": all(name in testnet_auto_tests_source for name in ("test_testnet_auto_requires_a_fully_filled_exit_before_closing_position", "test_testnet_auto_emergency_stop_does_not_clear_terminal_entry_with_positive_fill", "test_testnet_auto_reads_trade_level_commissions_when_order_snapshot_omits_fees")),
        "testnet_auto_performance_dashboard_present": "/api/testnet/auto-performance" in main_source and 'id="testnetAutoPnl"' in (ROOT / "static/index.html").read_text(),
        "indicator_analyzer_uses_wilder_adx_and_direction": all(token in strategy_source for token in ("Wilder RSI", "_wilder_atr_adx", "plus_di14", "ema20_slope_pct")),
        "raw_candle_integrity_detects_duplicates_and_alignment": all(token in strategy_source for token in ("candle_integrity_report", "duplicate_timestamps", "off_grid_timestamps", "missing_intervals")),
        "market_data_gaps_force_hold": "if not primary_clean or not higher_clean" in market_data_source and 'analysis["regime"] = "DATA_GAP"' in market_data_source,
        "research_backtests_reject_raw_candle_integrity_failures": "candle_integrity_report" in backtest_source and "duplicate/invalid" in backtest_source,
        "research_backtests_use_same_saved_risk_profile": "current_saved_server_risk_profile" in main_source and 'risk_per_trade_pct=float(risk["risk_per_trade_pct"])' in main_source and 'fee_bps=float(risk["fee_bps_per_side"])' in main_source,
        "risk_profile_checks_net_reward_risk": "minimum_target_pct" in risk_source and "net_reward_risk" in schema_source,
        "paper_exit_uses_safe_costs_when_profile_invalid": "safe_cost_assumptions(self.db.get_risk())" in paper_source,
        "analysis_ui_displays_raw_integrity_counts": "duplicate_timestamps" in frontend_source and "off_grid_timestamps" in frontend_source and "integritydetails" in frontend_source,
        "walk_forward_reports_benchmark_and_cost_stress": "excess_return_vs_benchmark_pct" in backtest_source and all(f"{multiplier}" in backtest_source for multiplier in ("1.0", "1.5", "2.0")),
        "paper_portfolio_entry_sizing_is_serialized": "threading.RLock()" in paper_source and "with self._entry_lock:" in paper_source,
        "automatic_paper_position_size_includes_observed_spread": "_entry_spread_bps" in automation_source and "extra_round_trip_cost_bps" in risk_source,
        "paper_take_profit_uses_target_reference_price": 'self.close(trade["id"], float(trade["take_profit"]), "take_profit")' in paper_source,
        "corrupt_trade_metadata_cannot_block_exit": "metadata_recovered" in paper_source,
        "unknown_exchange_order_status_fails_closed": 'get(status, "UNKNOWN")' in testnet_source,
        "definitive_exchange_rejections_are_classified": 'exc_name in self.DEFINITIVE_REJECTIONS' in testnet_source,
        "testnet_refresh_cancel_share_order_lock": all("with self._order_lock:" in testnet_source for _ in (0,)) and "def _refresh_order_locked" in testnet_source and "def _cancel_order_locked" in testnet_source,
        "testnet_emergency_stop_scans_all_active_orders": "list_active_testnet_orders" in testnet_source and "def list_active_testnet_orders" in storage_source,
        "testnet_manual_auto_same_symbol_reservations_are_atomic": all(marker in storage_source for marker in (
            "conflicting_auto = conn.execute(",
            "An active automatic Testnet order already exists for this symbol.",
            "conflicting_manual = conn.execute(",
            "An active manual Testnet order already exists for this symbol.",
        )) and "test_manual_and_automatic_testnet_orders_cannot_reserve_same_symbol" in testnet_auto_tests_source,
        "testnet_auto_emergency_stop_latches_shared_order_gate_first": 'self.storage.set_setting("testnet_order_halted", True)' in testnet_auto_source and "test_testnet_auto_kill_switch_preserves_exchange_native_exits_for_filled_entry" in testnet_auto_tests_source,
        "testnet_opoco_response_requires_working_order_id": "and working_order_id is not None" in testnet_auto_source and "test_testnet_auto_does_not_claim_submission_without_working_order_id" in testnet_auto_tests_source,
        "scan_toggle_preserves_open_position_exit_monitor": "exit_monitoring_required" in main_source and "required_for_positions" in main_source,
        "paper_disable_preserves_position_exit_monitor": "if payload.enabled or cex_positions_open" in main_source and "exit_monitoring_required" in main_source,
        "signal_backtest_checks_entry_bar_protective_exits": "entry_hit_stop" in backtest_source and "including the entry candle" in backtest_source,
    }
    checks.append({"name": "safety_static_checks", "status": "PASS" if all(safety_checks.values()) else "FAIL", "checks": safety_checks})
    passed = all(item["status"] == "PASS" for item in checks)
    archive_path = DIST / ARCHIVE_NAME
    digest = None
    if passed:
        build_archive(archive_path)
        digest = hashlib.sha256(archive_path.read_bytes()).hexdigest()
        (DIST / f"{ARCHIVE_NAME}.sha256").write_text(f"{digest}  {ARCHIVE_NAME}\n", encoding="utf-8")
    report = {
        "version": VERSION,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "status": "PASS" if passed else "FAIL",
        "mode": "paper_automation_plus_gated_testnet_auto",
        "automatic_strategy_mode": "paper_plus_binance_spot_testnet_sandbox",
        "testnet_manual_orders_enabled_by_default": False,
        "testnet_auto_strategy_enabled_by_default": False,
        "testnet_auto_environment": "binance_spot_testnet_only",
        "live_trading_enabled": False,
        "android_apk_built": False,
        "android_gradle_source_included": True,
        "android_ci_build_job_configured": True,
        "android_ci_build_job_executed": False,
        "pwa_installable_shell": all(safety_checks.get(k, False) for k in ("pwa_manifest_present", "pwa_service_worker_present", "pwa_offline_page_present", "pwa_icons_present")),
        "checks": checks,
        "archive": str(archive_path) if passed else None,
        "archive_sha256": digest,
        "limitations": [
            "Deterministic rules only; the analyzer score is not a calibrated probability and no trained AI/ML model is included.",
            "Strategy research requires contiguous closed OHLCV. Candle replay cannot reconstruct historical spread, depth, ticker freshness, queue priority, partial fills, latency or market impact.",
            "Walk-forward is limited by fetched history; it is not an untouched final holdout or a statistically powered profitability claim.",
            "No real-money order execution or Solana swap signing.",
            "Binance Spot Testnet manual LIMIT and strategy-driven OPOCO paths are gated; authenticated end-to-end exchange lifecycle, fills, commissions and emergency recovery remain unverified until tested against a real Spot Testnet account.",
            "Strategy-driven exchange entries are implemented only for Binance Spot Testnet behind separate environment, order, and dashboard opt-in gates; production LIVE execution remains hard-disabled.",
            "Paper allocation serialization is process-local and assumes the documented single-worker local backend; multi-worker production deployment is not supported.",
            "Cloud deployment requires a paid always-on service with persistent storage; the Render Blueprint is the lowest configured production-style option and is not free.",
            "Cloud authentication is a single-user password login with short-lived HMAC bearer tokens and process-local login throttling; it is not yet multi-user or an enterprise identity system.",
            "A persistent Render disk enforces one service instance; the app must run one Uvicorn worker because its scheduler and SQLite ledger are designed for a single process.",
            "Paper auto-entry opt-in persists across ordinary restarts; the emergency kill switch and drawdown breaker keep new entries OFF. No real-money order execution or Solana swap signing is enabled.",
            "Native Android WebView wrapper Gradle source and a GitHub Actions debug-APK build job are included; this workspace has no Android SDK/build-tools, so no APK was built or installed on a physical device here.",
        ],
    }
    report_path = DIST / "verification-report.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
