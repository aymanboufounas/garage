# Hosts provide garage photos

## Host workflow

On the website or connected Android app, open Host → Add a garage, enter the
listing details and entrance pin, choose a JPEG, PNG or WebP photo (up to 10 MB),
and confirm that it accurately shows the garage and is authorized. Preview it,
then submit for review. The browser converts it to a still WebP up to 1920
pixels and 5 MB, stripping metadata. The server stores it at a random filename
and creates the listing with pending status atomically. A failed upload retains
the host's fields and selected file so they can correct the issue or retry.

For an existing listing, open Host → My garages → Add garage photo or Change
photo. The action is available only to the owner. Adding/replacing a photo sends
the listing back to pending review. An approved garage with ongoing/upcoming
confirmed bookings cannot change photos until those reservations are resolved.
Other users cannot change the image by altering the listing ID.

The preview mode stores a reduced-size WebP on that device, clearly labeled as
a simulation. It does not upload to the live database. If local storage fills,
the form remains available and no partial in-memory listing is kept.

## Administrator workflow

Sign in at `/admin.html` → Garages. Select the pending listing and review its
host-submitted photo and details. There is no photo chooser in the approval
form. Confirm review and click Approve and publish. A missing/broken photo
blocks approval; ask the host to submit one. Reject remains available.

Approval checks the exact image shown to the reviewer. If the host changes the
photo before approval, refresh and inspect the replacement before confirming.
The stored host image is retained when approved. Older pending listings without
photos remain drafts and cannot be published until the host adds a photo.
The older explicit-photo server CLI/API remains compatible for operator tooling;
the normal website/app workflow is host upload followed by admin review.

## Deploy to the existing VPS

Preserve local changes and take a consistent database/photo backup first (see
DEPLOYMENT.md). No manual schema migration or new production npm dependency is
needed. On the VPS:

```bash
cd /opt/garageshare
git pull --ff-only origin main
npm test
# Continue only if tests pass:
systemctl restart garageshare
python3 scripts/configure-admin-nginx.py
```

The helper now adds both bounded upload locations: `/api/host/garages` for host
creation/replacement, and `/api/staff/garages/` for legacy moderation tooling.
It preserves an already-correct admin location while adding the host location,
keeps Certbot HTTPS/redirect settings, and is safe to repeat when both are
configured. It backs up, validates `nginx -t`, and reloads; it refuses ambiguous
or conflicting existing locations rather than overwriting them. Add `--check`
to inspect the proposed site first. Nginx allows 8 MB on these paths; backend
photo requests are capped at 7 MB JSON with at most 5 MB decoded WebP. Other
JSON endpoints keep their existing smaller limit and all uploads require auth.

Refresh the website after restarting. Public and admin module entry points now
share the deployment's asset revision so new photo translations load together.

## Update Android

The Android WebView now handles file selection with the system document picker.
No broad photo-library or storage permission is added. The host explicitly
chooses one image; canceling the picker or leaving the trusted app origin ends
the request without a file. This native change requires a new Android build:

1. Update/download this GitHub project and open `android` in Android Studio.
2. Keep `serverUrl=https://garageshare.xyz` in gradle.properties and sync Gradle.
3. Connect the phone and click Run to install the updated debug app.
4. In Host → Add a garage, tap the photo field, select a real garage image and
   test submission, preview, cancellation and returning to the app.

The source version is now Android 0.7.1 / versionCode 9. The existing APK in dist/
is unchanged. For Google Play, generate a new signed AAB and use a versionCode
higher than any previously uploaded value. This change does not produce a signed
release or validate the picker on your physical phone automatically.

## Verification

`npm test` covers photo create/update ownership, session/CSRF checks, bounds,
invalid images, stale decisions, booking protection, storage/database rollback,
and approval retaining the reviewed image. Optional Playwright checks:

```bash
NODE_PATH=../garage-qa-tools/node_modules BROWSER_EXECUTABLE=/usr/bin/chromium node scripts/check-host-photo.mjs
NODE_PATH=../garage-qa-tools/node_modules BROWSER_EXECUTABLE=/usr/bin/chromium node scripts/check-moderation.mjs
```

Use your installed Chromium path or Playwright's installed browser. These checks
use isolated temporary web files and in-memory databases. They do not upload
test images to the production site. Android document-picker behavior still
needs a device/emulator check after installing the new build.
