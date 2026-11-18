# GarageShare moderation operations

This release provides a **human-review** reporting workflow, not an automatic
multilingual spam, harassment, threat, scam or explicit-image classifier. It can
receive and investigate those reported harms; it does not continuously inspect
all private chats or guarantee detection before a user sees content. Any Google
Play answer implying automatic detection would need correction or a separately
implemented and evaluated system.

## Rules and ordinary-user controls

The public `/community-guidelines` page prohibits explicit sexual content,
graphic violence, child sexual abuse/exploitation, threats, hate, harassment,
spam, scams, phishing, illegal/misleading listings and unauthorized disclosure
of private data. Server acceptance gates cover listings, listing photos, direct
chat messages and reviews. The rules also apply to profiles and support
interactions; those flows do not add a separate acceptance gate.
Report reasons cover spam, harassment, fraud, inappropriate content, misleading
listing and other; the explanation is optional. Reports are limited to targets
the reporter may actually view. Duplicate and rate-limit checks reduce abuse.

Users can block/unblock peers and manage their own block list. Blocking applies
on the server to new direct messaging and unwanted new interactions in both
directions. It is not an automatic booking cancellation. Existing participants
retain necessary transaction information and historical read access; use support
when blocked parties need a booking issue resolved.

## Case handling

1. Only authorized administrators enter the Reports queue. Support-role staff
   cannot read the UGC moderation queue or reported private-chat context merely
   because they answer support tickets.
2. Triage pending reports for immediate safety concerns, fraud and illegal
   listings. Mark a case under review. Never copy evidence into public tickets,
   chat or logs; the reporter identity must not be disclosed to the subject.
3. Inspect the reported snapshot and only the bounded context necessary. A
   message case exposes the exact reported message plus at most three nearby
   messages before/after in that same thread. It is not a search tool for every
   private conversation. Evidence/context reads are audited.
4. Confirm the factual context and use an appropriate action: remove message or
   review content, archive an unsafe listing, warn a user, suspend an account,
   or dismiss an invalid report. Do not erase shared booking records. A safety
   removal can hide a listing while preserving existing reservation references.
5. Record the review note/status/action; decisions are audited. Suspension ends
   sessions and prevents new account use. Restoration does not silently republish
   an archived listing. Prevent operator self/last-admin lockout.
6. Subject warnings/notices describe the action without reporter details. Direct
   an appeal to the public operator contact with a case/listing reference, not
   passwords or unnecessary private messages.

The operator must provide enough authorized reviewers and a monitored contact;
there is no promised response-time SLA or emergency-response capability. For
immediate danger, users should contact appropriate local emergency services.

## Evidence, deletion and retention

The implemented technical evidence cleanup expires closed cases 90 days after
their last update and all cases after a maximum of 180 days from creation,
including unresolved cases. The integrated Node service schedules this check
every minute in `server/index.mjs`. It runs after this branch is deployed; no
production deployment was performed during implementation.
Cleanup removes evidence/explanation/review-note text while retaining limited
case/status metadata and structured removal markers. Ordinary audit events have
a separate 90-day cleanup. Evidence expiry does not delete all original messages
or booking records. These are technical defaults, not a finding about what any
jurisdiction legally requires. The public retention metadata does not configure
these jobs, and no legal-hold switch is implemented: unresolved cases still reach
the hard maximum. Approve and document the actual schedule, backup expiry and
any required implementation changes before public launch.

Deleting a subject account scrubs ordinary active-system content but can leave
necessary open-case evidence until case closure/cleanup. Authorized reviewers
must not claim that a deletion request erased every evidence or backup copy.
The operator must expire backups and reapply deletion events before restoring
access to restored data.

## Safe configuration and review

- Configure staff/admin access through trusted existing operator controls. No
  public signup role field grants moderation access.
- Keep report evidence private, authenticated and no-store. Keep request-body,
  OAuth query and private-message data out of logs. Review Nginx/hosting logging.
- Keep the host photo size/container checks and client WebP re-encoding. They
  are not an automatic nudity or malware scanner. Human approval must review
  that the photo accurately represents an authorized garage.
- Photo URLs are public only for the current image of an approved listing with
  an active owner and no moderation-removal marker. Pending/rejected/ordinary
  archived current images are privately available to their active owner, unless
  moderation removed the listing. Removed images are denied to owners, ordinary
  users, support-only staff and anonymous visitors, even with a known URL.
- Active administrators can privately view current listing images or retained
  reported-photo snapshots; access is audited. Replaced, unreferenced images
  are denied. New uploaded-photo responses use no-store; previously cached or
  downloaded copies cannot be recalled. Keep production image requests behind
  the application authorization handler, without a bypassing static/CDN alias.
- Make the operator's public contact, policy identity and retention schedules
  real before setting a policy-reviewed flag or publishing.
- Test ordinary-user reporting, reporter privacy, block enforcement and
  unauthorized evidence access after deployment, not just the existence of UI.

Feature declarations can be supported by this human-review workflow only after
it is deployed and staffed. Review the exact wording of the current Play Console
questions; do not claim automatic multilingual detection when only human review
is available. Never deploy this review branch without owner approval.
