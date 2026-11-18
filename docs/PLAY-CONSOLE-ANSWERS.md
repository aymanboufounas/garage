# Play Console screenshot: account and data deletion answers

Reviewed 2026-11-18 against implementation commit `463b67a` and the user's
French Data safety form screenshot. These answers describe verified source/local
behavior. Production must match the actual Android release before submission.
No production deployment or Console submission is performed by this review.

## The selected 90-day answer is incorrect for GarageShare

The optional question asks whether users can request deletion of some or all of
their data **without deleting their account**. It is separate from the required
account-deletion flow and its public web link.

Select **« Non »** for that optional question with the currently verified feature
set. Do not select **« Non, mais les données utilisateur sont automatiquement
supprimées sous 90 jours »**. There is no general 90-day deletion of accounts,
bookings, messages, photos or all associated user data.

Implemented maintenance expires ordinary audit rows after 90 days and stored
report evidence after 90 days from a closed case's last update, with a maximum
of 180 days from creation for every case. These narrow jobs do not support a
declaration that all user data is automatically deleted within 90 days. Do not
add a blanket purge of reservations/accounts to make that form answer true.

Owner-requested account deletion is implemented in the review branch, available
from account settings and the public `/delete-account` page. It reauthenticates
the owner, protects active reservations, removes/scrubs personal content and
retains disclosed pseudonymous transaction/evidence history where implemented.
It is not a separate data-only request workflow. See [ACCOUNT-DELETION.md](ACCOUNT-DELETION.md).

## Answers for the visible form

| Visible question/choice | Answer supported by the implementation |
| --- | --- |
| Does the app collect or share user data? | **Oui** for collection. Account identities, listings/property coordinates, photos, bookings and messages are collected. Evaluate individual sharing categories using the actual recipients/exemptions in the [inventory](PLAY-DATA-SAFETY.md). |
| Are all collected user data encrypted in transit? | Source supports HTTPS-only release traffic and secure production settings. Keep **Oui** only after verifying the deployed app/API and external transfers actually use HTTPS. A password hash is not proof of encryption in transit. Production transport was not verified in this review. |
| « Nom d’utilisateur et mot de passe » | Select: email/password registration and login are implemented. GarageShare uses the email address as its account identifier. |
| « Nom d’utilisateur et autre authentification » | Do not select on the current verified flows. |
| « Nom d’utilisateur, mot de passe et autres méthodes d’authentification » | Uncheck: GarageShare has no additional password-flow factor such as MFA, SMS OTP, TOTP or biometrics. Internal OAuth state/proof handling is not user MFA. |
| « OAuth » | Select only when Google sign-in is enabled, accessible and working in the actual released Android app. Optional OAuth source support alone is insufficient. An alternative Google login is distinct from adding an extra factor to password login. |
| « Autre » / app does not allow account creation | Do not select for the currently implemented account flows. |
| Account deletion URL | Intended URL: `https://garageshare.xyz/delete-account`. The screenshot shows a **404**, so the public URL is not ready for submission on that evidence. The reviewed route has passed local tests and awaits approved rollout/public verification. |
| Deletion of data without deleting the account (optional) | **Non** for the currently verified feature set. No independent data-only request workflow was implemented/verified. |
| « Non, mais … automatiquement supprimées sous 90 jours » | **Do not select.** The narrow maintenance jobs are not global user-data erasure. |
| Independent security-review badge | No qualifying badge or recognized assessment was obtained by this task. A manual source/test review does not establish eligibility for the badge. |

The separate account-deletion feature does not require selecting the optional
90-day answer. Use the exact wording and help offered in your current Console
when completing the final declaration.

## Resolve the public URL before submission

1. Review/approve the feature branch and the remaining operator decisions before
   deployment. The earlier task explicitly forbids production deployment without
   the owner's approval; this review does not change that instruction.
2. Configure the real operator identity, monitored contact, accurate retention
   schedule and actual backup/deletion operations. Do not remove the policy's
   review banner merely to get past a store form.
3. After approved deployment, open `/delete-account` and `/privacy-policy` while
   logged out on the real HTTPS domain. Both must be accessible and accurately
   explain the app, process, deleted/retained categories and retention periods.
4. Complete deletion through the actual release app and website using dedicated
   test accounts. Test password and configured Google flows, active-stay blockers,
   support escalation and post-deletion sign-in revocation. An HTTP 200 alone does
   not prove the deletion workflow or required disclosures work.
5. Revalidate the URL in Play Console, then complete each Data safety category
   using [PLAY-DATA-SAFETY.md](PLAY-DATA-SAFETY.md). Do not submit while the Console
   still reports a broken URL.

For a public status check from Windows Command Prompt or PowerShell:

```powershell
curl.exe -I https://garageshare.xyz/delete-account
curl.exe -I https://garageshare.xyz/privacy-policy
```

Expect a valid HTTPS response and a final successful page, not a 404/403, login
wall or certificate warning. Also inspect the actual page and complete the flow.

## Limits and official references

The earlier implementation passed 119 automated tests and the documented browser
walkthroughs. This follow-up changes documentation only. It does not constitute
Google Play approval or certification of all store policies.

This environment's outbound proxy returned 403 when attempting the live domain
and Google Help, so current production status and the latest help text were not
independently fetched here. The 404 finding comes from the supplied Console
screenshot, not a newly successful remote check. Verify current requirements
directly before publication:

- [Account deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111)
- [Data safety guidance](https://support.google.com/googleplay/android-developer/answer/10787469)
- [UGC policy](https://support.google.com/googleplay/android-developer/answer/9876937)

Operator identity/contact, lawful retention, tested backup/deletion operations,
staffed human moderation, approved deployment and release/device verification
remain release gates. Automatic content detection remains unavailable. The
implementation is described accurately without a blanket compliance guarantee.
