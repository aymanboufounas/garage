# GUI review and fixes

Review date: 2026-11-18. Baseline: `a8d1ffb` on `feature/play-compliance`.
The review used actual Chromium rendering, clicks, keyboard interaction, network
failure fixtures and screenshots against isolated local app instances with
synthetic accounts. It covered English, French and Arabic, desktop and mobile,
including 320px layouts, long valid names/emails and restricted deletion states.

The environment advertised a shared desktop but did not expose a desktop/browser
control tool. The available project browser runner was used for the repeatable
GUI checks. No signed-in Play Console session or live VPS GUI was accessed.

## Reproduced issues and resulting behavior

| Area | Before | Fixed behavior |
| --- | --- | --- |
| Cancelled deletion | A cancelled deletion sign-in callback survived and reopened deletion after an unrelated login | Explicit close clears the callback and deletion intent. Normal sign-in stays normal; deliberate auth toggles preserve the intended flow. |
| Delayed sign-in | An older login response could close a newer dialog and invoke its callback | Callback/version is captured before the request; stale responses reconcile identity without taking over the newer dialog. |
| Google deletion return | OAuth returns to `/index.html#google=…`, losing the public deletion URL's query intent | A constant, temporary session marker resumes the deletion sheet after the existing OAuth proof flow. No password, token or private content is stored in that marker. |
| Google freshness/session expiry | A stale provider sign-in had no usable action; freshness expiring while the form was open returned 401 without recovery | A disabled deletion action is paired with Google reauthentication. A stale or revoked session is reconciled safely and returns to explicit sign-in/deletion confirmation; no automatic deletion occurs. |
| Deletion blockers | Active-booking/last-admin blockers left only a disabled submit button | Reservation/support links and administrator-management guidance provide routes to resolve blockers. Server verification and blockers are unchanged. |
| Account layout | Long valid names/emails overflowed a 320px sheet (measured internal width 1145px) | Text wraps within the 320px modal. |
| Privacy during login | The form opened an abbreviated legacy privacy modal, replacing typed inputs | The full public privacy policy opens in a new tab with the chosen language, preserving the form. The label describes a privacy notice rather than implying unreviewed rental terms. |
| Rules in settings | Two entries had the same Community Guidelines label | Signed-in settings contain one rules/acceptance entry with a link to the public guidelines. |
| Own listing reports | Hosts saw a Report listing action that the server always rejected | Own-content reporting controls are omitted; ordinary users retain reporting access. |
| Block controls | A previously blocked host still showed Block user on a listing | Listing controls read current peer safety state and show Unblock where applicable. |
| Peer profile | A profile included another View profile link back to itself | The current profile shows its relevant block/report controls without the recursive link. |
| Dismissed safety sheet | A delayed profile response reopened a sheet after the user dismissed it | Safety responses are guarded by current modal version and actor. Dismissed/replaced dialogs stay dismissed. |
| Report context | The report form omitted which kind of content/listing was being reported | Visible, escaped target type and available target name identify the report. Retryable failures preserve the reason and explanation. |
| Admin decision drafts | Refreshing/changing reports discarded draft notes | Draft actions/notes are retained within the mounted Reports view and cleared after a successful decision. They are not persisted to browser storage. |
| Admin queue errors | A failed new filter left old results beneath the new selected status | Stale rows are cleared and an explicit error/retry state is shown. |
| Admin mobile focus | Selected evidence was off-screen; initial scroll-to-heading hid its first lines behind the sticky header | Selection focuses and positions the complete heading below the actual visible header. Keyboard tests compare both elements' bounds. |
| Admin layout/accessibility | Long names overflowed, four metrics inherited a five-card layout, and selection/error semantics were incomplete | Report-scoped wrapping, balanced metrics, pressed-state status controls, accessible queue/error regions and keyboard focus improve review usability. |
| Policy/app language | A stale `?lang` overrode a new selection on reload; Arabic deletion links reached English login | Language selection updates URL/storage in both the public pages and app; public navigation/deletion links carry a validated locale. The app accepts validated `?lang=en|fr|ar`, including when storage is unavailable. |
| Policy readability/accessibility | CTA contrast was 3.47:1, version contrast 3.93:1; keyboard/nav targets were insufficient | Measured contrast is 5.55:1 and 5.70:1 respectively; visible skip/focus links, localized navigation, 44px controls and paragraph spacing improve access. |
| Policy edge cases | A valid long email widened a 320px page to 911px; an ISO version reversed visually in Arabic; deletion instructions pointed below a button located above | Contact text wraps at 320px, the version is isolated LTR, and instructions identify the action without an incorrect position. |

## Verification

