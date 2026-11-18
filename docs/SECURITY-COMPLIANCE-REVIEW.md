# Manual security review for the Play compliance work

## Scope and evidence

This is a manual source-and-test review, not a registered Codex Security scan,
penetration test, or Google Play approval. The managed security-scan launch tools
were unavailable in this session. No production URL, account, database, private
conversation or remote host was accessed for this review.

The independent baseline was commit `63606b7c43685fcfc5441014f25d6a98cf3af034`. The review used
`git show 63606b7:<path>` while the implementation team worked in a separate
feature branch. Source reviewed included the HTTP router,
SQLite schema/helpers, Google authentication, booking/quote/availability/chat/
review/support/admin/photo modules, browser rendering and Android WebView setup.
Final compliance additions are discussed separately below.

The source is a Node.js 24 HTTP application with built-in SQLite, a same-origin
browser interface and an Android WebView. Production TLS termination is an
operator-managed reverse proxy. There is no third-party production npm runtime
package list to audit in package.json. Bundled Leaflet, fonts, Android Gradle
build tooling and browser/native platform behavior are separate dependencies.

## Baseline result

No confirmed exploitable authentication, role escalation, SQL injection, stored
XSS, CSRF, booking IDOR or private-chat authorization break was established in
the baseline paths reviewed. This is a bounded negative result, not a claim that
the application has no vulnerabilities.

| Control | Enforcement and counterevidence checked | Baseline source reference |
| --- | --- | --- |
| Passwords and sessions | Salted scrypt; random session tokens stored as hashes; rotation; absolute/idle expiry; logout revocation; hashes absent from safe user responses | core.mjs:13, app.mjs:35, app.mjs:63, app.mjs:74 |
| API mutation authority | Actor derives from server session; exact configured Origin and constant-time CSRF check apply before API POST handlers; no permissive CORS | app.mjs:123, app.mjs:124, app.mjs:156 |
| Administrator authority | Admin role is looked up on the server, including moderation operations; role fields sent during registration cannot grant staff | moderation.mjs:5, admin-operations.mjs:194 |
| SQL input | Variable user values use bound parameters; dynamic table/column names in helpers are fixed server-owned values | core.mjs and server route modules |
| Browser output | User text/attribute values are escaped; image paths are constrained; no JavaScript bridge; same-origin CSP excludes inline script | web/icons.js:35, web/admin-management.js, app.mjs:44 |
| Booking/private arrival | Renter/owner identity is part of SQL predicates; private entrance omitted from public/offer responses and after access expires; server calculates integer prices; transactional overlap checks and SQLite triggers | core.mjs:96, core.mjs:107, app.mjs:215, app.mjs:224, app.mjs:241 |
| Quote and chat privacy | Every conversation context checks actual guest/garage owner and saved thread participants; unrelated users get not-found; quote/reservation linking does not make a public chat endpoint | chat.mjs:getContext/getThread, deals.mjs:guestRequest/respondToRequest |
| Google sign-in | Signature and issuer/audience/azp/nonce/expiry/email claims; PKCE; state/browser cookie; original-session-bound one-time proof; explicit same-account linking | google-auth.mjs:32, :49, :128, :161, :174, :197 |
| Upload bounds | Owner/admin authorization before large body, repeated snapshot checks, canonical base64/RIFF/WebP structure and size limits, random non-overwriting filenames, symlink checks and rollback | listing-photos.mjs, app.mjs:187 |
| Static files | Canonical web-root containment, hidden path and MIME allowlist; versioned assets use same guards; no direct server/database file route | app.mjs:286, web-assets.mjs |
| Android network surface | HTTPS-only configured origin; cleartext and mixed content disabled; SSL errors canceled; third-party cookies disabled; trusted-origin geolocation/file picker; no JavaScript-native bridge | MainActivity.java:37, :99, :101, :106, :121, :144, :173 |

Line numbers above refer to `git show 63606b7:<path>`, not to a later working tree.

## Existing regression evidence inspected

