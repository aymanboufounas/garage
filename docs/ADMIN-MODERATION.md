# Review garages from your administrator account

Open `https://garageshare.xyz/admin.html` after deploying this update. An account
with the `admin` role sees Garage moderation above the existing support dashboard.
The account menu in the website/Android app also links to the staff dashboard.
Ordinary accounts and `support` staff cannot view or change listing moderation.

## Deploy this update to the existing VPS

Back up the database and approved photos first (see DEPLOYMENT.md). Preserve any
local repository changes before pulling. No database migration or npm install is
needed for this change. On the VPS:

```bash
cd /opt/garageshare
git pull --ff-only
npm test
# Continue only if tests pass:
systemctl restart garageshare
systemctl status garageshare --no-pager
```

After startup, check `curl -fsS https://garageshare.xyz/api/config` returns the live
configuration. A normal website refresh loads this dashboard update; rebuilding
the Android app is not required for a connected WebView installation.

## Allow bounded admin photo uploads through Nginx

The previous Nginx setup limited all bodies to 20 KB. Add this location block
**inside the existing HTTPS server block for garageshare.xyz** in
`/etc/nginx/sites-available/garageshare`, alongside `location /`. Preserve the
Certbot certificate directives, HTTP redirect and other existing settings:

```nginx
location /api/staff/garages/ {
    client_max_body_size 8m;
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header Connection "";
    proxy_read_timeout 30s;
}
```

Then run:

```bash
nginx -t && systemctl reload nginx
```

The backend still limits ordinary JSON requests to 16 KB. Only an authenticated
administrator's approval endpoint can accept the larger body (up to 7 MB JSON,
containing at most 5 MB of WebP data). Unauthenticated and non-admin requests
are denied before reading a large body. Do not raise the global limit to fix an
upload failure. HTTP 413 means check this location block and any additional proxy
limits; do not disable size checks.

## Give your existing account administrator access once

If your account already has the `admin` role, skip this step. Otherwise replace
YOUR_ACCOUNT_EMAIL with the email of an existing account you control:

```bash
cd /opt/garageshare
runuser -u garageshare -- env DATA_DIR=/opt/garageshare/data \
  node server/admin.mjs staff-grant YOUR_ACCOUNT_EMAIL admin
```

This server-only bootstrap prevents anyone from registering themselves as an
administrator. It ends that account's sessions. Sign in again after granting the
role. No password or privileged default account is added to the repository.
Future garage review/approval is done from the dashboard without terminal commands.

## Review and publish

1. Sign in at `/admin.html`. Select Pending in Garage moderation and click Refresh.
2. Review the owner's name/email, private entrance address and coordinates,
   description, vehicle fit, cover, height and prices. Private entrance details
   in this section are available only to administrators.
3. Choose an accurate authorized JPEG, PNG or WebP photo (up to 10 MB). The browser
   shows the selected photo and converts it to a still WebP up to 1920 pixels,
   stripping metadata. The server stores it under a random filename.
4. Check the review confirmation and click Approve and publish. The listing
   moves out of Pending and appears in public Explore. Approval uses the existing
   pending status; a stale/repeated decision is rejected rather than silently
   overwriting another moderator's decision.
5. To decline a pending listing, click Reject listing and confirm. To remove an
   approved listing, select Approved, click Archive listing and confirm. Upcoming
   confirmed bookings must be resolved before archiving. Decisions are audited.
6. Queue pages contain up to 25 listings. Use Previous/Next to review more.

Test with a second renter account: the approved listing should be discoverable
and bookable. Support ticket tools remain available below moderation. Language
selection supports English, French and Arabic (RTL).

## Verification for developers

`npm test` includes authorization, CSRF/origin enforcement, valid/invalid photo
uploads, stale decisions, pagination, filesystem failure recovery and upcoming
booking protection. For the optional browser workflow (outside-checkout tools):

```bash
npm --cache /tmp/garage-npm-cache install --prefix ../garage-qa-tools --no-package-lock playwright
NODE_PATH=../garage-qa-tools/node_modules BROWSER_EXECUTABLE=/usr/bin/chromium node scripts/check-moderation.mjs
```

Use your installed Chromium path; alternatively install Playwright's browser
and omit BROWSER_EXECUTABLE. This creates an isolated temporary website and an
in-memory database, checks admin sign-in, escaping, photo preview and upload,
approval, archiving and Arabic mobile layout, then cleans up the temporary state.
A screenshot is saved in ignored `test-results/admin-moderation.png`.
