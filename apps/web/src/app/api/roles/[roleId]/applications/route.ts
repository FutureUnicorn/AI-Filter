import { buildApiError, generateRequestId, withRequestId } from "@signal-audit/contracts";
import { loadEnvironmentConfig } from "@signal-audit/config";
import {
  getMembershipsForUser,
  getRoleById,
  listApplicationsForRole,
  listEvidenceExtractionRunsForEntities
} from "@signal-audit/db";
import { APPLICATION_ENTITY_TYPE, buildApplicationReviewQueue } from "@signal-audit/domain";
import { authorizeResourceAccess, resourceAuthorizationErrorResponse } from "@signal-audit/security";
import { readSessionUserId } from "../../../../../lib/session";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  readonly params: Promise<{ roleId: string }>;
}

/**
 * AF-45: the recruiter's review queue for one role.
 *
 * Capability is `review_candidates`, not the `manage_roles` the intake
 * and rubric routes use. That is the whole point of AF-17's capability
 * split rather than a role check: an auditor holds `view_audit_reports`
 * and nothing else, and the queue is where a human makes attributable
 * employment decisions -- explicitly not what an auditor is for.
 *
 * The role is resolved first so authorization runs against the role's
 * own organizationId, never one supplied by the caller. An unknown role
 * and a sibling tenant's role return the identical 404, so this cannot
 * be used to probe which role IDs exist elsewhere (AF-19's rule, and
 * why authorizeResourceAccess maps no_membership to 404, not 403).
 */
export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  const requestId = generateRequestId();
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
    const authorization = authorizeResourceAccess(memberships, role.organizationId, "review_candidates", userId);
    const authError = resourceAuthorizationErrorResponse(authorization, requestId);
    if (authError !== undefined) {
      return Response.json(authError.body, {
        status: authError.status,
        headers: withRequestId(undefined, requestId)
      });
    }

    const applications = await listApplicationsForRole(
      config.database.url,
      config.database.schema,
      role.organizationId,
      role.roleId
    );
    const runs = await listEvidenceExtractionRunsForEntities(
      config.database.url,
      config.database.schema,
      role.organizationId,
      APPLICATION_ENTITY_TYPE,
      applications.map((application) => application.applicationId)
    );

    return Response.json(buildApplicationReviewQueue(role.roleId, applications, runs), {
      status: 200,
      headers: withRequestId(undefined, requestId)
    });
  } catch (error) {
    console.error("application review queue lookup failed", error);
    const apiError = buildApiError({
      requestId,
      code: "internal_error",
      message: "Could not load the review queue."
    });
    return Response.json(apiError.body, { status: apiError.status, headers: withRequestId(undefined, requestId) });
  }
}
