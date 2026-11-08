# Implemented protections and remaining work

## Accounts and requests

Passwords use salted scrypt (N=32768, r=8, p=1, 64-byte key). Passwords have a 12–128 character limit. Unknown-account login performs dummy hash work. Session IDs are random 256-bit values; only their SHA-256 hashes are stored. Authentication rotates and revokes the previous session. Cookies are HttpOnly, SameSite=Strict, and production uses Secure plus the `__Host-` prefix. Sessions expire after 30 minutes idle or 12 hours absolute. Logging out revokes the server session.

Every mutation checks the configured request Origin and a random session CSRF token using constant-time comparison. There is no permissive CORS. JSON request size is capped at 16 KB. Password work, account attempts, API calls, session creation, listing submission and booking creation have limits. Do not expose the Node listener to the public network; use the documented HTTPS reverse proxy.

Booking and price-request lookups are scoped to the authenticated renter or actual garage owner. Customers can read and reply to their own support tickets. Staff routes check the role stored on the server on every request. Granting and revoking staff roles uses the server CLI and invalidates sessions for that account. Listing moderation stays in the CLI. The UI escapes customer text, and SQL statements bind user inputs as parameters.

Chat checks the two conversation participants on every read, send and read receipt. A quote and the reservation it creates share one conversation. The server enforces participant access independently of staff roles. Sending a message uses the current session identity and the existing origin and CSRF checks. Messages have a size limit, sending is rate limited, and retries with the same request key return the original message. Chat responses omit participant email and private entrance fields. The operator must protect conversation data in the database and backups.

## Reservations

Money is integer centimes; dates, prices and roles are recomputed or validated on the server. A client cannot lower a listed-price booking by changing its submitted total. SQLite `BEGIN IMMEDIATE` serializes reservation writes, and insert/update triggers independently reject overlapping confirmed reservations. A caller-provided idempotency key scoped to its user prevents duplicate submissions from creating another booking. Availability is rechecked on offer acceptance, including hourly/monthly conflicts. Production supports a single Node process against a local persistent SQLite database; use PostgreSQL with equivalent constraints before horizontal scaling.

Public search omits exact addresses and rounds the map coordinates to roughly 400 m precision. This is approximation, not anonymity. Confirmed guests receive exact access information only for upcoming or ongoing stays. Cancellation and the end of the stay remove that information from subsequent guest responses. A recipient can still retain information they have already seen. Host and moderator access is necessary to run the service.

## Android

The live app accepts only a compile-time HTTPS origin and validates both scheme and exact host before navigation. It blocks cleartext traffic, mixed content, file/content access and third-party cookies. SSL errors are cancelled. The app exposes no JavaScript-to-native interface. Safe Browsing is enabled. WebView remote debugging is enabled only in development builds. Android backups are disabled. Optional coarse location permission is requested only after the user taps Near me.

The local preview serves bundled assets on `https://appassets.androidplatform.net` through a restricted asset interceptor. Preview requests cannot create live accounts or reservations. Production has no automatic fallback to sample mode if its backend is unreachable.

## Content and storage

Content Security Policy restricts scripts to the application itself; `unsafe-inline` applies only to CSS for Leaflet positioning. `nosniff`, strict-origin-when-cross-origin referrer policy, frame denial, permission restrictions and production HSTS are sent. The map provider receives the app origin, not the current page path. Secrets, logs, SQLite files and server source are outside the static root. No arbitrary image URL fetches or untrusted SVG uploads are supported. A moderator must provide an authorized WebP photo for each approved listing; re-encode photos to strip metadata before import. A WebP header check is not a full image decoder or malware scanner.

SQLite and photos must be backed up, retained and protected by the operator. Logs do not print passwords/session tokens or full request bodies. Audit rows retain action IDs for 90 days. Map tile requests expose the viewer's IP and viewed map area to OpenStreetMap. Device geolocation is used locally to choose the nearest supported city and is not stored by the API.

## Public launch work

Before public launch, complete verified email and password recovery, ownership review, final operator privacy and rental terms, and account export/deletion. Set staff access and incident procedures, choose support ticket retention periods, protect backups, and test the production configuration on Android devices. Support booking context contains the booking reference, period, price and status. Exact entrances stay in the authorized reservation view.

This MVP deliberately collects no card data, ID documents or banking information. It claims no insurance, identity verification or guarantee that a real space is physically secure.
