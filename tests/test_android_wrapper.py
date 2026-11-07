from pathlib import Path
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
ANDROID = ROOT / "android"


def test_android_manifest_and_gradle_configuration_are_valid():
    manifest = ET.parse(ANDROID / "app/src/main/AndroidManifest.xml").getroot()
    app = manifest.find("application")
    assert app is not None
    activity = app.find("activity")
    assert activity is not None
    assert activity.attrib.get("{http://schemas.android.com/apk/res/android}exported") == "true"
    assert app.attrib.get("{http://schemas.android.com/apk/res/android}allowBackup") == "false"
    gradle = (ANDROID / "app/build.gradle.kts").read_text()
    assert "compileSdk = 35" in gradle
    assert "minSdk = 26" in gradle
    assert 'versionName = "0.6.0"' in gradle
    assert "versionCode = 46" in gradle


def test_android_wrapper_allows_only_https_cloud_origins_and_disables_file_access():
    activity = (ANDROID / "app/src/main/java/app/aitradingterminal/MainActivity.java").read_text()
    network = ET.parse(ANDROID / "app/src/main/res/xml/network_security_config.xml").getroot()
    manifest = (ANDROID / "app/src/main/AndroidManifest.xml").read_text()
    assert 'return "https".equals(scheme)' in activity
    assert 'if ("https".equals(scheme))' not in activity
    assert "HTTPS cloud connections only" in activity
    assert 'url.setHint("https://your-service.onrender.com")' in activity
    assert '"http".equals(scheme)' not in activity
    assert '"127.0.0.1".equals(host)' not in activity
    assert '"localhost".equals(host)' not in activity
    assert "setAllowFileAccess(false)" in activity
    assert "setAllowContentAccess(false)" in activity
    assert "MIXED_CONTENT_NEVER_ALLOW" in activity
    assert "handler.cancel()" in activity
    assert 'android:usesCleartextTraffic="false"' in manifest
    assert "cleartextTrafficPermitted=\"false\"" in ET.tostring(network, encoding="unicode")



def test_android_wrapper_does_not_embed_secrets_or_local_python_runtime():
    java = (ANDROID / "app/src/main/java/app/aitradingterminal/MainActivity.java").read_text().lower()
    assert "api_secret" not in java
    assert "private_key" not in java
    assert "seed_phrase" not in java
    assert "chaquopy" not in java
    assert "processbuilder" not in java
    assert "termux" not in java


def test_ci_contains_native_debug_apk_build_and_artifact_upload():
    workflow = (ROOT / ".github/workflows/cloud-apk.yml").read_text()
    assert "AITradingTerminal-Android-v0.6.0-debug-apk" in workflow
    assert 'test -s android/app/build.gradle.kts' in workflow
    assert "AITradingTerminal-v0.6.0-No-Termux-Cloud-Source.zip" not in workflow
    assert '"android/**"' in workflow
    assert "build-android-debug.sh" in workflow
    assert "upload-artifact@v7" in workflow
    assert "dist/AITradingTerminal-Android-v0.6.0-debug.apk.sha256" in workflow
    assert "retention-days: 30" in workflow
    assert "android-actions/setup-android@v4" in workflow
    assert "gradle/actions/setup-gradle@v6" in workflow
    assert "cache-provider: basic" in workflow
    assert "accept-android-sdk-licenses: true" in workflow
    assert "verify-and-build:" in workflow
    assert "actions/setup-java@v6" in workflow


def test_android_release_workflow_uses_current_node24_compatible_actions():
    workflow = (ROOT / ".github/workflows/cloud-apk.yml").read_text()
    assert "actions/setup-python@v7" in workflow
    assert "actions/setup-node@v7" in workflow
    assert "actions/upload-artifact@v7" in workflow
    assert 'gradle-version: "8.9"' in workflow
    assert 'java-version: "17"' in workflow


def test_android_build_script_checks_sdk_signs_and_hashes_apk():
    script = (ROOT / "build-android-debug.sh").read_text()
    assert "platforms/android-35/android.jar" in script
    assert "build-tools/$BUILD_TOOLS_VERSION/apksigner" in script
    assert 'verify --verbose "$APK"' in script
    assert "sha256sum" in script
    assert "AITradingTerminal-Android-v0.6.0-debug.apk" in script


def test_android_build_script_rejects_unsupported_gradle_major_and_checks_apk_metadata():
    script = (ROOT / "build-android-debug.sh").read_text()
    assert 'EXPECTED_GRADLE_MAX_MAJOR="8"' in script
    assert "parts[0] != 8" in script
    assert "aapt dump badging" in script
    assert "versionCode='46' versionName='0.6.0-debug'" in script
    assert "sdkVersion:'26'" in script
    assert "targetSdkVersion:'35'" in script


def test_android_gradle_version_code_matches_post_build_apk_verifier():
    gradle = (ANDROID / "app/build.gradle.kts").read_text()
    script = (ROOT / "build-android-debug.sh").read_text()
    assert "versionCode = 46" in gradle
    assert "versionName = \"0.5.0\"" in gradle
    assert "versionCode='46' versionName='0.6.0-debug'" in script


def test_android_target_35_applies_system_bar_and_cutout_insets():
    activity = (ANDROID / "app/src/main/java/app/aitradingterminal/MainActivity.java").read_text()
    assert "setOnApplyWindowInsetsListener" in activity
    assert "WindowInsets.Type.systemBars()" in activity
    assert "WindowInsets.Type.displayCutout()" in activity
    assert "getSystemWindowInsetTop()" in activity


def test_android_wrapper_has_no_cleartext_or_loopback_fallback():
    activity = (ANDROID / "app/src/main/java/app/aitradingterminal/MainActivity.java").read_text()
    assert 'return "https".equals(scheme)' in activity
    assert "http://127.0.0.1" not in activity
    assert "localhost" not in activity


def test_apk_checksum_is_relocatable_after_artifact_download():
    script = (ROOT / "build-android-debug.sh").read_text()
    assert 'cd "$ROOT/dist" && sha256sum "$(basename "$OUT")"' in script
    guide = (ROOT / "docs/GET_ANDROID_APK.md").read_text()
    assert "Actions" in guide and "Artifacts" in guide
    assert "No Termux is required" in guide


def test_gitignore_excludes_secret_environment_variants_but_keeps_example():
    ignore = (ROOT / ".gitignore").read_text().splitlines()
    assert ".env" in ignore
    assert ".env.*" in ignore
    assert "!.env.example" in ignore
