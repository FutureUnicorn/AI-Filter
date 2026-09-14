import {
  buildApiError,
  checkIdempotencyRequirement,
  generateRequestId,
  idempotencyErrorResponse,
  requestFileUploadInputSchema,
  withRequestId
} from "@signal-audit/contracts";
import { loadEnvironmentConfig } from "@signal-audit/config";
import { createFileIntake, getMembershipsForUser, getRoleById } from "@signal-audit/db";
import { createPresignedUploadUrl } from "@signal-audit/ingestion";
import { authorizeResourceAccess, resourceAuthorizationErrorResponse } from "@signal-audit/security";
import { readSessionUserId } from "../../../../../lib/session";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  readonly params: Promise<{ roleId: string }>;
}

/**
 * AF-28: mints a one-use (see packages/ingestion's own comment on what
 * "one-use" actually means here), short-lived signed PUT URL under a
 * quarantine-prefixed key -- the browser uploads straight to storage,
 * the file bytes never transit this route handler. The intake row this
 * creates starts 'pending'; nothing downstream (AF-29's validation, AF-
 * 30's parser) will look at the object until the browser calls the
 * .../complete endpoint and AF-29 has had a chance to inspect it.
 */
export async function POST(request: NextRequest, context: RouteContext): Promise<Response> {
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

  const { roleId } = await context.params;
  const userId = readSessionUserId(request);
  if (userId === undefined) {
    const error = buildApiError({ requestId, code: "unauthorized", message: "Sign in required." });
    return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
  }

  const parsed = requestFileUploadInputSchema.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) {
    const error = buildApiError({
      requestId,
      code: "invalid_request",
      message: parsed.error.issues[0]?.message ?? "Body must be { declaredFilename, declaredMimeType }."
    });
    return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
  }

  try {
    const config = loadEnvironmentConfig(process.env);
    const role = await getRoleById(config.database.url, config.database.schema, roleId);
    if (role === undefined) {
      const error = buildApiError({ requestId, code: "not_found", message: "Role not found." });
      return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
    }

    const memberships = await getMembershipsForUser(config.database.url, config.database.schema, userId);
    const authorization = authorizeResourceAccess(memberships, role.organizationId, "manage_roles", userId);
    const authError = resourceAuthorizationErrorResponse(authorization, requestId);
    if (authError !== undefined) {
      return Response.json(authError.body, {
        status: authError.status,
        headers: withRequestId(undefined, requestId)
      });
    }

    const intake = await createFileIntake(config.database.url, config.database.schema, {
      organizationId: role.organizationId,
      roleId,
      // Keyed by the intake's own id, not the client-declared filename: two
      // uploads of "resume.pdf" for the same role must never collide.
      storageKey: `quarantine/${role.organizationId}/${roleId}/pending/${crypto.randomUUID()}-${parsed.data.declaredFilename}`,
      declaredFilename: parsed.data.declaredFilename,
      declaredMimeType: parsed.data.declaredMimeType,
      createdByUserId: userId
    });

    const uploadUrl = await createPresignedUploadUrl(config.storage, intake.storageKey, parsed.data.declaredMimeType);

    return Response.json(
      { intakeId: intake.intakeId, storageKey: intake.storageKey, uploadUrl },
      { status: 201, headers: withRequestId(undefined, requestId) }
    );
  } catch (error) {
    console.error("file upload request failed", error);
    const apiError = buildApiError({
      requestId,
      code: "internal_error",
      message: "Could not create an upload URL."
    });
    return Response.json(apiError.body, { status: apiError.status, headers: withRequestId(undefined, requestId) });
  }
}