| Executed check | Result |
| --- | --- |
| `npm test` | **119 passed, 0 failed, 0 skipped** |
| `scripts/check-account-gui.mjs` | Passed: cancel/resume, delayed login isolation, full privacy link/form preservation, URL-language reload, long text EN/FR/AR at 320/1440px, blocker actions, OAuth return, after-render freshness expiry, revoked session and fresh explicit deletion confirmation |
| `scripts/check-user-actions-gui.mjs` | Passed: own-report omission, current Unblock state, no recursive profile link, dismissed slow response, named report context, 503 HTML error/retry retention, host form/empty state, EN/FR/AR desktop/mobile and no page errors |
| `scripts/check-reports-ui.mjs` | Passed in actual `/admin.html`: drafts, failed-filter retry, complete heading clear of sticky header, long-name wrapping, metrics, keyboard controls and alert/selection semantics in EN/FR/AR desktop/mobile |
| `scripts/check-policy-gui.mjs` | Passed: 18 page/language/layout views plus 320px contacts, contrast, keyboard/targets, language reload, metadata error fallback and Arabic app handoff with storage unavailable |
| Existing `check-safety.mjs` | Passed block/unblock, reports, admin removal, cached chat redaction, preserved booking/arrival, verified password deletion and mobile/RTL |
| Existing `check-host-photo.mjs` | Passed live/demo photo creation/replacement/persistence, required consent, mobile layout and recoverable upload 413 |
| Existing `check-reports.mjs` | Passed queue pagination, scoped escaped evidence, retained error notes, actual removal/restoration and Arabic/mobile |
| Changed JavaScript syntax and `git diff --check` | Passed |

Baseline GUI failures were reproduced before corrections. The focused review
also caught the delayed-login callback race, the stale-Google response's actual
401 status and the sticky-header overlap; regression cases now exercise those
specific failures. An initial OAuth GUI fixture generated storage errors on the
simulated external navigation; its fixture initializer now handles unavailable
storage. Final executed checks have no unresolved failures. Browser-suite pass
counts are separate from the 119 Node tests, rather than added into that total.

The optional browser runners use a separate Playwright installation; no production
dependency or native Android permission was added. Set `NODE_PATH` to that
installation's `node_modules` and `BROWSER_EXECUTABLE` to Chromium if it is not
managed by Playwright, then run from the repository root:

```bash
npm test
node scripts/check-account-gui.mjs
node scripts/check-user-actions-gui.mjs
node scripts/check-reports-ui.mjs
node scripts/check-policy-gui.mjs
node scripts/check-safety.mjs
node scripts/check-host-photo.mjs
node scripts/check-reports.mjs
```

Run browser scripts sequentially on a small machine. Each uses an isolated local
database and temporary copy of the web assets; `UI_PORT` can override its port.
Screenshots generated under ignored `test-results/` include `account-gui-*`,
`user-actions-*`, `reports-gui-*` and `policy-gui/`. They contain fixture data and
are not deployed as product content. Google browser checks simulate only the
provider consent hop using the existing signed-token fixture; application
redirects, cookies, proof validation, session rotation and deletion remain real.

## Changed paths

- Account/safety and chat UI: `web/app.js`, `web/safety-ui.js`,
  `web/safety-copy.js`, `web/chat-ui.js`, `web/style.css`.
- Admin Reports UI: `web/admin-reports.js`, `web/admin-reports-copy.js`,
  `web/admin.css`.
- Public policy UI: `web/policy.js`, `web/policy.css`,
  `web/privacy-policy.html`, `web/delete-account.html`,
  `web/community-guidelines.html`.
- Durable GUI regressions: `scripts/check-account-gui.mjs`,
  `scripts/check-user-actions-gui.mjs`, `scripts/check-reports-ui.mjs`,
  `scripts/check-policy-gui.mjs`.
- This report and its README link.

## Release boundaries

This follow-up changes UI and development verification; it adds no backend API,
database migration, automatic 90-day user-data purge or automated content
classifier. It does not populate missing operator/legal information or declare
Google Play approval. The [Console answer guide](PLAY-CONSOLE-ANSWERS.md),
[Data safety inventory](PLAY-DATA-SAFETY.md) and
[operator review](PRIVACY-REVIEW.md) still apply.

The public deletion page passes local GUI checks. The 404 shown in the user's
Console screenshot requires an approved production rollout and public HTTPS
verification; a local GUI fix does not establish that the live URL works.
No production deployment, real account mutation or Play Console submission was
performed. VPS deployment continues to require the owner's approval.
Physical Android WebView behavior, real Google credentials, live map-provider
availability and the production reverse proxy still require release verification.