The baseline repository contains meaningful tests for forged proxy headers and
login limits; CSRF/foreign Origin; session rotation/revocation; unauthorized
booking changes; authoritative prices; overlap races and SQLite triggers;
private arrival/entrance access; participant-only chat/support; staff grants;
Google token/proof/account-linking attacks; owner-only photo changes; invalid
image and oversized request rejection; filesystem/database rollback; stale
moderation decisions and admin-only views. These assertions were read during
review. The parent task owns the final executed-suite counts and outcomes; this
review does not relabel unexecuted tests as passed.

## Baseline product/control gaps

The baseline did not provide an end-user block list, UGC reporting, a reported
conversation moderation workflow, versioned community-guideline consent,
self-service account deletion or the requested standalone public privacy/deletion
pages. These are real product/policy gaps to implement and verify. Their absence
is not misrepresented as an exploit in an existing enforcement mechanism.

## Limits requiring operator/device review

- WebP validation checks type/structure/limits; it is not a general-purpose image
  malware scanner or complete server-side pixel decoder. Browser re-encoding is
  helpful but not trusted as the only server validation boundary.
- Bounds and rate limits exist, but this review did not load-test a small VPS or
  establish global capacity under distributed abuse.
- HTTPS settings are supported by source and prior local tests; no production
  TLS, DNS, firewall, reverse-proxy, key custody or backup restoration was tested
  during this review. APP_ORIGIN and the exact trusted proxy peer remain operator
  configuration requirements.
- SQLite files/backups need operator access controls. TLS in transit, scrypt and
  session hashing do not mean every database field is encrypted at rest.
- Uploaded photo requests now check current listing visibility and authorization,
  even when the exact URL is known. Previously downloaded photos or copies held
  outside the service cannot be recalled. The reverse proxy must forward photo
  requests to the application rather than serving the upload directory directly.
- The Android source restricts WebView navigation and picker origin, but this
  review did not run a physical device, test OS grant lifetimes or certify every
  Android System WebView version.
- The review did not audit third-party Leaflet internals, Google infrastructure,
  OS/browser implementations, build tooling supply chains or organization-wide
  operational controls.

## New compliance additions

The following new boundaries were reviewed in the feature working tree on
2026-11-18. This section describes the implementation reviewed, not the
production deployment.

| Boundary | Evidence checked |
| --- | --- |
| Blocks and guideline consent | `user-safety.mjs` derives the actor from the session, rejects actor overrides, restricts profile/target lookup to visible peers, stores separate directional block records, enforces a symmetric interaction check, and records explicit acceptance of the current guideline version. |
| New interactions | The HTTP booking/offer handlers and quote/chat modules check the actual renter and selected garage owner. Reads, cancellation, existing confirmed bookings and necessary arrival information are preserved. The check does not accidentally use an unrelated competing garage owner. |
| Reports | `ugc-moderation.mjs` checks report-target visibility on the server, prohibits self-reporting, uses bounded message context from only the authorized thread, enforces a per-user rate limit, makes retries/active duplicates idempotent, and returns no reporter identity or evidence to an ordinary reporter. |
| Moderator access | Every report operation checks current account state and current administrator role. Support-only and ordinary users cannot read the queue or private evidence. Evidence reads and decisions are audited; stale decisions fail. User notices do not include reporter identity or internal review notes. |
| Removal and restoration | Message history, incremental polling, inbox previews, public/participant reviews and rating aggregates apply content tombstones. Reposting a removed review cannot bypass its existing record. Restoration is bound to the current removal case; a restored garage returns to pending review. |
| Account lifecycle | `account-lifecycle.mjs` accepts only self-service fields, requires explicit `DELETE` and password reauthentication or a fresh linked Google session, and rechecks session/credentials/blockers after asynchronous password work in the commit transaction. Active bookings and the last active administrator prevent deletion. |
| Suspension | Suspension revokes old sessions and archives listings. A fresh login yields a restricted session for its own notices, support and deletion. The ordinary app APIs remain denied. Deleted accounts cannot use the old session or credentials. |
| Deletion minimization | Credentials, sessions and Google links are removed; direct profile/listing identifiers and authored message/review/support text are scrubbed. Other participants' transactions remain pseudonymous history. Attributed photo files are queued and removed only when no listing or unresolved evidence holds them; canonical paths/symlinks are checked. |
| Uploaded photo retrieval | `photo-access.mjs` makes only current approved, active-owner, non-tombstoned listing photos public. An active owner can view their own current unmoderated photo; current active administrators can inspect listing/report evidence with an audit event. Replaced/orphan files require retained authorized evidence and cannot be retrieved by guessing a URL. The static handler resolves decoded/versioned aliases before authorization, rejects symlinks, checks access before and after asynchronous I/O, and returns `no-store` with `Vary: Cookie`. |
| Migrations and maintenance | Additive SQLite migrations are ordered, transactional and checksum-tracked. The server minute maintenance task calls report-evidence expiry and queued-photo cleanup. These local jobs do not establish production backup expiry or legal retention policy. |
| Public policy output | Public routes are readable without authentication and expose only allowlisted legal metadata. Operator identity/contact/retention values remain explicitly subject to operator review. New safety/admin report templates escape user-authored text and constrain photo URLs. |

