# Deploy the live service

This is a Node.js + SQLite service, not a PHP/shared-hosting drop-in. The old `public_html` ZIP cannot be overwritten with this backend. Use a VPS with Node 24 or a host offering a persistent Node process and disk. Do not deploy the SQLite file on ephemeral/serverless storage.

## Local live check

From the project root, unset `GARAGESHARE_DEMO` and run `npm start`. Open http://localhost:3000, register a host account and submit a garage. It will be pending and absent from public search. Use the server terminal:

```bash
npm run admin -- pending
npm run admin -- approve LISTING_ID /absolute/accurate-photo.webp
```

Replace `LISTING_ID` with the actual pending ID. The photo must be an accurate, authorized WebP under 5 MB. Review the owner's right to rent, entrance, size and description; re-encode the photo to strip metadata before approval. The CLI copies it into `web/assets/host-photos` with a random name. Never approve fictional demo art as a real listing.

Open a second browser profile and register a renter to test live booking. Passwords and database are separate from the preview. No outgoing email or payment transaction is triggered.

## VPS example

Install Node 24 and Nginx, upload this project to `/opt/garageshare`, create a dedicated unprivileged `garageshare` OS account, and make only `data` and `web/assets/host-photos` writable by that account. Start from the project root so the admin CLI and server use the same data path. Keep `data` outside the Nginx static root. The server serves only `web`.

Environment for the service:

```text
NODE_ENV=production
APP_ORIGIN=https://app.YOUR_DOMAIN
HOST=127.0.0.1
PORT=3000
DATA_DIR=/opt/garageshare/data
TRUST_PROXY_IP=127.0.0.1
```

Use your real HTTPS origin with no subpath. `GARAGESHARE_DEMO` must be unset or zero in production. `TRUST_PROXY_IP` is optional; set it only to the exact IP of your trusted reverse proxy as seen by Node. Only that peer can supply `X-Real-IP` for rate limits. Other forwarded headers are ignored. Nginx must overwrite `X-Real-IP` and the Node port must remain private. For a container the peer address can differ; determine it before setting this value.

Example systemd service, `/etc/systemd/system/garageshare.service`:

```ini
[Unit]
Description=GarageShare garage marketplace
After=network.target

[Service]
User=garageshare
Group=garageshare
WorkingDirectory=/opt/garageshare
EnvironmentFile=/etc/garageshare.env
ExecStart=/usr/bin/node server/index.mjs
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/opt/garageshare/data /opt/garageshare/web/assets/host-photos
UMask=0077

[Install]
WantedBy=multi-user.target
```

Create `/etc/garageshare.env` with the environment above, restrict it to the service account/root, then enable and start the service. `APP_ORIGIN` is configuration, not a secret; no API key is needed for the included map.

Example Nginx HTTPS block; obtain valid certificates for your real domain before enabling:

```nginx
server {
    listen 443 ssl;
    server_name app.YOUR_DOMAIN;
    ssl_certificate /etc/letsencrypt/live/app.YOUR_DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/app.YOUR_DOMAIN/privkey.pem;
    client_max_body_size 20k;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Connection "";
        proxy_read_timeout 30s;
    }
}
```

Redirect HTTP to the same fixed HTTPS domain and reject unrelated hostnames. Do not serve the project folder as a static directory. The Node process sends HSTS and requires Secure cookies in production.

## Docker option

```bash
docker build -t garageshare .
docker volume create garageshare-data
docker volume create garageshare-photos
docker run -d --name garageshare --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -e APP_ORIGIN=https://app.YOUR_DOMAIN \
  -v garageshare-data:/app/data \
  -v garageshare-photos:/app/web/assets/host-photos \
  garageshare
```

Keep Nginx in front and configure the exact trusted proxy IP only after verifying it in your network. To moderate inside the container, copy an accurate photo to a temporary container path, then run `docker exec garageshare node server/admin.mjs pending` and `docker exec garageshare node server/admin.mjs approve LISTING_ID /tmp/photo.webp`.

## Enable Google sign-in

