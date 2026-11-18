# Google Play Data safety review — GarageShare

Review baseline: source `63606b7c43685fcfc5441014f25d6a98cf3af034`, plus the
`feature/play-compliance` implementation. This is an evidence checklist, not an
automatically submitted Play declaration or guarantee of approval. The new
controls must be deployed with the owner's approval and tested on the actual
release before declaring that the live app has them.

## Sources inspected

- `package.json`: Node 24; no production npm dependency tree.
- `server/schema.sql` and new additive `server/migrations/`: account IDs, hashes,
  sessions, Google identity links, garages, bookings/offers, messages, support,
  reviews, rate limits/audit, blocks, consent, reports and account safety state.
- `server/app.mjs`, `core.mjs`, `google-auth.mjs`, `chat.mjs`, `support.mjs`,
  `reviews.mjs`, `listing-photos.mjs`, `photo-access.mjs`, `user-safety.mjs`, `ugc-moderation.mjs`,
  `account-lifecycle.mjs`: actual collection/access/retention paths.
- `web/app.js`, `data.js`, `arrival-ui.js`, `photo-upload.js`: first-party API,
  optional device position, OpenStreetMap tiles, Google Maps handoff and storage.
- `android/app/build.gradle`, manifest and `MainActivity.java`: Android platform
  WebView, INTERNET and ACCESS_COARSE_LOCATION only; no advertising or analytics
  runtime dependency and no background/fine-location, contacts or broad storage
  permission. Gradle/AGP/R8 are build tools, not embedded analytics SDKs.

## Collection and processing inventory

“Collected” below means transmitted to the operator/backend or an external
recipient. Purely on-device processing is distinguished. The exact Play form
category and any exemption must be checked against the current Console guidance.
A user choosing to submit data does not mean the data is not collected.

| Data / possible Play category | Actual implementation and purpose | Required / optional; persistence | External visibility / review |
| --- | --- | --- | --- |
| Name, email / Personal info | Account registration/login; Google sign-in may provide verified email/name. User ID links bookings and content. | Required to create an account; name/email/ID persist until deletion/anonymization. Browsing does not require account creation. | Public host display names and stable owner IDs are visible on listings/profiles. Email is not public. Hosting processors require operator review. |
| Password/authentication | Plain password is sent over the first-party HTTPS login/register request; only salted scrypt hash persists. Session cookie is random, hashed server-side. | Required for password accounts; Google-only account differs. Session expiry and deletion revoke credentials. | No third-party password recipient in source. Do not claim passwords are never transmitted or that hashing is encryption in transit. |
| User IDs / Personal info | Random account ID, optional Google subject ID, role/safety status, consent version/time and account tombstone. | Persistent for account operation; Google link optional. A pseudonymous tombstone/history may remain after deletion. | Stable public owner/peer IDs enable profiles/blocking/reporting; no email exposed in those public views. |
| Address and precise property coordinates / Address or Location review | Host-entered entrance address and exact garage pin are saved; public pin rounded to about 400m; exact entrance available to confirmed renter before/during stay. | Required for hosting; not required for a renter who only browses. Not ephemeral. | Owner/renter and authorized review staff; approximate public map. Do not declare “no precise location data” merely because Android has no FINE_LOCATION permission. Determine current form categorization for property location. |
| Device location / Approximate location | Tapping Near me requests browser location with enableHighAccuracy:false; native Android asks only COARSE_LOCATION. Coordinates used in memory to choose nearest city and sort. API saves no device-position record. | Optional. On-device temporary processing; city/filter requests still reach backend. Browser permissions can yield more accurate coordinates. | Map tile requests disclose viewed area and IP. Do not assume the local-position treatment exempts all location-related traffic. No background location. |
| Photos / Photos and videos | Host selects JPEG/PNG/WebP. Client re-encodes bounded WebP/removes metadata; server validates container/size and stores photo. | Required for publishing a garage, optional for other account use. Persistent until removal and applicable evidence/cleanup handling. | Public only when the photo is current on an approved listing, its owner is active and the listing has no moderation-removal marker. An active owner can privately view their own current non-removed photo, including pending/rejected/ordinary archived listings. Active admins can privately review current listing photos or retained reported-photo snapshots, with audit. Other pending/replaced/archived/removed-file access is denied. Uploaded-photo responses now use no-store; previously cached or downloaded copies cannot be revoked. No server image-classifier SDK. |
| Other user-generated content / App activity | Listing details, descriptions, reviews/comments/ratings, block settings, guideline acceptance and reports/explanations. | Feature-dependent; persistent. Report content may be held as moderation evidence. | Listings/reviews can be public; report identity and evidence restricted. Reported users receive no reporter identity. |
| Messages / Other in-app messages | Participant chat, support tickets/replies, reported-message evidence and bounded context. | Optional feature use; messages persist. Deleted/removed content is scrubbed/redacted according to implemented lifecycle. | Participants; support roles for support tickets; admins may review reported chat only through authorized audited report context. No end-to-end-encryption claim. |
| Booking history and monetary amounts / Purchase history or app activity review | Dates, agreed MAD amount, offers, status, cancellation decision. | Required for booking/hosting workflow; linked records persist/pseudonymize to protect counterparts. | Participants/operators. Even without card processing, assess the form's purchase-history category; do not automatically answer “no financial data” for all booking information. |
| Card/bank/payment credentials | No payment processor, card form, bank/account number or payment-token API in current source. Pay on arrival. | Not collected by the application. | Separate physical payment between parties is outside the current app's collection. Reassess before adding a payment provider. |
| IP address and user-agent / Device or other IDs review | Network/server necessarily sees source IP; app uses a hashed rate-limit key. WebView appends GarageShare version to ordinary user-agent. Proxy/hosting may log raw IP/URLs/UA. | Transmission necessary for service; app rate-limit rows temporary. Actual access-log retention is operator-controlled and must be inspected. | OpenStreetMap and operator infrastructure see network information. No advertising-ID API or unique-device fingerprint in source; session/account IDs remain real identifiers. |
| Search/filter input / App activity review | City, availability dates and garage searches sent to API as needed. No dedicated server search-history table. Some text search is local. | Feature-dependent; request processing is temporary in application logic. Hosting logs may retain request URLs. | Confirm actual Nginx/VPS logging and any CDN before deciding ephemeral treatment. |
| Diagnostics and analytics | No third-party analytics, advertising or crash-reporting SDK configured. Application server logs generic error codes, not full private request bodies. | No app analytics collection claim. Operator logs and Android/System WebView services are separate review points. | Inspect production infrastructure and device network behavior; source absence is not proof that infrastructure has no diagnostics. |
| Local settings and demo data | localStorage keeps language, favorites and sample/demo activity; first-party session cookie authenticates live user. | On-device until clear/reset; no claim that clearing local data deletes the live account. | No cross-site tracking cookie or third-party cookie support in the WebView. |

