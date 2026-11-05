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

## Connect Android

With the live backend working over HTTPS, set `serverUrl=https://app.YOUR_DOMAIN` in `android/gradle.properties` or pass `-PserverUrl=...` when building. Run `npm run android:assets` after web edits. Generate a signed release in Android Studio with your own private release key. Keep that key backed up securely; it is not included. Release builds without a server origin fail.

Run real-device tests for login/logout, location denied/allowed, keyboard resize, Android back, map failure, bookings from two simultaneous devices, offers, cancellation, and session expiry before distribution. Google Play publishing, domain registration and remote deployment are not performed by this delivery.

## Operations

Run one Node process with this local SQLite file. Back up the database using SQLite's online backup mechanism or stop the process for a consistent copy of the database plus WAL. Back up approved photos as well. Protect/encrypt backups and test restoration. Avoid copying a live database file alone. Rotate audit data according to your policy; sessions and rate-limit rows are cleaned every minute. Ship account recovery/verified email, real support/reporting, data export/deletion, complete rental/privacy terms and host verification before a public launch.

OpenStreetMap's public tile service is used for low-volume interactive browsing with visible attribution. It is not an offline tile pack. Choose an appropriate tile provider or your own tile service for sustained production traffic; follow its terms, attribution and caching rules. No Google Maps API key is needed for the included Leaflet map.

References: https://operations.osmfoundation.org/policies/tiles/ and https://developer.android.com/privacy-and-security/risks/unsafe-uri-loading
