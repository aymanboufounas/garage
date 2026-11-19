# GarageShare Android App Bundle

[Download GarageShare 0.7.2 unsigned AAB](https://github.com/aymanboufounas/garage/raw/refs/heads/feature/play-compliance/dist/GarageShare-0.7.2-unsigned.aab)

This is an **unsigned** release Android App Bundle, not an APK. It cannot be
uploaded to Google Play until signed with your upload key. No signing key or
password is included. Its release settings are:

- Application ID: `com.garageshare.app` (the live app, not `.preview`).
- Version: `0.7.2`, versionCode `10`, target SDK `36`, minimum SDK `26`.
- Backend: `https://garageshare.xyz`.
- SHA256: `9d998d3246ee38a137d8fcf66a38f968c5546694ff6c7a2e618f9e12ebc00de4`.

The Gradle release build (including R8 and release lint) and bundletool validation
passed. The manifest, ZIP integrity, unsigned state and live origin were checked.
This is build validation; it does not establish Play review or physical-device
acceptance. The existing preview APK is a separate older artifact.

## Sign this downloaded bundle on Windows

Save the AAB to your Downloads folder. Open **PowerShell** (not Command Prompt).
These commands use the Java tools bundled with a normal Android Studio install.
If Android Studio is installed elsewhere, adjust `$studioTools` accordingly.

### 1. Create your upload keystore once

```powershell
$studioTools = "$env:ProgramFiles\Android\Android Studio\jbr\bin"
$uploadKey = "$env:USERPROFILE\GarageShare-upload.keystore"
if (Test-Path $uploadKey) { throw 'This key file already exists. Use the existing key instead of generating another.' }
& "$studioTools\keytool.exe" -genkeypair -v -storetype PKCS12 -keystore $uploadKey -alias garageshare -keyalg RSA -keysize 2048 -validity 10000
```

Enter a strong keystore password when the tool prompts, and fill in your operator
certificate details. The password is entered locally; do not put it in commands,
chat or GitHub. Keep the keystore, alias (`garageshare`) and password backed up
securely. Future updates use the same registered upload key. If Google Play
already has this application, use its registered upload key; creating another
one is not an automatic replacement for that key.

### 2. Sign the AAB

```powershell
$unsignedBundle = "$env:USERPROFILE\Downloads\GarageShare-0.7.2-unsigned.aab"
$signedBundle = "$env:USERPROFILE\Downloads\GarageShare-0.7.2-signed.aab"
& "$studioTools\jarsigner.exe" -keystore $uploadKey -signedjar $signedBundle -sigalg SHA256withRSA -digestalg SHA-256 $unsignedBundle garageshare
```

Enter your keystore password when prompted. This creates the signed copy and
leaves the downloaded unsigned file unchanged.

### 3. Verify the signed copy

```powershell
& "$studioTools\jarsigner.exe" -verify $signedBundle
```

Confirm that it reports `jar verified`. Keep the signing key private; upload only
`GarageShare-0.7.2-signed.aab` to Play Console's internal testing track. Complete
the account-specific Play Console release requirements separately. VersionCode
10 must be higher than any version already uploaded for this application; if not,
increase the project's versionCode and build a new bundle before signing.

## Alternative: generate and sign in Android Studio

Open the current project's `android` folder. Select **Build → Generate Signed
App Bundle / APK → Android App Bundle → Next**. Choose **Create new** to create a
keystore outside the repository (or select your existing upload key), choose the
`release` variant, and finish. Android Studio reports where it wrote the signed
AAB. The project defaults to the live domain and requires a nonempty HTTPS
`serverUrl`. The wizard builds a new bundle from your local source, so update the
checkout first.

Never use the preview/debug key for a public release. For release preparation,
see [the live release checklist](LIVE-RELEASE.md).
