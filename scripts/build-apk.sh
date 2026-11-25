#!/usr/bin/env bash
set -euo pipefail

# Builds a signed, zipaligned Android APK (v1 + v2 + v3 signatures) directly using
# Android SDK Build-Tools (aapt2, d8, zipalign, apksigner) and JDK 17 (javac, keytool).

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT_DIR/app/src/main"
OUT_APK="${1:-$ROOT_DIR/releases/PS5-Mobile.apk}"

JAVA_HOME="${JAVA_HOME:-/tmp/android-toolchain/jdk17}"
ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-/tmp/android-toolchain/sdk}"
BUILD_TOOLS="${BUILD_TOOLS:-$ANDROID_SDK_ROOT/build-tools/android-14}"
ANDROID_JAR="${ANDROID_JAR:-$ANDROID_SDK_ROOT/platforms/android-34/android.jar}"

export PATH="$JAVA_HOME/bin:$BUILD_TOOLS:$PATH"

WORK_DIR="/tmp/ps5-mobile-apk-build"
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR/res_compiled" "$WORK_DIR/gen" "$WORK_DIR/classes" "$WORK_DIR/dex" "$(dirname "$OUT_APK")"

echo "[1/6] Compiling Android resources with aapt2..."
aapt2 compile --dir "$APP_DIR/res" -o "$WORK_DIR/res_compiled/resources.zip"

echo "[2/6] Linking resources & generating R.java..."
aapt2 link \
    -o "$WORK_DIR/app-unaligned.apk" \
    -I "$ANDROID_JAR" \
    --manifest "$APP_DIR/AndroidManifest.xml" \
    -A "$APP_DIR/assets" \
    --java "$WORK_DIR/gen" \
    --min-sdk-version 26 \
    --target-sdk-version 34 \
    --version-code 3 \
    --version-name "2.1.0" \
    -R "$WORK_DIR/res_compiled/resources.zip" \
    --auto-add-overlay

echo "[3/6] Compiling Java sources with javac 17 (target Java 11 bytecode)..."
mapfile -t JAVA_FILES < <(find "$APP_DIR/java" "$WORK_DIR/gen" -name "*.java" | sort)
javac \
    --release 11 \
    -encoding UTF-8 \
    -classpath "$ANDROID_JAR" \
    -d "$WORK_DIR/classes" \
    "${JAVA_FILES[@]}"

echo "[4/6] Translating bytecode to Dalvik DEX with d8..."
mapfile -t CLASS_FILES < <(find "$WORK_DIR/classes" -name "*.class" | sort)
d8 \
    --release \
    --min-api 26 \
    --lib "$ANDROID_JAR" \
    --output "$WORK_DIR/dex" \
    "${CLASS_FILES[@]}"

echo "[5/6] Packaging classes.dex & aligning APK..."
(cd "$WORK_DIR/dex" && zip -q -u "$WORK_DIR/app-unaligned.apk" classes.dex)
zipalign -f -p 4 "$WORK_DIR/app-unaligned.apk" "$WORK_DIR/app-aligned.apk"

echo "[6/6] Signing & verifying APK (v1 + v2 + v3)..."
KEYSTORE="$WORK_DIR/release-debug.jks"
keytool -genkeypair -noprompt \
    -alias ps5mobile \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -keystore "$KEYSTORE" \
    -storepass ps5mobilepass \
    -keypass ps5mobilepass \
    -dname "CN=PS5 Mobile, OU=Android Runtime, O=PS5Mobile, L=Tokyo, S=JP, C=US"

apksigner sign \
    --min-sdk-version 21 \
    --ks "$KEYSTORE" \
    --ks-key-alias ps5mobile \
    --ks-pass pass:ps5mobilepass \
    --key-pass pass:ps5mobilepass \
    --v1-signing-enabled true \
    --v2-signing-enabled true \
    --v3-signing-enabled true \
    --v4-signing-enabled false \
    --out "$OUT_APK" \
    "$WORK_DIR/app-aligned.apk"

apksigner verify --verbose "$OUT_APK"
zipalign -c 4 "$OUT_APK"
echo ""
echo "SUCCESS! Built & verified signed APK:"
ls -lh "$OUT_APK"
