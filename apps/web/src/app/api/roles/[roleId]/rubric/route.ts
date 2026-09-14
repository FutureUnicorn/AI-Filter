import {
  buildApiError,
  checkIdempotencyRequirement,
  generateRequestId,
  idempotencyErrorResponse,
  upsertRubricDraftInputSchema,
  withRequestId
} from "@signal-audit/contracts";
import { loadEnvironmentConfig } from "@signal-audit/config";
import { getMembershipsForUser, getRoleById, getRubricForRole, upsertDraftRubric } from "@signal-audit/db";
import { authorizeResourceAccess, resourceAuthorizationErrorResponse } from "@signal-audit/security";
import { readSessionUserId } from "../../../../../lib/session";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  readonly params: Promise<{ roleId: string }>;
}

/**
 * AF-25: rubric draft/edit, scoped through the role it belongs to. A
 * rubric has no organization_id of its own (migration 0010) -- the role
 * is the tenant boundary, so authorization always resolves roleId ->
 * the role's organizationId first, the same "never trust a client-
 * supplied id alone" rule AF-19 established for every other resource.
 */
async function authorizeForRole(
  request: NextRequest,
  requestId: string,
  roleId: string
): Promise<{ readonly organizationId: string } | { readonly errorResponse: Response }> {
  const userId = readSessionUserId(request);
  if (userId === undefined) {
    const error = buildApiError({ requestId, code: "unauthorized", message: "Sign in required." });
    return {
      errorResponse: Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) })
    };
  }

  const config = loadEnvironmentConfig(process.env);
  const role = await getRoleById(config.database.url, config.database.schema, roleId);
  if (role === undefined) {
    const error = buildApiError({ requestId, code: "not_found", message: "Role not found." });
    return {
      errorResponse: Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) })
    };
  }

  const memberships = await getMembershipsForUser(config.database.url, config.database.schema, userId);
  const authorization = authorizeResourceAccess(memberships, role.organizationId, "manage_roles", userId);
  const authError = resourceAuthorizationErrorResponse(authorization, requestId);
  if (authError !== undefined) {
    return {
      errorResponse: Response.json(authError.body, {
        status: authError.status,
        headers: withRequestId(undefined, requestId)
      })
    };
  }
  return { organizationId: role.organizationId };
}

export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  const requestId = generateRequestId();
  const { roleId } = await context.params;

  const authorized = await authorizeForRole(request, requestId, roleId);
  if ("errorResponse" in authorized) {
    return authorized.errorResponse;
  }

  try {
    const config = loadEnvironmentConfig(process.env);
    const rubric = await getRubricForRole(config.database.url, config.database.schema, roleId);
    if (rubric === undefined) {
      const error = buildApiError({ requestId, code: "not_found", message: "No rubric exists for this role yet." });
      return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
    }
    return Response.json(rubric, { status: 200, headers: withRequestId(undefined, requestId) });
  } catch (error) {
    console.error("rubric fetch failed", error);
    const apiError = buildApiError({ requestId, code: "internal_error", message: "Could not fetch the rubric." });
    return Response.json(apiError.body, { status: apiError.status, headers: withRequestId(undefined, requestId) });
  }
}

/**
 * PUT, not PATCH: the whole criteria list is replaced every time, never
 * merged field-by-field -- a client that wants to change one criterion
 * still sends the complete 5-10 item array. Only ever touches a draft;
 * see packages/db's upsertDraftRubric for why a published rubric is
 * structurally unreachable from this endpoint (AF-27's problem, not this
 * one's).
 */
export async function PUT(request: NextRequest, context: RouteContext): Promise<Response> {
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
  const authorized = await authorizeForRole(request, requestId, roleId);
  if ("errorResponse" in authorized) {
    return authorized.errorResponse;
  }

  const parsed = upsertRubricDraftInputSchema.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) {
    const error = buildApiError({
      requestId,
      code: "invalid_request",
      message: "Body must be { criteria }, 5 to 10 items."
    });
    return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
  }

  try {
    const config = loadEnvironmentConfig(process.env);
    const outcome = await upsertDraftRubric(config.database.url, config.database.schema, roleId, parsed.data.criteria);
    if (outcome.outcome === "no_such_role") {
      const error = buildApiError({ requestId, code: "not_found", message: "Role not found." });
      return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
    }
    return Response.json(outcome.rubric, { status: 200, headers: withRequestId(undefined, requestId) });
  } catch (error) {
    console.error("rubric draft save failed", error);
    const apiError = buildApiError({ requestId, code: "internal_error", message: "Could not save the rubric." });
    return Response.json(apiError.body, { status: apiError.status, headers: withRequestId(undefined, requestId) });
  }
}
