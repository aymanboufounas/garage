# Google Play compliance implementation review

Source baseline: `63606b7c43685fcfc5441014f25d6a98cf3af034`.
Changes are prepared on `feature/play-compliance`, with no production deployment.

## Inspection and plan

The existing stack is Node.js 24, built-in SQLite, parameterized API modules,
vanilla JS frontend with English/French/Arabic, and a restricted native Android
WebView. Existing features include sessions/Google OAuth, bookings and offers,
participant-only chat, reviews, support tickets, host-owned photo uploads and
administrator listing/account/reservation tools. Calendar blocks are time blocks,
not user blocking. Support tickets are not a complete UGC reporting system.

Missing baseline controls: user block lists, target-specific reports, legitimate
moderation access to reported conversations, community-guideline acceptance,
account deletion and a public deletion page, and a standalone public privacy policy.

Implementation plan:

1. Add versioned additive migrations for account lifecycle, safety controls and
   reports; preserve existing tables, records, positional insert contracts and bookings.
2. Enforce blocking, active account status and guidelines consent on the server;
   expose ordinary-user controls in profiles, conversations and account settings.
3. Add private UGC reports, deduplication/rate limits, administrator evidence review
   and audited moderation actions; preserve transactional information.
4. Add owner-verified account deletion with active-booking guards and data scrubbing,
   and public policy/guideline/deletion pages with operator details pending review.
5. Test the required scenarios and existing workflows, document Data safety and
   operational/legal limitations, and prepare a reviewable branch without deploying.

## Delivered behavior

| Area | Verified implementation | Practical limit |
| --- | --- | --- |
| Blocking | Profile/conversation controls, account blocked list, block/unblock APIs and symmetric server checks for messages, new bookings and quote/offer acceptance | Existing confirmed stays, cancellation and necessary arrival information remain available. A block is not a cancellation. |
| Reports | Ordinary users can report visible users, listings, messages and reviews; six reasons, optional explanation, confirmation, idempotent retries, active duplicate suppression and rate limits | Self-reports and private/unrelated targets are rejected. Reports do not automatically remove content. |
| Conversation moderation | Administrator Reports tab with pending/under-review/resolved/dismissed queues, search/pagination, bounded evidence and audited access/decisions; remove/restore content, warn, suspend/restore or dismiss | Human review only. No proactive spam/scam/threat/harassment classifier, language model, image classifier or guaranteed response time. |
| Privacy of evidence | Reported message plus up to three preceding and three following messages in the same authorized thread (at most seven total); admins only; ordinary/support-role users denied | Authorized investigators can read reported plaintext; no end-to-end encryption claim. Evidence storage/backups need operator controls. |
| Removal | Removed messages are redacted in history, inbox, retries and an already-open chat's incremental polling; removed reviews disappear from public output/ratings; unsafe garages archive without erasing bookings; uploaded photo retrieval checks publication/current ownership/moderation state | Restoration uses the current removal case; restored garages return to pending review. Uploaded-photo responses use no-store; previously cached or downloaded copies cannot be recalled. |
| UGC rules | Public EN/FR/AR Community Guidelines, explicit unchecked consent and versioned server acceptance before new listing/photo/chat/review content | Existing records are preserved. Legacy hosts need acceptance before a new approval. Guidelines do not automatically classify content. |
| Account lifecycle | Owner-derived deletion target, explicit confirmation, password reauthentication or fresh linked Google sign-in, revoked-session/concurrent-change protection; active renter/host booking and last-admin guards | Blocked deletion requires resolving bookings then confirming again; no unattended future deletion is scheduled. |
| Data minimization | Scrubbed account identity/credentials and authored personal content, session/Google-link removal, archived/scrubbed listings; retryable safe cleanup of attributable photos | Transaction/counterpart history is pseudonymized, not irreversibly anonymous. Open-case evidence and backups have separate handling. Pre-ledger orphan photos require an inventory. |
| Public policies | Unauthenticated `/privacy-policy`, `/delete-account`, `/community-guidelines`; allowlisted public metadata and in-app links, EN/FR/AR and RTL | Operator identity/contact and retention decisions are missing; review banner remains. Public HTTPS can be verified only after approved deployment. |
| Security | Live role/state checks, target visibility checks, CSRF/origin enforcement, parameterized SQL, escaped output, bounded uploads, report limits and additive migrations | Bounded source/test review, not a formal managed security scan or production penetration test. |

