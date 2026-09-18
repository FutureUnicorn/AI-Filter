import {
  buildApiError,
  checkIdempotencyRequirement,
  generateRequestId,
  idempotencyErrorResponse,
  withRequestId
} from "@signal-audit/contracts";
import { SESSION_COOKIE_NAME } from "@signal-audit/security";
import { z } from "zod";
import { SESSION_COOKIE_OPTIONS, redeemMagicLinkForSession } from "../../../../../lib/magic-link";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const redeemInputSchema = z.strictObject({ token: z.string().min(1) });

/**
 * redeemMagicLinkToken already provisions the user + membership for an
 * invite token (packages/db's provisionInvitedMembership, inside the
 * same transaction as consuming it) -- this route only ever reads the
 * result back with getUserByEmail, for both the login and invite case.
 * It must not provision again itself: an earlier version of this route
 * called a second, separate provisioning function after redemption,
 * which ran the same two inserts twice per invite redemption against
 * two different connections. Redeeming the same invite again would
 * already fail earlier, at the atomic redeemMagicLinkToken step
 * (already_consumed), before this code runs.
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

  const parsed = redeemInputSchema.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) {
    const error = buildApiError({ requestId, code: "invalid_request", message: "Body must be { token }." });
    return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
  }

  try {
    // Shared with GET /auth/redeem, the URL the email actually contains, so
    // the two entry points cannot drift about what redemption means.
    const redemption = await redeemMagicLinkForSession(parsed.data.token);
    if (redemption.outcome === "invalid") {
      const error = buildApiError({
        requestId,
        code: "unauthorized",
        message: `Magic link is ${redemption.reason}.`
      });
      return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
    }
    if (redemption.outcome === "no_account") {
      const error = buildApiError({
        requestId,
        code: "not_found",
        message: "This email has no account yet. Ask an admin to invite you."
      });
      return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
    }

    const response = NextResponse.json(
      { schemaVersion: redemption.schemaVersion, userId: redemption.userId, email: redemption.email },
      { status: 200, headers: withRequestId(undefined, requestId) }
    );
    response.cookies.set(SESSION_COOKIE_NAME, redemption.sessionToken, SESSION_COOKIE_OPTIONS);
    return response;
  } catch (error) {
    console.error("magic-link redeem failed", error);
    const apiError = buildApiError({
      requestId,
      code: "internal_error",
      message: "Could not process the request."
    });
    return Response.json(apiError.body, {
      status: apiError.status,
      headers: withRequestId(undefined, requestId)
    });
  }
}
