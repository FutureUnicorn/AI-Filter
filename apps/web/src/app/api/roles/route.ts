import {
  buildApiError,
  checkIdempotencyRequirement,
  createRoleInputSchema,
  generateRequestId,
  idempotencyErrorResponse,
  listRolesQuerySchema,
  withRequestId
} from "@signal-audit/contracts";
import { loadEnvironmentConfig } from "@signal-audit/config";
import { createRole, getMembershipsForUser, listRolesForOrganization } from "@signal-audit/db";
import { EMPTY_ROLE_PIPELINE_COUNTS, toRoleListItem } from "@signal-audit/domain";
import { authorizeResourceAccess, resourceAuthorizationErrorResponse } from "@signal-audit/security";
import { readSessionUserId } from "../../../lib/session";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * organizationId always comes from the request body (createRoleInputSchema),
 * never inferred -- and is only ever trusted after authorizeResourceAccess
 * checks it against memberships fetched here, server-side, for the
 * session's own userId. See AF-19's own comment on that function for why
 * a client-supplied organizationId is never enough on its own.
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

  const parsed = createRoleInputSchema.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) {
    const error = buildApiError({
      requestId,
      code: "invalid_request",
      message: "Body must be { organizationId, title }."
    });
    return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
  }

  try {
    const config = loadEnvironmentConfig(process.env);
    const memberships = await getMembershipsForUser(config.database.url, config.database.schema, userId);
    const authorization = authorizeResourceAccess(memberships, parsed.data.organizationId, "manage_roles");
    const authError = resourceAuthorizationErrorResponse(authorization, requestId);
    if (authError !== undefined) {
      return Response.json(authError.body, {
        status: authError.status,
        headers: withRequestId(undefined, requestId)
      });
    }

    const role = await createRole(config.database.url, config.database.schema, {
      organizationId: parsed.data.organizationId,
      title: parsed.data.title,
      createdByUserId: userId
    });
    return Response.json(role, { status: 201, headers: withRequestId(undefined, requestId) });
  } catch (error) {
    console.error("role creation failed", error);
    const apiError = buildApiError({
      requestId,
      code: "internal_error",
      message: "Could not create the role."
    });
    return Response.json(apiError.body, {
      status: apiError.status,
      headers: withRequestId(undefined, requestId)
    });
  }
}

/**
 * Recruiter working-home list. Read-gated on review_candidates (not
 * manage_roles): an auditor still cannot see this, a recruiter can.
 * Rubric/import facts are derived placeholders until AF-25/27/32 exist
 * -- every row currently reports rubricApprovalState "none" and empty
 * counts, which is the honest current state, not a fake approved rubric.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const requestId = generateRequestId();
  const userId = readSessionUserId(request);
  if (userId === undefined) {
    const error = buildApiError({ requestId, code: "unauthorized", message: "Sign in required." });
    return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
  }

  const parsed = listRolesQuerySchema.safeParse({
    organizationId: request.nextUrl.searchParams.get("organizationId") ?? undefined
  });
  if (!parsed.success) {
    const error = buildApiError({
      requestId,
      code: "invalid_request",
      message: "Query must include organizationId."
    });
    return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
  }

  try {
    const config = loadEnvironmentConfig(process.env);
    const memberships = await getMembershipsForUser(config.database.url, config.database.schema, userId);
    const authorization = authorizeResourceAccess(memberships, parsed.data.organizationId, "review_candidates");
    const authError = resourceAuthorizationErrorResponse(authorization, requestId);
    if (authError !== undefined) {
      return Response.json(authError.body, {
        status: authError.status,
        headers: withRequestId(undefined, requestId)
      });
    }

    const roles = await listRolesForOrganization(
      config.database.url,
      config.database.schema,
      parsed.data.organizationId
    );
    return Response.json(
      {
        roles: roles.map((role) => toRoleListItem(role, EMPTY_ROLE_PIPELINE_COUNTS, "none"))
      },
      { status: 200, headers: withRequestId(undefined, requestId) }
    );
  } catch (error) {
    console.error("role list failed", error);
    const apiError = buildApiError({
      requestId,
      code: "internal_error",
      message: "Could not list roles."
    });
    return Response.json(apiError.body, {
      status: apiError.status,
      headers: withRequestId(undefined, requestId)
    });
  }
}
