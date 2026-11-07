#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SDK_ROOT="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
BUILD_TOOLS_VERSION="35.0.0"
EXPECTED_GRADLE_MAX_MAJOR="8"

fail() { echo "ERROR: $*" >&2; exit 2; }
[[ -n "$SDK_ROOT" && -d "$SDK_ROOT" ]] || fail "Android SDK not found. Set ANDROID_HOME or ANDROID_SDK_ROOT."
command -v java >/dev/null 2>&1 || fail "JDK 17 is required."
command -v gradle >/dev/null 2>&1 || fail "Gradle 8.9.x is required."

JAVA_VERSION="$(java -version 2>&1 | sed -n '1s/.*version \"\([0-9]*\).*/\1/p')"
[[ "$JAVA_VERSION" == "17" ]] || fail "Use JDK 17 (detected Java ${JAVA_VERSION:-unknown})."
[[ -f "$SDK_ROOT/platforms/android-35/android.jar" ]] || fail "Install Android SDK platform 35: sdkmanager 'platforms;android-35'."
AAPT="$SDK_ROOT/build-tools/$BUILD_TOOLS_VERSION/aapt"
APKSIGNER="$SDK_ROOT/build-tools/$BUILD_TOOLS_VERSION/apksigner"
[[ -x "$AAPT" ]] || fail "aapt missing from Android build-tools $BUILD_TOOLS_VERSION."
[[ -x "$APKSIGNER" ]] || fail "apksigner missing from Android build-tools $BUILD_TOOLS_VERSION."

GRADLE_VERSION="$(gradle --version | sed -n 's/^Gradle \([0-9][^ ]*\).*/\1/p' | head -n1)"
[[ -n "$GRADLE_VERSION" ]] || fail "Unable to read Gradle version."
python - "$GRADLE_VERSION" <<'PY'
import sys
parts = tuple(int(x) for x in sys.argv[1].split('.')[:2])
if parts < (8, 9) or parts[0] != 8:
    raise SystemExit(f"Android Gradle Plugin 8.7.3 requires Gradle 8.9; use Gradle 8.9.x (detected {sys.argv[1]}).")
PY

cd "$ROOT"
gradle --no-daemon --stacktrace -p "$ROOT/android" clean testDebugUnitTest assembleDebug
APK="$ROOT/android/app/build/outputs/apk/debug/app-debug.apk"
[[ -s "$APK" ]] || fail "Gradle completed but APK output is missing."
"$APKSIGNER" verify --verbose "$APK"
# Verify package/version/minSdk/targetSdk with aapt dump badging.
BADGING="$("$AAPT" dump badging "$APK")"
printf '%s\n' "$BADGING" | grep -Fq "package: name='app.aitradingterminal.debug' versionCode='47' versionName='0.7.0-debug'" || fail "APK package/version metadata does not match v0.7.0 debug build."
printf '%s\n' "$BADGING" | grep -Fq "sdkVersion:'26'" || fail "APK minSdk is not 26."
printf '%s\n' "$BADGING" | grep -Fq "targetSdkVersion:'35'" || fail "APK targetSdk is not 35."

mkdir -p "$ROOT/dist"
OUT="$ROOT/dist/AITradingTerminal-Android-v0.7.0-debug.apk"
cp "$APK" "$OUT"
(cd "$ROOT/dist" && sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256")
python - "$OUT" "$ROOT/dist/AITradingTerminal-Android-v0.7.0-build-info.txt" "$GRADLE_VERSION" "$JAVA_VERSION" <<'PY'
import hashlib, pathlib, sys
apk = pathlib.Path(sys.argv[1])
digest = hashlib.sha256(apk.read_bytes()).hexdigest()
pathlib.Path(sys.argv[2]).write_text(
    "AI Trading Terminal Android debug build\n"
    "Version: 0.7.0\n"
    f"Gradle: {sys.argv[3]}\nJava: {sys.argv[4]}\n"
    f"APK bytes: {apk.stat().st_size}\nSHA-256: {digest}\n"
    "Signing: Android debug key (testing only)\n"
    "Package: app.aitradingterminal.debug\nMin SDK: 26\nTarget SDK: 35\n",
    encoding="utf-8",
)
PY
printf '\nAPK: %s\nSHA-256: ' "$OUT"
sha256sum "$OUT" | awk '{print $1}'
