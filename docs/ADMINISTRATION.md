# GarageShare administration

Sign in at `https://garageshare.xyz/admin.html` with an existing account granted
the `admin` role. There is no default administrator password. Support staff see
only support tools; every management API checks the administrator role on the
server. Use the sidebar on desktop or the navigation strip on a phone.

## Overview

Overview reads the live database and shows registered accounts, garages,
reservations, pending reviews and unresolved support tickets. Cards open the
relevant management section. Refresh reloads the figures.

The four percentages are all-time **current status shares**, not growth rates:

- Approved listings / all listings (including rejected and archived).
- Confirmed reservations / all reservations (including offers and cancellations).
- Cancelled reservations / all reservations.
- Resolved tickets / all support tickets.

Each percentage displays its numerator and denominator. Empty categories show
0% and 0 of 0. Confirmed booking value sums the agreed totals of reservations
currently marked confirmed; it includes completed stays that retain that status.
This is pay-on-arrival value owed to hosts, not money collected by GarageShare.
This update does not add payment collection or a commission percentage.
Recent activity lists the latest recorded actions and their operator/date.

## Garages

Select a status and a garage in the compact queue; its details appear alongside.
The search box filters the current page and is labeled accordingly. Pages hold
up to 25 listings. Review the owner, private entrance, description, dimensions,
prices and photo before approving. A photo must accurately show the garage and
be authorized. JPEG, PNG and WebP inputs are converted to bounded, metadata-free
WebP. Upload failures retain the selected file and review form.

Use Add garage to create a listing for an existing account. Find the owner by
email/name, select the account, fill the fields and save. New listings always
start pending. Edit updates the selected garage and returns it to pending for a
fresh review. Editing is blocked while a confirmed booking is upcoming/ongoing.
Garage ownership cannot change once any reservation history exists.

Reject declines a pending listing. Archive removes an approved listing from
public discovery; it retains booking history, and requires resolving upcoming
or ongoing confirmed reservations first. These decisions need confirmation.
See [moderation setup](ADMIN-MODERATION.md) for upload limits and initial access.

## Accounts

Search by name/email and page through accounts. Add account creates a normal
customer with a 12–128 character password; it does not create a staff account by
default. Share credentials securely with the intended owner, never in public.
Edit changes name/email, checks the original record to prevent stale overwrites,
and revokes that account's sessions. Editing your own identity requires signing
in again; the UI provides a sign-in link.

Change a role between Customer, Support and Administrator after confirmation.
Role changes end the target's sessions. You cannot demote yourself or leave the
system without an administrator. Only administrators can use these controls.
Remove deletes an unused account after confirmation. It refuses self-deletion,
last-admin deletion, and removal of accounts with rental, support or operator
decision history. It does not silently erase associated bookings or messages.

## Reservations

Filter by status or search garage/customer/reference. Inspect dates, amount,
customer and host. Cancel an upcoming reservation or offer with a required
5–300 character reason and confirmation. Cancellation is refused once a stay
starts and when another operation has changed the booking. The decision retains
the reservation and saves operator, reason and time. Cancelled rows expose the
recorded reason. History is preserved instead of deleting booking records.

## Support

Support keeps the existing ticket filters, counts, conversation, replies,
assignment and resolution controls. Administrators can reassign; support staff
have the existing restricted assignment permissions. Customers cannot enter
staff tools through a role field in registration or a URL.

## Deploy the GitHub update to the existing VPS

Back up SQLite consistently and back up approved photos first, as described in
DEPLOYMENT.md. Preserve any local changes before pulling. On the VPS:

```bash
cd /opt/garageshare
git pull --ff-only
npm test
# Continue only after tests pass:
systemctl restart garageshare
systemctl status garageshare --no-pager
# Once the startup log says ready:
curl -fsS https://garageshare.xyz/api/config
```

Startup creates the additional administrator cancellation-decision table
idempotently. Existing accounts, listings and reservations are retained. There
are no new production npm dependencies and no Android rebuild is needed for the
connected app. Refresh the admin page; JS/CSS now require cache revalidation.

If Nginx still rejects photo uploads with HTTP 413 and you have not added the
admin upload location, run this helper on the VPS:

```bash
python3 scripts/configure-admin-nginx.py --check
python3 scripts/configure-admin-nginx.py
```

The first command prints the proposed site. The second backs up the existing
site, inserts an 8 MB limit only for `/api/staff/garages/`, checks `nginx -t`, and
reloads Nginx. It preserves Certbot HTTPS/redirect directives and restores the
backup on validation failure. It refuses ambiguous configurations, a wrong
hostname or an already-existing upload location rather than replacing them. If
the location already exists, review it using ADMIN-MODERATION.md instead. The
backend still enforces its own admin-only photo and request size limits.

Initial role assignment remains a one-time server operation. See
ADMIN-MODERATION.md; no account may grant itself privileges from sign-up.

## Verification

`npm test` exercises both existing workflows and the new administrator APIs:
role/CSRF/origin checks, account CRUD and role restrictions, stale updates,
percentage calculations, listing protections and cancellation audit notes.
Optional browser QA uses Playwright installed outside the checkout:

```bash
npm --cache /tmp/garage-npm-cache install --prefix ../garage-qa-tools --no-package-lock playwright
NODE_PATH=../garage-qa-tools/node_modules BROWSER_EXECUTABLE=/usr/bin/chromium node scripts/check-admin.mjs
NODE_PATH=../garage-qa-tools/node_modules BROWSER_EXECUTABLE=/usr/bin/chromium node scripts/check-moderation.mjs
```

Use your installed Chromium path, or install Playwright's Chromium and omit
BROWSER_EXECUTABLE. These checks use temporary websites and in-memory databases,
not the deployed server. They cover navigation, overview, account paging and
mutations, cancellation notes, simulated Nginx upload rejection, approval,
escaping, mobile layout and Arabic RTL. Screenshots are in ignored test-results/.
