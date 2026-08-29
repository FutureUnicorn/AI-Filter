import {
  buildApiError,
  generateRequestId,
  recordEvidenceCorrectionInputSchema,
  withRequestId
} from "@signal-audit/contracts";
import { loadEnvironmentConfig } from "@signal-audit/config";
import {
  correctEvidenceOutcome,
  getApplicationById,
  getMembershipsForUser,
  getRoleById
} from "@signal-audit/db";
import { authorizeResourceAccess, resourceAuthorizationErrorResponse } from "@signal-audit/security";
import { readSessionUserId } from "../../../../../../../../../lib/session";
import type { NextRequest } from "next/server";
import type { z } from "zod";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  readonly params: Promise<{ roleId: string; applicationId: string; criterionId: string }>;
}

/**
 * AF-49: record a recruiter's correction. Always an append -- the
 * original AI output is never edited or removed, and the new row names
 * the revision it replaced.
 *
 * `record_decision`, not `review_candidates`: reading the queue and
 * changing what the record says about a candidate are different acts,
 * and AF-17 separates them precisely so the second can be withheld.
 * An auditor holds neither.
 *
 * The correction's outcome is validated against the full EvidenceOutcome
 * contract before it reaches the database, so a correction cannot
 * introduce a shape the pipeline itself could not have produced -- a
 * hand-written outcome is still an outcome.
 *
 * AF-50: the reason is checked with the same predicate 0018 enforces,
 * so "   " is a 400 here rather than a constraint violation surfacing as
 * a 500 later. The actor is never taken from the request at all -- it is
 * the session's own userId, so a caller cannot attribute a correction to
 * someone else, and 0018's membership foreign key means that user must
 * actually belong to the organization whose evidence they are changing.
 */
export async function POST(request: NextRequest, context: RouteContext): Promise<Response> {
  const requestId = generateRequestId();
  const { roleId, applicationId, criterionId } = await context.params;
  const userId = readSessionUserId(request);
  if (userId === undefined) {
    const error = buildApiError({ requestId, code: "unauthorized", message: "Sign in required." });
    return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
  }

  let parsedBody: z.infer<typeof recordEvidenceCorrectionInputSchema>;
  try {
    parsedBody = recordEvidenceCorrectionInputSchema.parse(await request.json());
  } catch {
    const error = buildApiError({
      requestId,
      code: "invalid_request",
      message: "A correction needs a valid evidence outcome and a reason containing at least one non-whitespace character."
    });
    return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
  }

  if (parsedBody.outcome.criterionId !== criterionId) {
    // The path says which criterion is being corrected; a body naming a
    // different one would file the correction against the wrong
    // criterion while looking successful.
    const error = buildApiError({
      requestId,
      code: "invalid_request",
      message: "The outcome's criterionId must match the criterion being corrected."
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
    const authorization = authorizeResourceAccess(memberships, role.organizationId, "record_decision", userId);
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

    const result = await correctEvidenceOutcome(config.database.url, config.database.schema, {
      organizationId: role.organizationId,
      applicationId: application.applicationId,
      criterionId,
      outcome: parsedBody.outcome,
      correctedByUserId: userId,
      reason: parsedBody.reason
    });

    if (result.outcome === "nothing_to_correct") {
      const error = buildApiError({
        requestId,
        code: "conflict",
        message: "There is no recorded evidence for this criterion yet, so there is nothing to correct."
      });
      return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
    }
    if (result.outcome === "superseded") {
      // Losing the race is a 409 and says why: the reviewer's "before"
      // is no longer what they were looking at, so re-reading and
      // re-deciding is the correct next step, not a silent retry.
      const error = buildApiError({
        requestId,
        code: "conflict",
        message: "This criterion was corrected by someone else while you were editing. Reload and check the current evidence."
      });
      return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
    }

    return Response.json(
      {
        evidenceOutcomeId: result.evidenceOutcomeId,
        supersededEvidenceOutcomeId: result.supersededId
      },
      { status: 201, headers: withRequestId(undefined, requestId) }
    );
  } catch (error) {
    console.error("evidence correction failed", error);
    const apiError = buildApiError({
      requestId,
      code: "internal_error",
      message: "Could not record the correction."
    });
    return Response.json(apiError.body, { status: apiError.status, headers: withRequestId(undefined, requestId) });
  }
}
