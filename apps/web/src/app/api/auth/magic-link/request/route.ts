import {
  buildApiError,
  checkIdempotencyRequirement,
  generateRequestId,
  idempotencyErrorResponse,
  requestMagicLinkInputSchema,
  withRequestId
} from "@signal-audit/contracts";
import { loadEnvironmentConfig } from "@signal-audit/config";
import { createMagicLinkToken, getMembershipsForUser, getUserByEmail } from "@signal-audit/db";
import { createMagicLinkEmailSender, generateMagicLinkToken } from "@signal-audit/security";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Always responds 202 whether or not the email has an account -- the
 * alternative (404 for an unknown email) turns this endpoint into an
 * account-existence oracle. The AF-16 schema this uses is deliberately
 * login-only (see requestMagicLinkInputSchema's own comment): a real
 * onboarding invite is a separate, admin-initiated flow, not something
 * this endpoint accepts from the requester themselves.
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

  const parsed = requestMagicLinkInputSchema.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) {
    const error = buildApiError({
      requestId,
      code: "invalid_request",
      message: "Body must be { email }."
    });
    return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
  }

  try {
    const config = loadEnvironmentConfig(process.env);
    const email = parsed.data.email.toLowerCase();
    const user = await getUserByEmail(config.database.url, config.database.schema, email);
    const memberships =
      user === undefined
        ? []
        : await getMembershipsForUser(config.database.url, config.database.schema, user.userId);
    if (user !== undefined && memberships.length > 0) {
      const generated = generateMagicLinkToken();
      await createMagicLinkToken(config.database.url, config.database.schema, {
        tokenHash: generated.tokenHash,
        email,
        expiresAt: generated.expiresAt
      });
      const link = `${new URL(request.url).origin}/auth/redeem?token=${generated.token}`;
      // The adapter is selected from validated environment configuration,
      // not hardcoded: passing config.appEnv is what makes the
      // hosted-environment guard live. The previous call passed no
      // argument at all, so the sender always believed it was in
      // development and a hosted deployment silently used the console
      // adapter -- storing a valid token that nothing could deliver.
      const emailSender = createMagicLinkEmailSender({
        appEnv: config.appEnv,
        delivery: config.magicLinkEmail
      });
      await emailSender.sendMagicLink({ email, link });
    }
    // Same response regardless of the branch above.
    return new Response(null, { status: 202, headers: withRequestId(undefined, requestId) });
  } catch (error) {
    console.error("magic-link request failed", error);
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
