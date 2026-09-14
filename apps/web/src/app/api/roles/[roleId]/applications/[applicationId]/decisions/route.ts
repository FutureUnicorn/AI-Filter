import {
  buildApiError,
  checkIdempotencyRequirement,
  generateRequestId,
  idempotencyErrorResponse,
  recordCandidateDecisionInputSchema,
  withRequestId
} from "@signal-audit/contracts";
import { loadEnvironmentConfig } from "@signal-audit/config";
import {
  claimIdempotentRequest,
  completeIdempotentRequest,
  getApplicationById,
  getMembershipsForUser,
  getRoleById,
  listCandidateDecisionsForApplication,
  recordCandidateDecision,
  releaseIdempotentRequest
} from "@signal-audit/db";
import { deriveCandidateWorkflowStatus } from "@signal-audit/domain";
import { authorizeResourceAccess, resourceAuthorizationErrorResponse } from "@signal-audit/security";
import { readSessionUserId } from "../../../../../../../lib/session";
import type { NextRequest } from "next/server";
import type { z } from "zod";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  readonly params: Promise<{ roleId: string; applicationId: string }>;
}

/**
 * AF-51: the only endpoint that changes a candidate's workflow status.
 *
 * "The model has no path to this endpoint" is enforced by three things
 * that hold together rather than by a rule anyone has to follow:
 *
 *   1. The actor is `readSessionUserId(request)` and nothing else. There
 *      is no field in the request body naming a decider -- see
 *      recordCandidateDecisionInputSchema, which is a strictObject, so
 *      sending one is a 400 rather than an ignored extra.
 *   2. That user must hold `record_decision` in the organization, which
 *      an auditor does not have and a machine caller has no membership
 *      to hold at all.
 *   3. packages/ai cannot reach packages/db: the workspace dependency
 *      rule permits ai -> contracts and domain only, checked by
 *      tests/architecture. So the inference layer has no in-process
 *      route to the recorder either, not merely no reason to use it.
 *
 * There is deliberately no PATCH or PUT. A decision is appended and the
 * previous one is superseded, never edited -- 0019's trigger rejects
 * UPDATE outright -- so "change the status" and "record a new decision"
 * are the same operation, which is what makes the log the only source.
 */
export async function POST(request: NextRequest, context: RouteContext): Promise<Response> {
  const requestId = generateRequestId();
  const { roleId, applicationId } = await context.params;

  // Review #83, P2. MUTATING_HTTP_METHODS requires a key for every POST, and
  // this endpoint neither required nor replayed one. A retry after a lost 201
  // recorded a SECOND decision that superseded the first: not a duplicate
  // delivery, a fabricated human decision that the supersede chain then
  // presents as current.
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

  const userId = readSessionUserId(request);
  if (userId === undefined) {
    const error = buildApiError({ requestId, code: "unauthorized", message: "Sign in required." });
    return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
  }

  let parsedBody: z.infer<typeof recordCandidateDecisionInputSchema>;
  try {
    parsedBody = recordCandidateDecisionInputSchema.parse(await request.json());
  } catch {
    const error = buildApiError({
      requestId,
      code: "invalid_request",
      message:
        "A decision must be advance, hold or decline, with a rationale containing at least one non-whitespace character."
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

    // Claimed after authorization, so an unauthorized caller cannot consume
    // or probe a key, and scoped by organization so one tenant's keys are
    // invisible to another.
    const claim = await claimIdempotentRequest(config.database.url, config.database.schema, {
      organizationId: role.organizationId,
      endpoint: "candidate_decisions.record",
      idempotencyKey,
      payload: { applicationId: application.applicationId, ...parsedBody }
    });
    if (claim.outcome === "replay") {
      // The original response, verbatim. A fresh 201 here would be
      // indistinguishable from having recorded a second decision.
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
      result = await recordCandidateDecision(config.database.url, config.database.schema, {
        organizationId: role.organizationId,
        applicationId: application.applicationId,
        decision: parsedBody.decision,
        rationale: parsedBody.rationale,
        decidedByUserId: userId
      });
    } catch (error) {
      // Release on failure so the client can retry the same key rather than
      // being locked out permanently by a transient fault.
      await releaseIdempotentRequest(config.database.url, config.database.schema, claim.requestId);
      throw error;
    }

    if (result.outcome === "superseded") {
      await releaseIdempotentRequest(config.database.url, config.database.schema, claim.requestId);
      const error = buildApiError({
        requestId,
        code: "conflict",
        message: "Someone else recorded a decision while you were deciding. Reload and check the current status."
      });
      return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
    }

    // Added with the per-application lock (review #83): serializing on the
    // parent applications row means the writer can now discover that the row
    // is absent for this organization. Reported as not_found rather than
    // forbidden, the same way resource authorization treats an organization
    // the caller has no membership for, so this cannot be used to probe
    // whether an application id exists in another tenant.
    if (result.outcome === "no_such_application") {
      await releaseIdempotentRequest(config.database.url, config.database.schema, claim.requestId);
      const error = buildApiError({
        requestId,
        code: "not_found",
        message: "No such application for this organization."
      });
      return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
    }

    const body = {
      decisionId: result.decisionId,
      ...(result.supersededId === undefined ? {} : { supersededDecisionId: result.supersededId })
    };
    await completeIdempotentRequest(config.database.url, config.database.schema, claim.requestId, 201, body);
    return Response.json(body, { status: 201, headers: withRequestId(undefined, requestId) });
  } catch (error) {
    console.error("recording a candidate decision failed", error);
    const apiError = buildApiError({ requestId, code: "internal_error", message: "Could not record the decision." });
    return Response.json(apiError.body, { status: apiError.status, headers: withRequestId(undefined, requestId) });
  }
}

/** The current status plus the full decision history behind it. */
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
    // Reading a status is a review action, not a decision-making one, so
    // this is the weaker capability of the two on purpose.
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

    const decisions = await listCandidateDecisionsForApplication(
      config.database.url,
      config.database.schema,
      role.organizationId,
      application.applicationId
    );

    return Response.json(
      { ...deriveCandidateWorkflowStatus(decisions), history: decisions },
      { status: 200, headers: withRequestId(undefined, requestId) }
    );
  } catch (error) {
    console.error("candidate status lookup failed", error);
    const apiError = buildApiError({ requestId, code: "internal_error", message: "Could not load the status." });
    return Response.json(apiError.body, { status: apiError.status, headers: withRequestId(undefined, requestId) });
  }
}
