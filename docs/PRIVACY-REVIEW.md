# Public policy and operator review

New public pages are `/privacy-policy`, `/delete-account`, and
`/community-guidelines` (plus their `.html` files), in English, French and Arabic.
They are ordinary same-origin HTTPS pages that can be viewed in the connected
Android WebView. They require no login to read. The deletion page starts an
owner-verified web flow at `/?delete-account=1`; it does not ask the user to
reinstall the app, disclose a password to staff, or delete an arbitrary user ID.

## Metadata contract

`server/public-policies.mjs` exports:

- `PUBLIC_POLICY_PAGES`: canonical URL → static HTML pathname.
- `publicPolicyConfig(options)`: safe public metadata for `GET /api/legal`.

Only the following explicit options are accepted:

```js
{
  operatorName: 'YOUR REAL PUBLIC OPERATOR NAME',
  contactEmail: 'YOUR REAL PUBLIC PRIVACY/SUPPORT EMAIL',
  policyReviewed: true, // Set only after the operator's actual review.
  transactionRetentionDays: undefined,
  moderationRetentionDays: undefined,
  backupRetentionDays: undefined
}
```

The example values are placeholders, not GarageShare's legal identity/contact.
`server/index.mjs` maps `OPERATOR_NAME`, `PRIVACY_CONTACT_EMAIL`,
`PRIVACY_POLICY_REVIEWED=1`, `TRANSACTION_RETENTION_DAYS`,
`MODERATION_RETENTION_DAYS` and `BACKUP_RETENTION_DAYS` to those options.
Never return the whole process environment or a credentials object from
`/api/legal`.

The config limits text, validates an email-like public contact and accepts only
bounded positive integer days. It returns `review_required:true` if required
metadata/schedules or the explicit policy review are missing. Pages show an
operator-review banner and identify missing fields instead of inventing details.
Operator-supplied metadata is rendered with DOM textContent, not raw HTML.

A declared retention period is not proof of an automatic job or expired backup.
The page explicitly distinguishes operator declarations from implementation.
The operator must ensure any supplied periods match the actual process and law.
These environment values publish metadata; they do not configure a transaction
purge, expire backups, or override the report-evidence cleanup constants.
The integrated service checks evidence cleanup once per minute: closed cases
expire 90 days after their last update, and all cases have a 180-day maximum
from creation, including unresolved cases. Cleanup removes stored report
evidence, explanations and review-note text, not every original message or
booking record. No legal-hold switch is implemented. Approve these defaults or
implement and verify a different schedule before claiming an operator-specific
retention period is enforced. No production deployment was performed here.

## Required operator decisions before public launch

1. Legal/operator name, responsible business/person and country/jurisdiction;
   public privacy/support contact actually monitored by that operator.
2. Hosting, reverse-proxy/CDN and backup providers and access arrangements. The
   source does not verify whether a processor contract or sharing exception exists.
3. Lawful transaction-history and safety-evidence retention periods; limited
   dispute/legal holds and a method to release holds. Do not describe all
   pseudonymous history as irreversibly anonymous or legally mandatory.
4. Actual backup expiry, protected access, deletion-on-restore procedure and file
   cleanup ownership. Deleting database references cannot instantly erase backups.
5. Rights/request handling, response process and local legal language. No
   jurisdiction-specific legal rights/deadlines were invented by this change.
6. The final privacy policy and rental/marketplace terms. These documents are
   implementation-backed drafting aids, not legal advice or Play approval.

## Deletion facts the policy discloses

- Owner confirmation `DELETE` plus current password; Google-only account needs
  an existing Google identity and a sign-in within five minutes.
- Ongoing/upcoming confirmed renter or host stays must be resolved first. A last
  active admin must arrange a replacement. Another person's active reservation
  is not erased by a deletion request.
- Own pending/countered offers and open price requests are cancelled; owned
  garages archived and unnecessary listing/entrance/image data scrubbed.
- Active-system identity/password, sessions/Google links and own ordinary chat,
  support text/review comments are removed or anonymized as implemented.
- Shared booking dates/amount/status, ratings, other participants' own content,
  audit/administrative decisions and deletion tombstones may remain pseudonymous.
- Open report evidence may be held within the cleanup maximum; closed evidence
  concerning the deleted subject is redacted by the lifecycle implementation.
  Photo deletion respects retained references; failures queue retry instead of
  falsely reporting all physical copies deleted immediately.
- Uploaded photos are public only while current on an approved, non-removed
  listing whose owner is active. An active owner can privately view their own
  current non-removed image, including pending/rejected/ordinary archived
  listings. Active administrators can review current listing images and retained
  reported-photo snapshots; private admin access is audited. A moderation-removed
  image is denied to the owner, ordinary users, support-only staff and anonymous
  visitors. Replaced images require a retained report reference for admin access.
- Uploaded-photo responses now use no-store. Previously cached or downloaded
  copies cannot be recalled. Verify that production reverse-proxy/static/CDN
  routing does not bypass the application's photo authorization handler.

## Verification scope

The source config/page checks can prove routing, unauthenticated access,
localization and safe rendering. They cannot prove the user's production DNS,
TLS renewal, monitored email, hosting contracts, lawful retention, backup expiry
or that a human moderator is operating the queue. Do not mark the operator review
complete merely because tests pass. No production deployment is authorized by
this task; deploy only after explicit owner approval.