Suspension ends existing sessions and hides listings. Fresh owner sign-in provides
restricted access to that account's notices, support and deletion; it does not
restore marketplace or administrator privileges. Deleted accounts cannot log in
or be revived by an administrative identity edit. A later new registration has
a distinct identity and cannot read retained records of the deleted account.

No production data was accessed, logged or modified. Existing bookings, prices,
participant checks, authentication and design were extended using the current
stack. No new production npm package or Android permission was introduced.

Uploaded host photos are public only when current on an approved, unremoved
listing with an active owner. Other retrieval requires the active owner of the
current nonremoved listing, or an active administrator with an audited current
listing/evidence reference. Ordinary users, support-role staff and the owner
cannot retrieve a moderator-removed photo. Session expiry/revocation and current
roles/state are checked before file work and again before bytes are returned;
encoded/versioned URL aliases use the same policy. A file needed as evidence is
retained privately rather than made public or erased prematurely.

## Database migrations and preservation

`server/core.mjs` retains the original schema bootstrap and then runs
`server/migrations.mjs`. The runner applies ordered, additive SQL migrations in
transactions and records each name/checksum/time in `schema_migrations`.
An edited applied migration fails explicitly. Existing positional insert table
contracts are unchanged; there is no database reset or seed overwrite.

| Migration | Added state |
| --- | --- |
| `server/migrations/001-user-safety.sql` | Directional user blocks and versioned guideline acceptance |
| `server/migrations/002-account-lifecycle.sql` | Active/suspended/deleted account state, deletion events, retryable photo cleanup and photo-owner ledger, with safe current-reference backfill |
| `server/migrations/003-ugc-moderation.sql` | Target-specific reports, queue/deduplication indexes, content-removal markers and private notices |

The migration regression test starts from the old schema with existing records,
opens/migrates/reopens it and verifies preservation/idempotence and checksum
protection. Take a consistent backup and test restoration before approved rollout.
Code rollback does not reverse legitimate deletion or moderation actions.

## Modified and added paths

Paths below are relative to the repository root. After the first complete path
in each group, abbreviated filenames use that same directory. The branch diff
is authoritative.

| Purpose | Files |
| --- | --- |
| Safety/lifecycle/report implementation | `server/user-safety.mjs`, `account-lifecycle.mjs`, `ugc-moderation.mjs`, `photo-access.mjs`, `public-policies.mjs`, `migrations.mjs`, the three `server/migrations/*.sql` above |
| Existing backend integration | `server/app.mjs`, `core.mjs`, `index.mjs`, `chat.mjs`, `deals.mjs`, `reviews.mjs`, `availability.mjs`, `moderation.mjs`, `listing-photos.mjs`, `admin-operations.mjs`, `admin.mjs` |
| Ordinary-user controls/translations | `web/safety-ui.js`, `safety-copy.js`, `safety-errors.js`, `app.js`, `chat-ui.js`, `review-ui.js`, `data.js`, `errors.js`, `i18n.js`, `style.css` |
| Administrator report interface | `web/admin-reports.js`, `admin-reports-copy.js`, `admin.js`, `admin-shell-copy.js`, `admin.css` |
| Public pages | `web/privacy-policy.html`, `delete-account.html`, `community-guidelines.html`, `policy.js`, `policy.css` |
| New regression coverage | `test/user-safety.test.mjs`, `account-lifecycle.test.mjs`, `ugc-moderation.test.mjs`, `photo-access.test.mjs`, `public-policies.test.mjs`, `compliance-integration.test.mjs`, `migrations.test.mjs`; `scripts/check-safety.mjs`, `check-reports.mjs` |
| Existing fixture consent updates | `test/admin-operations.test.mjs`, `booking-security.test.mjs`, `deals-support.test.mjs`, `host-photos.test.mjs`, `moderation.test.mjs`; `scripts/check-admin.mjs`, `check-host-photo.mjs`, `check-moderation.mjs`, `check-services.cjs`, `check-ui.cjs` |
| Documentation | `README.md`, `docs/DEPLOYMENT.md`, `SECURITY.md`, this report, `ACCOUNT-DELETION.md`, `MODERATION-OPERATIONS.md`, `PLAY-DATA-SAFETY.md`, `PRIVACY-REVIEW.md`, `SECURITY-COMPLIANCE-REVIEW.md` |