Review issues corrected before delivery included a missing post-body authority
check during an unfinished authenticated request, restricted-session access to
own deletion after suspension, the wrong peer lookup in quote selection, and a
removed review being offered for reposting despite its existing primary key.
The last two were correctness/regression issues rather than demonstrated
authorization bypasses. The baseline negative result above is not changed into
a claim that these newly implemented paths existed in the baseline.

Review also identified free-text moderation notes duplicated outside the report
row. Evidence expiry now clears the matching old `content_moderation.note` and
`user_account_state.reason` copies while preserving the structured restriction
and a newer case/account decision. The additional regression checks verify both
erasure and protection of newer decisions. These technical limits still require
operator review; they are not a statement of legally required retention.

The final focused photo review verified that private/removed upload URLs no
longer bypass listing moderation. Owner access to an ordinary rejected/archived
current photo remains available for account management; a moderation tombstone
or inactive owner blocks that exception. Private retrieval neither creates a
session nor inherits support-staff access.

Independent executed checks for this review:

- `node --test test/user-safety.test.mjs test/ugc-moderation.test.mjs test/account-lifecycle.test.mjs test/public-policies.test.mjs`: **32 passed, 0 failed**.
- `node --test test/compliance-integration.test.mjs`: **4 passed, 0 failed**.
- After the note-expiry fix and report-revision additions, `node --test test/ugc-moderation.test.mjs test/compliance-integration.test.mjs`: **18 passed, 0 failed**. These are repeat checks of affected paths, not 18 additional distinct test groups to add to the earlier totals.
- `node --test test/photo-access.test.mjs`: **6 passed, 0 failed**, covering public/current visibility, private owner/admin scope, tombstones and retained evidence, replacement/queued files, live session/role/account state, encoded/versioned aliases and symlink rejection.

The four additional tests run through the real local HTTP router with isolated
in-memory databases. They verify suspended re-login and restricted access,
active-booking deletion blockers and secure deletion after cancellation,
symmetric blocks across direct booking/offer/chat/quote routes with an unaffected
competing host and retained confirmed history, Google-only deletion requiring
fresh provider sign-in, and session revocation while an authenticated request
body is incomplete. The Google provider is a local signed-token fixture; no
real Google account or external provider request is used. The parent task owns
the final complete-suite count and browser/device evidence.

No unresolved authentication, role escalation, injection, CSRF, upload traversal,
booking IDOR or private-chat access vulnerability was established in the reviewed
new paths. The operational/device limits above still apply. Transaction-history
retention, backups, monitored moderator coverage and legal identity/contact must
be set and reviewed by the operator before Play publication. Neither a manual
review nor a passing test suite establishes Google Play approval.
