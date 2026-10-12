import { cookies } from "next/headers";

import { INVITE_CONFIRM_COOKIE_NAME, peekInviteConfirmationDetails } from "../../../lib/magic-link";
import { AcceptInviteButton } from "./AcceptInviteButton";

/**
 * The explicit action review #88 (REV-011) requires before an invite token
 * is consumed, and what it actually says before that click (review #88
 * round 5, REV-003).
 *
 * `GET /auth/redeem` lands here for any still-live invite token, having
 * set an `HttpOnly` cookie rather than a query string (REV-002) -- so this
 * is a Server Component, not a client one, because reading that cookie at
 * all requires running on the server. It never reaches this page for a
 * plain login link, which that route still redeems directly.
 *
 * REV-011 established that consuming an invite takes a deliberate click.
 * That is not the same as an informed one: the page below it used to say
 * only "someone invited you", the same sentence for a brand new
 * organization and for a change to access the recipient already holds. An
 * existing admin invited to auditor with replaceExistingRole could read
 * that sentence, click "Accept invite", and demote themselves without
 * ever being told a role was changing. So this reads the same peek
 * `isRedeemableInviteToken` performs and renders what it found -- the
 * organization, the role, and whether accepting replaces one the
 * recipient already has -- and labels the button for the destructive case
 * rather than leaving "Accept invite" to cover both.
 */
export default async function ConfirmInvitePage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(INVITE_CONFIRM_COOKIE_NAME)?.value;

  if (token === undefined || token.length === 0) {
    return (
      <main>
        <p className="eyebrow">Signal Audit</p>
        <h1>Invite link incomplete</h1>
        <p role="alert">
          This confirmation has expired, or was opened in a different browser than the one that followed the
          link. Ask whoever invited you to send it again.
        </p>
        <p className="footnote">
          <a href="/">Back to sign in</a>.
        </p>
      </main>
    );
  }

  const invite = await peekInviteConfirmationDetails(token);
  if (invite === undefined) {
    // Deliberately not authoritative, same as the peek itself: an expired,
    // consumed or otherwise invalid token is reported the same generic
    // way here, and the actual accept action re-validates atomically
    // regardless of what this page said.
    return (
      <main>
        <p className="eyebrow">Signal Audit</p>
        <h1>Invite link no longer valid</h1>
        <p role="alert">This invite link has expired or was already used. Ask whoever invited you to send a new one.</p>
        <p className="footnote">
          <a href="/">Back to sign in</a>.
        </p>
      </main>
    );
  }

  return (
    <main>
      <p className="eyebrow">Signal Audit</p>
      {invite.replacesRole === undefined ? (
        <>
          <h1>Accept invite</h1>
          <p>
            <strong>{invite.organizationName}</strong> invited you to join as <strong>{invite.role}</strong>.
            Accepting signs you in and creates your membership.
          </p>
          <AcceptInviteButton label="Accept invite" />
        </>
      ) : (
        <>
          <h1>Confirm role change</h1>
          <p role="alert">
            <strong>{invite.organizationName}</strong> invited you to join as <strong>{invite.role}</strong>. You
            are currently an <strong>{invite.replacesRole}</strong> of {invite.organizationName} -- accepting will
            change your role.
          </p>
          <AcceptInviteButton label="Change my role" />
        </>
      )}
    </main>
  );
}
