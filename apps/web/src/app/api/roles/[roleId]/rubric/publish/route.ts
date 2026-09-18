import {
  buildApiError,
  checkIdempotencyRequirement,
  generateRequestId,
  idempotencyErrorResponse,
  withRequestId
} from "@signal-audit/contracts";
import { loadEnvironmentConfig } from "@signal-audit/config";
import { getMembershipsForUser, getRoleById, getRubricForRole, publishRubric } from "@signal-audit/db";
import { authorizeResourceAccess, resourceAuthorizationErrorResponse } from "@signal-audit/security";
import { readSessionUserId } from "../../../../../../lib/session";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  readonly params: Promise<{ roleId: string }>;
}

/**
 * AF-27: a named human approves and freezes the role's current draft
 * rubric. Gated on approve_rubric, not manage_roles -- narrower than who
 * may draft/edit a rubric (AF-25/26), matching "a named human approves"
 * naming a more deliberate act than day-to-day editing. approvedByUserId
 * is always the session's own userId, never client-supplied: the name
 * behind the approval has to be the person who actually made the call.
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

  try {
    const config = loadEnvironmentConfig(process.env);
    const role = await getRoleById(config.database.url, config.database.schema, roleId);
    if (role === undefined) {
      const error = buildApiError({ requestId, code: "not_found", message: "Role not found." });
      return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
    }

    const memberships = await getMembershipsForUser(config.database.url, config.database.schema, userId);
    const authorization = authorizeResourceAccess(memberships, role.organizationId, "approve_rubric", userId);
    const authError = resourceAuthorizationErrorResponse(authorization, requestId);
    if (authError !== undefined) {
      return Response.json(authError.body, {
        status: authError.status,
        headers: withRequestId(undefined, requestId)
      });
    }

    const current = await getRubricForRole(config.database.url, config.database.schema, roleId);
    if (current === undefined || current.status !== "draft") {
      const error = buildApiError({
        requestId,
        code: "conflict",
        message: "This role has no draft rubric to publish."
      });
      return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
    }

    const outcome = await publishRubric(config.database.url, config.database.schema, current.rubricId, userId);
    if (outcome.outcome === "no_draft") {
      const error = buildApiError({
        requestId,
        code: "conflict",
        message: "This rubric is no longer a draft -- someone else may have just published it."
      });
      return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
    }
    return Response.json(outcome.rubric, { status: 200, headers: withRequestId(undefined, requestId) });
  } catch (error) {
    console.error("rubric publish failed", error);
    const apiError = buildApiError({ requestId, code: "internal_error", message: "Could not publish the rubric." });
    return Response.json(apiError.body, { status: apiError.status, headers: withRequestId(undefined, requestId) });
  }
}