## Validation on 2026-11-18

All checks used synthetic isolated local data, not the VPS or real accounts.

| Executed check | Result |
| --- | --- |
| `npm test` (Node 24) | **119 passed, 0 failed, 0 skipped**; existing authentication/booking/search/deal/chat/support/photo/admin regressions plus new safety/lifecycle/report/policy/migration cases |
| Uploaded-photo HTTP authorization regressions (included above) | Seven passed: publication/current reference, owner access, removed/replaced/queued files, audited admin evidence, live session/role/state, encoded/versioned aliases, symlinks and shared legacy references |
| `scripts/check-safety.mjs` with Playwright/Chromium | Passed: actual checkbox acceptance/chat send, report message/listing, profile block and unblock, blocked send rejected, retained booking/arrival, admin removal, cached-chat redaction, wrong-password deletion refused and confirmed owner deletion completed; mobile EN/AR/RTL, no JS errors |
| `scripts/check-reports.mjs` | Passed: 27-case pagination, bounded escaped evidence, stale/error decision retry retaining note, remove/restore, Arabic/mobile layout, no JS errors |
| `scripts/check-host-photo.mjs` | Passed live and demo: required photo/consent, preview, create/replace/persistence, mobile layout and recoverable HTTP 413 |
| `scripts/check-moderation.mjs` | Passed: missing-photo approval blocked, stored-photo review, stale replacement check, host image preserved, approve/archive, Arabic/mobile and no JS errors |
| Public policy browser check | Passed public aliases without auth, missing-metadata review notice, safe operator text output, EN/FR/AR and RTL/mobile; durable policy assertions are in the unit suite |
| `git diff --check` and changed JavaScript syntax checks | Passed |

The real HTTP integration tests also cover unrelated/support-only report access
denial, CSRF/foreign origin, suspended-owner reauthentication/deletion, active
booking blockers, fresh Google-only deletion and session revocation while a
request body is incomplete. Google authentication tests use local signed-token
fixtures, not a real provider account.

Intermediate failures were corrected before these final passes: old fixtures
created content without explicit guideline consent; a quote guard looked up
the wrong peer; removed reviews were offered for reposting; and cached chat
needed removal invalidation. The corresponding fixtures/checks now exercise the
real consent endpoint and actual server restrictions. No product enforcement was
disabled to make tests pass. There are no remaining failures in the executed
checks above.

The final policy/source pass also found that archiving a prohibited listing alone
left its uploaded photo fetchable by a known URL. Uploaded-photo authorization
now closes that gap and the focused HTTP tests cover revoked/suspended access,
removed content and encoded/versioned aliases. Older clients' already-cached
copies cannot be recalled; new upload-image responses use no-store.

Browser tools are optional development tools outside the checkout, not new runtime
dependencies. For portable safety/report checks, install Playwright separately,
set `NODE_PATH` to its node_modules and optionally `BROWSER_EXECUTABLE` to Chromium,
then run the scripts from the project root. Screenshots in ignored `test-results/`
contain synthetic fixtures only and are not distributed as production content.

## Security review outcome

The [manual security report](SECURITY-COMPLIANCE-REVIEW.md) documents inspected
authentication, roles, SQL/XSS/CSRF boundaries, uploads, rate limits, sessions,
private booking/chat access and Android navigation restrictions. New paths were
also independently reviewed. No unresolved exploitable authorization/injection
issue was established in those reviewed paths. Request authority is rechecked
after asynchronous body/password work; report evidence is admin-only; removed
content cannot bypass enforcement through ordinary retry/review routes.

