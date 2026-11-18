# Account deletion implementation and operations

This document describes implemented behavior, rather than a legal determination
about retention periods. The operator must approve its purposes, retention
schedule, public policy and backup procedures before public release. This change
prepares code and local tests; it does not deploy to a production service.

## Owner-verified flow

The public `/delete-account` page leads to the signed-in deletion flow; the same
flow is available in account settings. A signed-in owner can inspect
`GET /api/account/deletion` and submit `POST /api/account/delete` with
`{"confirmation":"DELETE","password":"..."}`. Google-only accounts omit the
password and must have a linked Google identity and a freshly authenticated
session created within the last five minutes. Linking Google to a password
account does not waive that account's password confirmation.

The account is always derived from the authenticated session. The endpoint
rejects supplied account IDs, email addresses or other unsupported payload
fields. Origin, CSRF, authentication and rate limits are enforced by the main
HTTP layer; the lifecycle implementation independently checks the live session
and reauthentication. After asynchronous password verification, it rechecks the
session, account credentials, state and blockers immediately before committing.
Password changes, logout/session revocation and concurrent deletion prevent a
stale request from completing.

Suspended accounts can create a restricted authenticated session to request
their own deletion and use support; this does not restore marketplace access.
Deleted accounts cannot authenticate or reactivate their old account. A later
new registration with the previously used email is a separate account and has
no access to retained records linked to the deleted account's old ID.

## Blockers

Deletion is refused while the account is a renter or host on any confirmed stay
whose end is in the future. This includes ongoing stays. The owner must resolve
or cancel those bookings using the normal flows or contact the operator before
trying again. Pending/countered offers do not prevent deletion: after verification
they are cancelled as part of the transaction. An administrator must leave at
least one other active administrator before deleting their own account.

A blocked request does not schedule a future unattended deletion. The user must
confirm again after the blockers have been resolved. Support must offer a way
to assist owners who cannot regain access; public contact information and the
operator's identity must be configured before launch.

## What the deletion transaction changes

- Replaces the user's name and email with a tombstone and random non-deliverable
  address, clears the password hash, removes sessions and Google identities, and
  invalidates pending Google proofs already associated with that verified email.
- Records `user_account_state=deleted`, a completion event, and an audit action.
  These contain the existing random user ID and timestamps, not the prior email.
- Archives the owner's garages and clears their names, area, exact address,
  coordinates, descriptions and photo references. City and transactional price
  fields remain with the archived records. Private host calendar blocks are removed.
- Cancels the account's pending/countered offers and its open price requests.
  Outstanding quotes involving the account's closed requests or owned garages
  become declined. Completed/booked transactions remain linked and are not erased.
- Replaces only the owner's authored chat and support messages with a removal
  marker, clears their review comments, clears their administrative cancellation
  reasons, and redacts their own resolved support ticket subject.
- Removes the owner's saved blocklist, guideline acceptance record, staff role
  and personal moderation notices. Other people's safety decisions remain theirs.
- Redacts closed moderation evidence about the account and its own closed report
  explanations/review notes. Pending or under-review report evidence is retained
  as protected operator evidence, never republished in public content.

All database changes are one transaction. A failed transaction does not partly
anonymize the account or remove its files. There is no automatic refund/payment
operation: this build records pay-on-arrival bookings, not collected funds.

## Retained history and anonymization limits

This is deletion of the live account and associated personal content with
**pseudonymized retained history**, not a claim that every historical record is
fully anonymous. Reservations retain their random participant IDs, dates,
amounts and status; ratings can remain without the author's comment. Shared
conversation/ticket records and messages authored by another participant remain
for that participant. Audit and administrator decision records preserve actions
and actors as deleted-account IDs. Report evidence can contain identifying text
or a photograph while a legitimate unresolved investigation is being reviewed.

A person who already knows a transaction may still recognize their counterpart
from its dates or context. Do not describe this as irreversible anonymization.
The operator must document a concrete purpose and finite retention/deletion
schedule for transactional records, report evidence, audit records and backups;
no period in this implementation is presented as legally required. The reporting
module's retention job must redact closed evidence and escalate unresolved holds
according to the adopted policy. Requests must not sit under review indefinitely.

The deletion API does not delete data from third parties, a phone's independent
screenshots/downloads, or another participant's own copies. The public policy
must accurately explain the service's data flows and any applicable exceptions.

## Safe photo cleanup

The `listing_photo_owners` ledger records ownership at upload time, including
older photos replaced by a newer one. The migration backfills current references
only when ownership is unambiguous. Photos already orphaned before this ledger
existed cannot be attributed safely from the database alone: the operator must
inventory and resolve those legacy files without assuming another person's file
belongs to a deletion request. Do not claim complete historical photo cleanup
until that legacy inventory has been reviewed.

Only random filenames matching `/assets/host-photos/<32 lowercase hex>.webp`
can enter cleanup. After the database transaction commits, cleanup verifies the
path, avoids symlinks, and removes a file only when no garage references it and
no pending/under-review report evidence holds it. Other participants' referenced
photos are preserved. A file/storage error or evidence hold leaves a row in
`account_photo_cleanup` for retry; deletion remains complete and the response
indicates whether that account still has pending file cleanup.

The server minute maintenance task calls `cleanupDeletedAccountPhotos`, processing
up to 100 queued files per pass after report-evidence expiry.
An operator can retry manually from the project root, as the same service user
and database location used by the server:

```bash
cd /opt/garageshare
runuser -u garageshare -- env DATA_DIR=/opt/garageshare/data node --input-type=module <<'JS'
import { resolve } from 'node:path';
import { openDatabase } from './server/core.mjs';
import { cleanupDeletedAccountPhotos } from './server/account-lifecycle.mjs';
const db = openDatabase(resolve(process.env.DATA_DIR, 'garageshare.sqlite'));
try { console.log(cleanupDeletedAccountPhotos(db, resolve('web'))); }
finally { db.close(); }
JS
```

Monitor pending rows, failed attempts and stale report holds. Resolve access and
storage failures rather than declaring files removed while they remain queued.
Do not bypass the orphan/reference checks or remove other users' files manually.

## Backups, restoration and evidence retention

Deleting live records does not modify an already-created backup. The operator
must set and enforce backup expiry, restrict backup access, and ensure a restore
does not make deleted accounts or their scrubbed content live again. Keep the
verified deletion ledger separately from backups being restored; apply those
completed deletions before allowing application traffic after a restore. Test
that procedure, including queued files and report holds. Retain only the minimum
ledger necessary to enforce deletion requests and document its retention.

These operational steps need an operator-approved policy; choosing a retention
number in a public page alone does not enforce deletion from retained copies.

## Local validation

`node --test test/account-lifecycle.test.mjs` exercises owner-only targeting,
password/fresh-Google verification, revoked sessions, concurrent credential
changes, renter/host booking blockers, last-active-admin protection, suspended
owner deletion, scrubbed account/message/listing data, preserved counterpart
history, photo holds/reference checks, and transaction rollback. Broader HTTP
integration tests verify the root authentication and CSRF boundaries separately.
