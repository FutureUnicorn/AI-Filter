import {
  buildApiError,
  checkIdempotencyRequirement,
  generateRequestId,
  idempotencyErrorResponse,
  withRequestId
} from "@signal-audit/contracts";
import { loadEnvironmentConfig } from "@signal-audit/config";
import { getUserByEmail, redeemMagicLinkToken } from "@signal-audit/db";
import {
  SESSION_COOKIE_NAME,
  createSessionToken,
  hashMagicLinkToken,
  verifyMagicLinkToken
} from "@signal-audit/security";
import { z } from "zod";
import { readSessionSecret } from "../../../../../lib/session";
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
    const config = loadEnvironmentConfig(process.env);
    const attempt = await redeemMagicLinkToken(
      config.database.url,
      config.database.schema,
      hashMagicLinkToken(parsed.data.token)
    );
    const verification = verifyMagicLinkToken(attempt);
    if (verification.outcome !== "valid") {
      const error = buildApiError({
        requestId,
        code: "unauthorized",
        message: `Magic link is ${verification.outcome.replace("_", " ")}.`
      });
      return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
    }

    const user = await getUserByEmail(config.database.url, config.database.schema, verification.email);
    if (user === undefined) {
      const error = buildApiError({
        requestId,
        code: "not_found",
        message: "This email has no account yet. Ask an admin to invite you."
      });
      return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
    }

    const sessionToken = createSessionToken(user.userId, readSessionSecret());
    const response = NextResponse.json(
      { schemaVersion: user.schemaVersion, userId: user.userId, email: user.email },
      { status: 200, headers: withRequestId(undefined, requestId) }
    );
    response.cookies.set(SESSION_COOKIE_NAME, sessionToken, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 12 * 60 * 60
    });
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