Managed security scan tools were unavailable, so no registered scan, penetration
test or security certification is claimed. Production DNS/TLS/proxy/firewall/logs,
backups, physical Android behavior and operational staffing were not remotely
verified. Existing secure transport configuration is not proof that the live
service is configured correctly or that stored databases are encrypted at rest.

## Required operator decisions and operational work

1. Supply the real public legal/operator identity and monitored privacy/support
   email. None was invented or copied from a private account. Configure the legal
   metadata described in [PRIVACY-REVIEW.md](PRIVACY-REVIEW.md).
2. Approve purposes and finite retention schedules for transactions, support,
   report evidence, audit, upload files and backups. Transaction/backup schedule
   and moderation schedule environment values publish declarations; they do not
   erase those records or configure the fixed evidence-expiry constants.
   Do not mark the policy reviewed while it differs from actual operation.
3. Review the implemented technical evidence expiry: 90 days after a closed
   case's last update, absolute maximum 180 days from creation (including open
   cases), checked every minute. Ordinary audit rows expire after 90 days.
   No legal-hold override is implemented. The operator must decide whether these
   limits fit its obligations; no legal necessity is asserted.
4. Staff the Reports queue and monitored appeals/contact process using least
   privilege. Document escalation and response expectations. A report-based human
   workflow requires real people; it does not proactively detect every harm.
5. Test backup expiry/restoration and reapplication of completed deletions before
   reopening restored data. Monitor queued photo cleanup and evidence expiry.
   Inventory unowned legacy photo files; do not delete another person's files by
   guessing their ownership.
6. Finish existing email verification/password recovery and assist owners unable
   to sign in. Set approved legal/rental terms and production log/provider controls.
7. After explicit deployment approval, verify real HTTPS policy/deletion links,
   all safety and booking flows in the release Android WebView, and actual
   third-party network traffic. The earlier unsigned 0.7.1 AAB remains unchanged;
   no new signed bundle or bundled offline asset build was created by this task.

## Google Play review checklist

| Declaration/item | Review status |
| --- | --- |
| Can users block other users? | Implemented and locally verified. Retain **Yes** only once approved deployment and release verification make it available to ordinary users. This is user-level interaction blocking; content reports/admin removal are separate controls. |
| Can users report users/content? | Implemented and locally verified for users/listings/messages/reviews. Same live-release condition. |
| Are conversations moderated? | Functional **human review** of reported conversations, locally verified. Requires deployment and staffed operation; do not claim automatic detection/filtering. |
| Automated spam/scam/harassment/threat/image detection | **Unavailable.** Correct any Play answer that specifically claims this. |
| Community Guidelines/consent | Implemented EN/FR/AR and enforced for new marketplace UGC; review final rules/operations. |
| Public privacy policy | Route implemented; operator identity/contact/retention review still required. Submit `https://garageshare.xyz/privacy-policy` only after approved deployment and public HTTPS verification. |
| In-app and public account deletion | Secure implemented flow; public URL `https://garageshare.xyz/delete-account` awaits approved deployment. Active-stay handling, retained pseudonymous history and backups must be reviewed/disclosed. |
| Data safety | Use [the source-backed inventory](PLAY-DATA-SAFETY.md). The app collects account, booking, location/property, photo and message data. No card gateway/advertising SDK is implemented. Assess purchase history and third-party sharing exceptions; do not declare no collection. |
| Store/reviewer access | Supply dedicated test accounts, accurate screenshots/metadata, app access instructions and reviewed privacy/deletion URLs. Complete applicable testing requirements shown in your Console. |
| Release readiness | Policy configuration, staffing, retention/backup operations, approved deployment, device acceptance and final Data safety answers remain manual release gates. Passing these local tests is not Google Play approval. |

Review branch: `feature/play-compliance`.
Compare: https://github.com/aymanboufounas/garage/compare/main...feature/play-compliance

**Production was not deployed or changed.** Review this branch and the listed
operator decisions before authorizing a VPS update.
