import { checkIdempotencyRequirement, generateRequestId, idempotencyErrorResponse, withRequestId } from "@signal-audit/contracts";
import { SESSION_COOKIE_NAME } from "@signal-audit/security";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  INVITE_CONFIRM_COOKIE_NAME,
  INVITE_CONFIRM_COOKIE_OPTIONS,
  SESSION_COOKIE_OPTIONS,
  redeemMagicLinkForSession
} from "../../../../lib/magic-link";
import { captureServerError, withServerOperation } from "../../../../lib/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Single-use regardless of outcome, so nothing is left for this cookie to
 * confirm once an attempt has been made against it. */
function clearInviteConfirmCookie(response: NextResponse): void {
  response.cookies.set(INVITE_CONFIRM_COOKIE_NAME, "", { ...INVITE_CONFIRM_COOKIE_OPTIONS, maxAge: 0 });
}

/**
 * What clicking "Accept invite" on `/auth/confirm` actually does.
 *
 * Separate from `POST /api/auth/magic-link/redeem` rather than a second
 * caller of it, because that route takes the token in its JSON body -- and
 * the token here lives only in the `HttpOnly` cookie `GET /auth/redeem` set
 * (review #88 round 5, REV-002), unreadable by the client script that would
 * otherwise have to put it in that body. This route reads the cookie
 * itself, server-side, and calls the same `redeemMagicLinkForSession` both
 * other entry points share, so there is still exactly one redemption
 * implementation.
 *
 * The browser only ever attaches this cookie to a request under
 * `/auth/confirm` (its scoped path), which is why this route lives there
 * rather than under `/api`.
 */
async function handlePOST(request: NextRequest): Promise<Response> {
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

  const token = request.cookies.get(INVITE_CONFIRM_COOKIE_NAME)?.value;
  if (token === undefined || token.length === 0) {
    return NextResponse.json(
      { error: { code: "expired_confirmation", message: "This confirmation has expired. Open the invite link again." } },
      { status: 410, headers: withRequestId(undefined, requestId) }
    );
  }

  try {
    const redemption = await redeemMagicLinkForSession(token);
    if (redemption.outcome === "invalid") {
      const response = NextResponse.json(
        { error: { code: "unauthorized", message: `Invite link is ${redemption.reason}.` } },
        { status: 401, headers: withRequestId(undefined, requestId) }
      );
      clearInviteConfirmCookie(response);
      return response;
    }
    if (redemption.outcome === "no_account") {
      const response = NextResponse.json(
        { error: { code: "not_found", message: "This invite's account could not be found." } },
        { status: 404, headers: withRequestId(undefined, requestId) }
      );
      clearInviteConfirmCookie(response);
      return response;
    }

    const response = NextResponse.json(
      { userId: redemption.userId },
      { status: 200, headers: withRequestId(undefined, requestId) }
    );
    response.cookies.set(SESSION_COOKIE_NAME, redemption.sessionToken, SESSION_COOKIE_OPTIONS);
    // The invite is spent the moment redemption succeeds; leaving the
    // confirmation cookie set would be a stale credential sitting in the
    // browser for no reason.
    clearInviteConfirmCookie(response);
    return response;
  } catch (error) {
    captureServerError(error, { requestId, operation: "auth.invite_confirm.accept" });
    return NextResponse.json(
      { error: { code: "internal_error", message: "Could not process the request." } },
      { status: 500, headers: withRequestId(undefined, requestId) }
    );
  }
}

export const POST = withServerOperation("auth.invite_confirm.accept", handlePOST);
