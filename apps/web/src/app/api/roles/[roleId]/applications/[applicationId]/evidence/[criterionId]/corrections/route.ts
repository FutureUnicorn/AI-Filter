import {
  buildApiError,
  checkIdempotencyRequirement,
  generateRequestId,
  idempotencyErrorResponse,
  recordEvidenceCorrectionInputSchema,
  withRequestId
} from "@signal-audit/contracts";
import { loadEnvironmentConfig } from "@signal-audit/config";
import {
  claimIdempotentRequest,
  completeIdempotentRequest,
  correctEvidenceOutcome,
  getApplicationById,
  getMembershipsForUser,
  getRoleById,
  releaseIdempotentRequest
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

  // Review #83, P2, the same gap as the decision endpoint. Corrections are
  // append-only, so a retry after a lost response does not overwrite -- it
  // records a SECOND correction superseding the first, changing the evidence
  // history with a correction no reviewer made.
  const idempotency = checkIdempotencyRequirement(request.method, request.headers.get("Idempotency-Key"));
  const idempotencyError = idempotencyErrorResponse(idempotency, requestId);
  if (idempotencyError !== undefined) {
    return Response.json(idempotencyError.body, {
      status: idempotencyError.status,
      headers: withRequestId(undefined, requestId)
    });
  }
  const idempotencyKey = idempotency.required && idempotency.outcome === "present" ? idempotency.key : undefined;
  if (idempotencyKey === undefined) {
    const error = buildApiError({ requestId, code: "invalid_request", message: "Idempotency-Key is required." });
    return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
  }
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

    // Claimed after authorization, and scoped by organization, so a key can
    // neither be consumed nor probed across tenants.
    const claim = await claimIdempotentRequest(config.database.url, config.database.schema, {
      organizationId: role.organizationId,
      endpoint: "evidence_corrections.record",
      idempotencyKey,
      payload: { applicationId: application.applicationId, criterionId, ...parsedBody }
    });
    if (claim.outcome === "replay") {
      return Response.json(claim.body, { status: claim.status, headers: withRequestId(undefined, requestId) });
    }
    if (claim.outcome === "fingerprint_mismatch") {
      const error = buildApiError({
        requestId,
        code: "conflict",
        message: "This Idempotency-Key was already used with a different request body."
      });
      return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
    }
    if (claim.outcome === "in_flight") {
      const error = buildApiError({
        requestId,
        code: "conflict",
        message: "A request with this Idempotency-Key is still in progress."
      });
      return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
    }

    let result;
    try {
      result = await correctEvidenceOutcome(config.database.url, config.database.schema, {
        organizationId: role.organizationId,
        applicationId: application.applicationId,
        criterionId,
        outcome: parsedBody.outcome,
        correctedByUserId: userId,
        reason: parsedBody.reason
      });
    } catch (error) {
      await releaseIdempotentRequest(config.database.url, config.database.schema, claim.requestId);
      throw error;
    }

    if (result.outcome === "nothing_to_correct") {
      await releaseIdempotentRequest(config.database.url, config.database.schema, claim.requestId);
      const error = buildApiError({
        requestId,
        code: "conflict",
        message: "There is no recorded evidence for this criterion yet, so there is nothing to correct."
      });
      return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
    }
    if (result.outcome === "superseded") {
      await releaseIdempotentRequest(config.database.url, config.database.schema, claim.requestId);
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

    const body = {
      evidenceOutcomeId: result.evidenceOutcomeId,
      supersededEvidenceOutcomeId: result.supersededId
    };
    await completeIdempotentRequest(config.database.url, config.database.schema, claim.requestId, 201, body);
    return Response.json(body, { status: 201, headers: withRequestId(undefined, requestId) });
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
