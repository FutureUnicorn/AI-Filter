import {
  EVIDENCE_EXTRACTION_WORKFLOW_VERSION,
  buildApiError,
  checkIdempotencyRequirement,
  enqueueEvidenceExtractionInputSchema,
  generateRequestId,
  idempotencyErrorResponse,
  withRequestId
} from "@signal-audit/contracts";
import { loadEnvironmentConfig, loadEvidenceExtractionQueueConfig } from "@signal-audit/config";
import {
  enqueueEvidenceExtractionJob,
  getApplicationById,
  getLatestPublishedRubricForRole,
  getMembershipsForUser,
  getRoleById
} from "@signal-audit/db";
import { authorizeResourceAccess, resourceAuthorizationErrorResponse } from "@signal-audit/security";
import type { NextRequest } from "next/server";

import { captureServerError, withServerOperation } from "../../../../../../../lib/observability";
import { readSessionUserId } from "../../../../../../../lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  readonly params: Promise<{ roleId: string; applicationId: string }>;
}

/**
 * The single hosted enqueue boundary. A caller supplies only the already
 * validated source intake; tenant, role, application, canonical-text and
 * published-rubric eligibility are proven before the durable job is created.
 */
async function handlePOST(request: NextRequest, context: RouteContext): Promise<Response> {
  const requestId = generateRequestId();
  const requirement = checkIdempotencyRequirement(request.method, request.headers.get("Idempotency-Key"));
  const idempotencyError = idempotencyErrorResponse(requirement, requestId);
  if (idempotencyError !== undefined) {
    return Response.json(idempotencyError.body, {
      status: idempotencyError.status,
      headers: withRequestId(undefined, requestId)
    });
  }

  const userId = readSessionUserId(request);
  if (userId === undefined) {
    const error = buildApiError({ requestId, code: "unauthorized", message: "Sign in required." });
    return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
  }
  const parsed = enqueueEvidenceExtractionInputSchema.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) {
    const error = buildApiError({
      requestId,
      code: "invalid_request",
      message: parsed.error.issues[0]?.message ?? "Body must contain a sourceIntakeId."
    });
    return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
  }

  const { roleId, applicationId } = await context.params;
  try {
    const config = loadEnvironmentConfig(process.env);
    const queue = loadEvidenceExtractionQueueConfig(process.env);
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
    if (application === undefined || application.roleId !== roleId) {
      const error = buildApiError({ requestId, code: "not_found", message: "Application not found." });
      return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
    }
    const rubric = await getLatestPublishedRubricForRole(config.database.url, config.database.schema, roleId);
    if (rubric === undefined) {
      const error = buildApiError({
        requestId,
        code: "conflict",
        message: "A published rubric is required before evidence extraction can be queued."
      });
      return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
    }
    const outcome = await enqueueEvidenceExtractionJob(config.database.url, config.database.schema, {
      organizationId: role.organizationId,
      roleId,
      applicationId,
      sourceIntakeId: parsed.data.sourceIntakeId,
      rubricId: rubric.rubricId,
      workflowVersion: EVIDENCE_EXTRACTION_WORKFLOW_VERSION,
      maxAttempts: queue.maxAttempts
    });
    if (outcome.outcome === "not_eligible") {
      const error = buildApiError({
        requestId,
        code: "conflict",
        message:
          "The source must be a validated PDF or DOCX with canonical text in the same organization and role."
      });
      return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
    }
    return Response.json(
      { job: outcome.job, replayed: outcome.outcome === "replayed" },
      {
        status: outcome.outcome === "enqueued" ? 201 : 200,
        headers: withRequestId(undefined, requestId)
      }
    );
  } catch (error) {
    captureServerError(error, { requestId, operation: "application.evidence" });
    const apiError = buildApiError({
      requestId,
      code: "internal_error",
      message: "Could not queue evidence extraction."
    });
    return Response.json(apiError.body, {
      status: apiError.status,
      headers: withRequestId(undefined, requestId)
    });
  }
}

export const POST = withServerOperation("application.evidence", handlePOST);
