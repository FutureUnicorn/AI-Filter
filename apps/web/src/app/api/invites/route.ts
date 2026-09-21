import {
  buildApiError,
  checkIdempotencyRequirement,
  createInviteInputSchema,
  generateRequestId,
  idempotencyErrorResponse,
  withRequestId
} from "@signal-audit/contracts";
import { loadEnvironmentConfig } from "@signal-audit/config";
import {
  createInviteMagicLinkToken,
  getMembershipIdForEmail,
  getMembershipsForUser,
  previewInviteEffect
} from "@signal-audit/db";
import {
  authorizeResourceAccess,
  createMagicLinkEmailSender,
  generateMagicLinkToken,
  logStructured,
  resourceAuthorizationErrorResponse
} from "@signal-audit/security";
import type { NextRequest } from "next/server";

import { readSessionUserId } from "../../../lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * AF-97: the HTTP entry point for AF-16's invite machinery.
 *
 * Every piece of this existed already -- `MagicLinkInvite`,
 * `createInviteInputSchema`, and the redemption path that provisions the
 * user and membership atomically -- and no route exposed any of it. So
 * an owner could be created (by `pnpm bootstrap:owner`, the one grant
 * that cannot come from inside an invite-only system) and then had no
 * way to bring anyone else in.
 *
 * `access_admin_settings` is the gate, not `manage_roles`: a recruiter
 * holds `manage_roles` and can create hiring roles, which is not the
 * same authority as adding people to the tenant. Owner and admin hold
 * `access_admin_settings`; recruiter and auditor do not.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const requestId = generateRequestId();
  const requirement = checkIdempotencyRequirement(request.method, request.headers.get("Idempotency-Key"));
  const idempotency = idempotencyErrorResponse(requirement, requestId);
  if (idempotency !== undefined) {
    return Response.json(idempotency.body, {
      status: idempotency.status,
      headers: withRequestId(undefined, requestId)
    });
  }
  // Honoured, not merely validated (review #88, REV-007). Requiring a header
  // and then discarding it is worse than not requiring one: it tells the
  // caller a retry is safe while a timed-out retry mints a second live
  // credential, a second audit trail and a second email.
  const idempotencyKey = requirement.required && requirement.outcome === "present" ? requirement.key : undefined;
  if (idempotencyKey === undefined) {
    const error = buildApiError({
      requestId,
      code: "missing_idempotency_key",
      message: "Mutating requests require an Idempotency-Key header."
    });
    return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
  }

  const userId = readSessionUserId(request);
  if (userId === undefined) {
    const error = buildApiError({ requestId, code: "unauthorized", message: "Sign in required." });
    return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
  }

  const parsed = createInviteInputSchema.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) {
    const error = buildApiError({
      requestId,
      code: "invalid_request",
      message: "Body must be { email, organizationId, role }."
    });
    return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
  }

  try {
    const config = loadEnvironmentConfig(process.env);
    const memberships = await getMembershipsForUser(config.database.url, config.database.schema, userId);
    const authorization = authorizeResourceAccess(
      memberships,
      parsed.data.organizationId,
      "access_admin_settings",
      userId
    );
    const authError = resourceAuthorizationErrorResponse(authorization, requestId);
    if (authError !== undefined) {
      return Response.json(authError.body, {
        status: authError.status,
        headers: withRequestId(undefined, requestId)
      });
    }

    /*
     * What this invite would actually do, resolved before anything is
     * minted (review #88, REV-002 and REV-003).
     *
     * `POST /api/invites` is not only an "add somebody" endpoint, because
     * redemption ends in `ON CONFLICT ... DO UPDATE SET role`. Two outcomes
     * needed answering here rather than at redemption, which is far too late
     * for both:
     *
     *   - A role replacement was silent. The invitee's click committed it,
     *     from a link their mail client shows as an ordinary sign-in.
     *   - A last-owner demotion was accepted, audited and delivered, then
     *     failed at redemption forever: the transaction rolls back so
     *     `consumed_at` stays null, every retry reproduces it, the invitee
     *     lands on `/?auth=error`, and nothing tells the admin who issued
     *     it. That is precisely the undiagnosable bounce this ticket's
     *     sign-in page exists to end, reintroduced through this route.
     *
     * The preview is advisory: it is a read, so the membership can change
     * before redemption, and `provisionInvitedMembership`'s own guard inside
     * the redemption transaction remains the enforcement. What it buys is
     * that the ordinary case fails at the person who can act on it.
     */
    const effect = await previewInviteEffect(config.database.url, config.database.schema, {
      organizationId: parsed.data.organizationId,
      email: parsed.data.email,
      role: parsed.data.role
    });

    if (effect.outcome === "strands_organization") {
      const error = buildApiError({
        requestId,
        code: "conflict",
        message:
          `This would leave the organization with no owner: ${parsed.data.email} is its only owner, and ` +
          `the invite names ${effect.to}. Promote another owner first.`
      });
      return Response.json(error.body, {
        status: error.status,
        headers: withRequestId(undefined, requestId)
      });
    }

    if (effect.outcome === "changes_role" && parsed.data.replaceExistingRole !== true) {
      // Refused rather than performed, because "invite" is not a word that
      // warns anybody a role is about to be replaced. An admin who means it
      // says so; the default cannot mutate existing access by accident.
      const error = buildApiError({
        requestId,
        code: "conflict",
        message:
          `${parsed.data.email} already belongs to this organization as ${effect.from}. Sending this invite ` +
          `would change their role to ${effect.to} when they open the link. Resend with ` +
          `replaceExistingRole: true if that is what you intend.`
      });
      return Response.json(error.body, {
        status: error.status,
        headers: withRequestId(undefined, requestId)
      });
    }

    const roleChange =
      effect.outcome === "changes_role"
        ? await getMembershipIdForEmail(
            config.database.url,
            config.database.schema,
            parsed.data.organizationId,
            parsed.data.email
          )
        : undefined;

    const generated = generateMagicLinkToken();
    const creation = await createInviteMagicLinkToken(config.database.url, config.database.schema, {
      idempotencyKey,
      tokenHash: generated.tokenHash,
      email: parsed.data.email,
      invite: { organizationId: parsed.data.organizationId, role: parsed.data.role },
      expiresAt: generated.expiresAt,
      audit: { actorUserId: userId, requestId },
      ...(effect.outcome === "changes_role" && roleChange !== undefined
        ? { roleChange: { membershipId: roleChange, from: effect.from, to: effect.to } }
        : {})
    });

    if (creation.outcome === "replayed") {
      // This key already minted an invite. Nothing was written, and nothing
      // is sent: re-delivering would put a second live link in the
      // recipient's mailbox for one act. The 202 is the same as the first
      // call's, which is the point of the header.
      return new Response(null, { status: 202, headers: withRequestId(undefined, requestId) });
    }

    // Built from configured state, never from the request host, for the
    // same reason the login route does it: a caller controls `Host`, and a
    // link built from it would deliver a redeemable credential to whatever
    // origin the caller named. Same shape as the emailed login link, so
    // `GET /auth/redeem` serves both.
    const link = `${config.publicAppOrigin}/auth/redeem?token=${generated.token}`;
    const emailSender = createMagicLinkEmailSender({
      appEnv: config.appEnv,
      delivery: config.magicLinkEmail
    });
    try {
      // The recipient's click is what commits a role change, so the mail
      // must say which of the two this link is (review #88, REV-002).
      await emailSender.sendMagicLink({
        email: parsed.data.email,
        link,
        purpose: effect.outcome === "changes_role" ? "role_change" : "invite"
      });
    } catch (deliveryError) {
      // Reported honestly, unlike the login endpoint's deliberate silence.
      // That endpoint is unauthenticated, so telling the caller anything
      // that varies by address turns it into an account-existence oracle.
      // This one is authenticated and already authorized against the
      // organization the invitee is being added to, so there is nothing
      // here the caller could learn that they do not already have.
      //
      // The token row and its audit event are committed by this point, so
      // the invite exists and is simply undelivered: it expires on its own,
      // and issuing another one is the fix. Saying so is more useful than a
      // 202 that leaves an admin waiting for mail that will never arrive.
      logStructured("error", "magic_link.delivery_failed");
      console.error("invite delivery failed", deliveryError);
      const error = buildApiError({
        requestId,
        code: "service_unavailable",
        message: "The invite was created but could not be emailed. Issue it again once delivery is restored."
      });
      return Response.json(error.body, {
        status: error.status,
        headers: withRequestId(undefined, requestId)
      });
    }

    // No body: the token is a bearer credential that belongs only in the
    // invitee's mailbox, and echoing it to the inviter would make the
    // link interceptable by anyone who can read this response.
    return new Response(null, { status: 202, headers: withRequestId(undefined, requestId) });
  } catch (error) {
    console.error("invite creation failed", error);
    const apiError = buildApiError({
      requestId,
      code: "internal_error",
      message: "Could not create the invite."
    });
    return Response.json(apiError.body, {
      status: apiError.status,
      headers: withRequestId(undefined, requestId)
    });
  }
}
