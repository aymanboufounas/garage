# GarageShare: VPS to Google Play

## 1. Finish DNS and HTTPS

The Android project defaults to `https://garageshare.xyz`. The VPS is currently
`108.165.15.153`; keep the IP in DNS, not in the app. No server credentials or
SQLite file belong in Android. All devices use the server API and its database.

In the authoritative DNS panel, set the root (`@`) A record to that IPv4 address.
Remove conflicting root A records and old AAAA records unless IPv6 is explicitly
configured on this VPS. Leave email records unchanged. Verify on the VPS:

```bash
dig +short NS garageshare.xyz
dig +short A garageshare.xyz
dig +short AAAA garageshare.xyz
```

For the IPv4-only setup, A must show only `108.165.15.153` and AAAA must be empty.
Wait for caches after saving. If results stay wrong, check the domain's actual
nameservers; changing records in an inactive DNS panel will have no effect.

The service and Nginx were previously configured; see DEPLOYMENT.md for their
full configuration. Allow inbound TCP 80/443 in the provider firewall, leave Node
port 3000 private, and issue the certificate only when DNS is correct:

```bash
nginx -t && systemctl reload nginx
certbot --nginx -d garageshare.xyz --redirect
curl -fsS https://garageshare.xyz/api/config
certbot renew --dry-run
systemctl status certbot.timer --no-pager
```

The HTTPS request must return JSON with `demo:false`; seeing an HTTPS URL in
Node's startup log alone does not verify DNS or certificate issuance. Stop here
if Certbot or the HTTPS request fails. Never bypass TLS validation.

## 2. Check the database and live website

The service uses Node 24 and `/opt/garageshare/data/garageshare.sqlite`, created
automatically by the backend. SQLite is supported as-is; no MySQL credentials
are needed. Run one Node process. Verify it survives a service restart:

```bash
systemctl restart garageshare
systemctl status garageshare --no-pager
# Run after the startup log says ready:
curl -fsS https://garageshare.xyz/api/config
```

Open the domain, register a real test host and renter in separate browser
profiles, and submit a test listing. An empty marketplace is expected: no demo
listings are inserted in live mode. Pending listings need operator approval with
an accurate authorized photo (see DEPLOYMENT.md). Test bookings, offers,
cancellations, messages, and host/support access before opening to customers.

Before updates, back up SQLite with its online backup mechanism, or stop the
service and copy the database with its WAL consistently. Also back up
`web/assets/host-photos`, encrypt/store a copy outside the VPS, and test restore.
Never copy just a running SQLite main file and assume it is a valid backup.
Apply Ubuntu security updates and check whether a reboot is required.

## 3. Update the Windows Android Studio checkout

If you cloned with Git, commit/stash your own changes first, then run `git pull
--ff-only` from that clone. If you downloaded a ZIP, download the updated main ZIP
and extract into a new folder; preserve your private signing key separately.
Open `garage-main/android` in Android Studio, not the repository's outer folder.

Use Gradle JVM 21 (compatible with Gradle 8.13), SDK Platform 36, Build Tools
36.0.0, and install Node.js 24 on Windows for the repository's Node scripts/tests.
The project compiles Java source targeting Java 17. Sync the project. No Android
or Gradle upgrade is needed for this configuration.

`android/gradle.properties` now contains:

```properties
serverUrl=https://garageshare.xyz
```

Choose a USB-debugging phone and click Run. This debug installation uses
`ma.garageshare.app.preview`, but now connects to the real database. It is not
the offline sample preview; use test accounts and avoid real commitments.
Test login/logout, back navigation, denied/allowed location, network loss,
messages, and bookings across two devices. Persisted records should remain
after closing/reopening the app and restarting the service.

For an explicit offline demo build in the Android Studio PowerShell terminal:

```powershell
.\gradlew.bat assembleDebug -PserverUrl=
```

For a connected debug build:

```powershell
.\gradlew.bat assembleDebug
```

Bundled assets are synced automatically. The existing APK in dist/ remains an
older offline preview; this configuration change does not rebuild that APK.

## 4. Complete public-release requirements

This change configures the backend address; it does not implement the remaining
launch features. Complete and test account recovery, email verification, and
account deletion in-app plus a public web deletion request page. Publish accurate
privacy and rental policies with operator/support details. Prepare real listings,
moderation, retention, backup/restore and support operations. Keep uploads and
sensitive database files outside publicly served paths.

Google sign-in is optional and currently disabled without server configuration.
If enabling it, follow DEPLOYMENT.md: keep the OAuth secret on the VPS, configure
the exact redirect URL, and set ANDROID_APP_SHA256 to the Play app signing
certificate fingerprint (not the upload certificate). Check Android App Links.
Never embed the OAuth client secret or service credentials in the APK.

## 5. Build a signed Android App Bundle

Confirm HTTPS and real-device flows before building the release. In Android Studio:

1. Build > Generate Signed App Bundle / APK > Android App Bundle.
2. Select module `app` and create/select your own upload keystore outside the
   repository. Back up the keystore and passwords securely; do not commit them.
3. Choose the `release` build and generate the signed `.aab`. Use the output
   location Android Studio reports. A release requires a nonempty HTTPS serverUrl.
4. Keep application ID `ma.garageshare.app` if it is your intended Play identity.
   The debug `.preview` ID is a different app. Confirm ownership/availability in
   Play Console before the first release.
5. Current versionCode is 8. If Play has already accepted 8 or higher for this
   application, increment it beyond the highest uploaded value before building.

There is no checked-in signing key. `bundleRelease` alone does not configure
release signing; use the signed-bundle wizard above. APK files are not the AAB
needed for a new Google Play app.

## 6. Test and submit in Play Console

Create/select GarageShare, enable Play App Signing, and upload the signed AAB
to internal testing first. Provide reviewer access to a working account and any
required host/renter flows. Complete the store listing (icon, screenshots,
description, support contact), privacy policy URL, Data safety, content rating,
target audience, ads declaration, app access and deletion information based on
what the app actually does. Review pre-launch reports and fix material failures.

Follow the testing/production-access requirements shown for your developer
account; do not assume an internal test alone grants production access. Verify
the current target API and policy requirements in Play Console at submission.
Promote the tested release to production and submit for Google review only once
these requirements and the outstanding app features above are complete.

Publication, DNS changes, certificate issuance and a signed build are separate
steps. Repository configuration alone does not complete them.