1. Deploy GarageShare at your HTTPS `APP_ORIGIN` with `NODE_ENV=production`. In Google Auth Platform, set up the GarageShare consent screen and create an OAuth client of type **Web application**. Add the exact authorized redirect URI `https://app.YOUR_DOMAIN/auth/google/callback`. Use your real origin in place of the example. Add your Google account as a test user if your consent screen is in testing. [Google web server OAuth setup](https://developers.google.com/identity/protocols/oauth2/web-server)
2. Add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to `/etc/garageshare.env` or your hosting provider's server environment. Keep both in server configuration and restart the service. GarageShare requests the `openid`, `email` and `profile` scopes. Open **Account → Sign in or create account → Continue with Google** to test. Existing users can sign in with their password and choose **Connect Google** in Account.
3. Serve `/.well-known/assetlinks.json` from the same HTTPS host for Android. Set `ANDROID_APP_SHA256` to the colon-separated SHA-256 signing certificate fingerprint for `ma.garageshare.app`. With Play App Signing, use the app signing certificate. For a server-connected debug build of `ma.garageshare.app.preview`, set `ANDROID_PREVIEW_SHA256` to that build's signing certificate fingerprint. The backend generates the association file. Build Android with the same `serverUrl`. Check that Android verifies the host and opens `/auth/google/android-return` in GarageShare. [Verify Android App Links](https://developer.android.com/training/app-links/verify-applinks)
4. On the phone, choose **Continue with Google**, select the account in the browser, then tap **Return to GarageShare**. The built-in offline preview continues to use its sample account.

Proxy `/auth/google/` and `/.well-known/assetlinks.json` to Node. For `/auth/google/`, turn off proxy access logging or omit query strings to keep OAuth state and codes out of logs. Leave the application session cookie settings intact. The service uses outbound HTTPS to `oauth2.googleapis.com` and `www.googleapis.com`.

## Connect Android

The checked-in `android/gradle.properties` points to `https://garageshare.xyz`. Wait until that domain reaches the VPS with a valid HTTPS certificate before running the connected app. To use a different host, override `-PserverUrl=https://app.YOUR_DOMAIN` when building. For the offline debug preview, pass `-PserverUrl=`. Run `npm run android:assets` after web edits. Generate a signed release in Android Studio with your own private release key. Keep that key backed up securely; it is not included. Release builds without a server origin fail.

Run real-device tests for login/logout, location denied/allowed, keyboard resize, Android back, map failure, bookings from two simultaneous devices, offers, cancellation, and session expiry before distribution. Google Play publishing, domain registration and remote deployment are not performed by this delivery.

## Operations

Run one Node process with this local SQLite file. Back up the database using SQLite's online backup mechanism or stop the process for a consistent copy of the database plus WAL. Back up approved photos as well. Protect/encrypt backups and test restoration. Avoid copying a live database file alone. Sessions and rate-limit rows are cleaned every minute. Set a retention policy for private chat, support conversations, reservations and audit records.

OpenStreetMap's public tile service is used for low-volume interactive browsing with visible attribution. It is not an offline tile pack. Choose an appropriate tile provider or your own tile service for sustained production traffic; follow its terms, attribution and caching rules. No Google Maps API key is needed for the included Leaflet map.

References: https://operations.osmfoundation.org/policies/tiles/ and https://developer.android.com/privacy-and-security/risks/unsafe-uri-loading

## Set up the support dashboard

Create a dedicated account in your live GarageShare installation and confirm that you control the account before granting access. Run these commands on the server from the project directory with the same `DATA_DIR` as the running service.

```bash
npm run admin -- staff-grant YOUR_ACCOUNT_EMAIL admin
npm run admin -- staff-list
```

Sign in again at `/admin.html` on your GarageShare domain. Administrators can assign tickets to any staff member. Use the `support` role for agents who reply, update ticket status and take unassigned tickets. To remove access, run `npm run admin -- staff-revoke ACCOUNT_EMAIL`. Granting or revoking a role ends that account's existing sessions. Listing approval and approved photos continue through the server CLI.

## Prepare a public Android release

1. Deploy the live HTTPS service and verify backups, real listings and the full renter, host and support flows on Android devices.
2. Complete account recovery and email verification, account deletion in the app and on the web, and the operator's privacy and rental policies. Set up staff access and incident handling.
3. Point the release Android build at the live origin, generate a signed Android App Bundle, and add the listing, privacy policy, Data safety answers and reviewer access in Play Console.
4. Run the applicable Play Console tests before requesting production access. Personal developer accounts created after November 13, 2023 need a closed test with at least 12 continuously opted-in testers for 14 days.

[Google Play account deletion](https://support.google.com/googleplay/android-developer/answer/13327111) · [Preparing an app for review](https://support.google.com/googleplay/android-developer/answer/9859455) · [Personal account testing requirements](https://support.google.com/googleplay/android-developer/answer/14151465)