The integrated Node service checks report-evidence cleanup every minute. Closed
cases expire 90 days after their last update; every case reaches a maximum of
180 days from creation, even if unresolved. Stored report evidence, explanations
and review-note text are cleared, while limited case references/status and removal
markers remain. Original messages and booking records have separate lifecycle
rules. Ordinary audit events are trimmed after 90 days. These are implementation
defaults, not approved legal periods or proof that production is running them.
The public retention environment fields only declare periods; they do not change
these jobs or expire backups. Human moderation must be staffed; no automatic
multilingual spam, harassment, threat, scam or image classifier is implemented.

## External services

| Recipient | Trigger / data | Declaration decision |
| --- | --- | --- |
| OpenStreetMap public tile service (`tile.openstreetmap.org`) | HTTPS tile requests on map display: requested tile coordinates/area, network IP, site origin under referrer policy. | External transfer exists. Assess Location and Device/other ID categories under the current Play definitions; do not silently mark all sharing “No.” Public tiles are for low-volume interactive use; production capacity/terms must be reviewed. |
| Google identity endpoints (`oauth2.googleapis.com`, `www.googleapis.com`) | Only when operator configures Google OAuth: code exchange, token validation/keys, verified identity claims. | Optional authentication transfer. Review current authentication/service-provider exceptions rather than assuming none applies or all apply. |
| Google Maps (`www.google.com/maps/dir/…`) | User taps directions; destination entrance coordinates go to separate app/site. Starting position is controlled by that service. | User-initiated transfer; current Play sharing exception may apply when reasonably expected. Still explain the handoff in privacy text. |
| VPS/reverse proxy/backup provider | Hosts database, uploads and operational logs. Provider identities/contracts not proven by source. | A service-provider exclusion depends on actual arrangements. Operator must identify providers, access and retention. |
| Android/System WebView/Google Play platform services | System document picker, permission handling, Safe Browsing enabled, Play distribution. | No added analytics SDK; verify platform disclosures and actual release behavior. Do not infer all platform traffic is controlled by app source. |

## Form checklist before submission

- [ ] Select the data types actually transmitted/persisted above. Mark linked
  account/user IDs and personal information truthfully; do not select “collects
  no data.” Treat host photos and messaging as feature-optional collection.
- [ ] For each type, select actual purposes: app functionality/account management,
  fraud prevention/security/moderation, and user-requested communication. No
  advertising or personalization purpose is implemented in the inspected source.
- [ ] Decide required/optional per feature and distinguish true on-device use
  from backend transmission. “Ephemeral” is not appropriate for stored accounts,
  photos, messages, reports, bookings or URLs retained in access logs.
- [ ] Review third-party sharing definitions/exceptions using the current Console
  and real hosting contracts. Public user-initiated sharing and processors are
  conditional exceptions, not a blanket “no sharing” conclusion.
- [ ] Confirm every release/backend URL uses valid HTTPS and that the production
  environment sets NODE_ENV=production and the correct APP_ORIGIN. Source has
  secure-cookie/HTTPS guards; deployed transport must still be tested.
- [ ] Route uploaded-photo requests through the application's authorization
  handler; a direct Nginx/static/CDN alias must not bypass it. Verify public,
  owner, admin-evidence and removed-photo access and no-store responses in the
  deployed release. Existing cached/downloaded copies cannot be recalled.
- [ ] Do not claim end-to-end encryption: the server and authorized reported-case
  reviewers can read chat content. Do not claim encryption at rest from source.
- [ ] Publish the reviewed `/privacy-policy` and `/delete-account` pages with real
  operator identity, contact and retention details, then test them without login.
- [ ] Test owner-verified in-app/web deletion, active-booking handling and Google-only
  reauthentication, backup expiry/reapply-deletion process, and physical file cleanup.
- [ ] Verify ordinary-user block/report controls and the authorized moderation
  workflow in the deployed release before retaining those “Yes” declarations.
- [ ] Complete reviewer access using dedicated test accounts in Play Console;
  do not share real users' private messages or credentials as review fixtures.
- [ ] Re-run the inventory after adding analytics, payment, email or other SDKs,
  proxy/CDN services or changing log/retention configuration.

Official references to check during operator review:
[Data safety](https://support.google.com/googleplay/android-developer/answer/10787469),
[account deletion](https://support.google.com/googleplay/android-developer/answer/13327111),
[UGC policy](https://support.google.com/googleplay/android-developer/answer/9876937).
These links are review references; this document does not assert that their
current text or an individual Play Console approval was verified remotely.
