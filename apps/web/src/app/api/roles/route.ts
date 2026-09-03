import {
  buildApiError,
  checkIdempotencyRequirement,
  createRoleInputSchema,
  generateRequestId,
  idempotencyErrorResponse,
  withRequestId
} from "@signal-audit/contracts";
import { loadEnvironmentConfig } from "@signal-audit/config";
import { createRole, getMembershipsForUser, listRolesForOrganization } from "@signal-audit/db";
import { authorizeResourceAccess, resourceAuthorizationErrorResponse } from "@signal-audit/security";
import { z } from "zod";
import { readSessionUserId } from "../../../lib/session";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * AF-24: the recruiter working-home view for an organization's roles.
 * organizationId is a query param, not a path segment -- this list is
 * the same "which org am I acting as" shape every route here uses,
 * always re-authorized server-side, never trusted from the request alone.
 *
 * The ticket also asks for rubric approval state and import readiness
 * per role. Neither exists yet (AF-27 publishes rubrics, AF-32 finalizes
 * imports) -- returning fabricated placeholder values in the API would
 * just be a breaking change waiting to happen once those tickets land.
 * This returns real Role fields only; the UI renders an honest
 * "not available yet" for the other two columns.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const requestId = generateRequestId();
  const userId = readSessionUserId(request);
  if (userId === undefined) {
    const error = buildApiError({ requestId, code: "unauthorized", message: "Sign in required." });
    return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
  }

  const organizationId = new URL(request.url).searchParams.get("organizationId");
  const parsedOrgId = organizationId === null ? undefined : z.uuid().safeParse(organizationId);
  if (parsedOrgId === undefined || !parsedOrgId.success) {
    const error = buildApiError({
      requestId,
      code: "invalid_request",
      message: "Query must include a valid organizationId."
    });
    return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
  }

  try {
    const config = loadEnvironmentConfig(process.env);
    const memberships = await getMembershipsForUser(config.database.url, config.database.schema, userId);
    const authorization = authorizeResourceAccess(memberships, parsedOrgId.data, "manage_roles", userId);
    const authError = resourceAuthorizationErrorResponse(authorization, requestId);
    if (authError !== undefined) {
      return Response.json(authError.body, {
        status: authError.status,
        headers: withRequestId(undefined, requestId)
      });
    }

    const roles = await listRolesForOrganization(config.database.url, config.database.schema, parsedOrgId.data);
    return Response.json({ roles }, { status: 200, headers: withRequestId(undefined, requestId) });
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
    const authorization = authorizeResourceAccess(memberships, parsed.data.organizationId, "manage_roles", userId);
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
