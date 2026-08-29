import { buildApiError, generateRequestId, withRequestId } from "@signal-audit/contracts";
import { loadEnvironmentConfig } from "@signal-audit/config";
import {
  getApplicationById,
  getMembershipsForUser,
  getRoleById,
  getRubricForRole,
  listEvidenceRevisionsForApplication
} from "@signal-audit/db";
import { buildCorrectedEvidenceCardSet } from "@signal-audit/domain";
import { authorizeResourceAccess, resourceAuthorizationErrorResponse } from "@signal-audit/security";
import { readSessionUserId } from "../../../../../../../lib/session";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  readonly params: Promise<{ roleId: string; applicationId: string }>;
}

/**
 * AF-48: the evidence cards for one application -- criterion, state,
 * exact quote and source.
 *
 * Three lookups before any evidence is read, and the order matters. The
 * role resolves the organization (never the caller's word for it), the
 * caller is authorized against that organization, and only then is the
 * application confirmed to belong to that same organization AND that
 * role. An application id from a sibling tenant, or a real application
 * under a different role of the same tenant, both return the identical
 * 404 -- so neither can be used to probe what exists elsewhere.
 *
 * Cards come back in rubric order, and a criterion with nothing recorded
 * is reported rather than omitted. A review screen that silently drops a
 * criterion tells a recruiter the rubric was smaller than it is.
 */
export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  const requestId = generateRequestId();
  const { roleId, applicationId } = await context.params;
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

    const application = await getApplicationById(
      config.database.url,
      config.database.schema,
      role.organizationId,
      applicationId
    );
    if (application === undefined || application.roleId !== role.roleId) {
      const error = buildApiError({ requestId, code: "not_found", message: "Application not found." });
      return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
    }

    const rubric = await getRubricForRole(config.database.url, config.database.schema, role.roleId);
    if (rubric === undefined) {
      const error = buildApiError({
        requestId,
        code: "conflict",
        message: "This role has no rubric yet, so there are no criteria to show evidence against."
      });
      return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
    }

    // AF-49: the full revision history, not just the current outcome.
    // A card has to be able to show what it was corrected from, and a
    // caller holding only the current value cannot reconstruct that.
    const revisions = await listEvidenceRevisionsForApplication(
      config.database.url,
      config.database.schema,
      role.organizationId,
      application.applicationId
    );

    return Response.json(
      buildCorrectedEvidenceCardSet(
        application.applicationId,
        rubric.criteria.map((criterion) => criterion.criterionId),
        revisions
      ),
      { status: 200, headers: withRequestId(undefined, requestId) }
    );
  } catch (error) {
    console.error("evidence card lookup failed", error);
    const apiError = buildApiError({
      requestId,
      code: "internal_error",
      message: "Could not load evidence for this application."
    });
    return Response.json(apiError.body, { status: apiError.status, headers: withRequestId(undefined, requestId) });
  }
}
