import {
  buildApiError,
  checkIdempotencyRequirement,
  createInviteInputSchema,
  generateRequestId,
  idempotencyErrorResponse,
  withRequestId
} from "@signal-audit/contracts";
import { loadEnvironmentConfig } from "@signal-audit/config";
import { createInviteMagicLinkToken, getMembershipsForUser } from "@signal-audit/db";
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
  const idempotency = idempotencyErrorResponse(
    checkIdempotencyRequirement(request.method, request.headers.get("Idempotency-Key")),
    requestId
  );
  if (idempotency !== undefined) {
    return Response.json(idempotency.body, {
      status: idempotency.status,
      headers: withRequestId(undefined, requestId)
    });
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

    const generated = generateMagicLinkToken();
    await createInviteMagicLinkToken(config.database.url, config.database.schema, {
      tokenHash: generated.tokenHash,
      email: parsed.data.email,
      invite: { organizationId: parsed.data.organizationId, role: parsed.data.role },
      expiresAt: generated.expiresAt,
      audit: { actorUserId: userId, requestId }
    });

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
      await emailSender.sendMagicLink({ email: parsed.data.email, link });
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
