#!/usr/bin/env bash
# Dependency-free Android build. Requires JDK 17+ and Android SDK API/build-tools 36.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
task_sdk="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
if [ -z "$task_sdk" ]; then echo 'Set ANDROID_HOME to your Android SDK directory.' >&2; exit 1; fi
task_tools="$task_sdk/build-tools/36.0.0"
task_platform="$task_sdk/platforms/android-36/android.jar"
task_build="$task_root/android/app/build/manual-preview"
mkdir -p "$task_build/generated/ma/garageshare/app" "$task_build/classes" "$task_build/dex"
node "$task_root/scripts/sync-android.mjs"
python3 - "$task_root" "$task_build" <<'PY'
import pathlib,sys,xml.etree.ElementTree as E
root,build=map(pathlib.Path,sys.argv[1:]);ns='{http://schemas.android.com/apk/res/android}'
tree=E.parse(root/'android/app/src/main/AndroidManifest.xml');manifest=tree.getroot();manifest.set('package','ma.garageshare.app.preview')
app=manifest.find('application');app.set(ns+'debuggable','true');app.find('activity').set(ns+'name','ma.garageshare.app.MainActivity')
E.register_namespace('android',ns[1:-1]);tree.write(build/'AndroidManifest.xml',encoding='utf-8',xml_declaration=True)
(build/'generated/ma/garageshare/app/BuildConfig.java').write_text('package ma.garageshare.app; public final class BuildConfig { public static final boolean DEBUG=true; public static final String SERVER_URL=""; }')
PY
"$task_tools/aapt" package -f -m --auto-add-overlay --custom-package ma.garageshare.app \
  -J "$task_build/generated" -M "$task_build/AndroidManifest.xml" \
  -S "$task_root/android/app/src/main/res" -A "$task_root/android/app/src/main/assets" \
  -I "$task_platform" --min-sdk-version 26 --target-sdk-version 36 \
  --version-code 6 --version-name 0.5.0-preview -F "$task_build/unsigned.apk"
find "$task_root/android/app/src/main/java" "$task_build/generated" -name '*.java' > "$task_build/sources.txt"
javac --release 17 -classpath "$task_platform" -d "$task_build/classes" @"$task_build/sources.txt"
find "$task_build/classes" -name '*.class' > "$task_build/classes.txt"
"$task_tools/d8" --lib "$task_platform" --min-api 26 --output "$task_build/dex" @"$task_build/classes.txt"
python3 - "$task_build" <<'PY'
import pathlib,zipfile,sys
b=pathlib.Path(sys.argv[1])
with zipfile.ZipFile(b/'unsigned.apk','a',zipfile.ZIP_DEFLATED) as z:
 for p in (b/'dex').glob('*.dex'):z.write(p,p.name)
PY
"$task_tools/zipalign" -f 4 "$task_build/unsigned.apk" "$task_build/aligned.apk"
# Standard development key; never use this key for a Play Store release.
if [ ! -f "$task_build/preview.keystore" ]; then
 keytool -genkeypair -noprompt -keystore "$task_build/preview.keystore" -storepass android -keypass android \
  -alias androiddebugkey -dname 'CN=GarageShare Preview,O=GarageShare,C=MA' -keyalg RSA -keysize 2048 -validity 3650
fi
mkdir -p "$task_root/dist"
"$task_tools/apksigner" sign --ks "$task_build/preview.keystore" --ks-pass pass:android \
  --key-pass pass:android --out "$task_root/dist/GarageShare-preview.apk" "$task_build/aligned.apk"
"$task_tools/apksigner" verify --verbose "$task_root/dist/GarageShare-preview.apk"
echo "Created $task_root/dist/GarageShare-preview.apk"
