import {
  buildApiError,
  generateRequestId,
  recordReviewTimingSpanInputSchema,
  withRequestId
} from "@signal-audit/contracts";
import { loadEnvironmentConfig } from "@signal-audit/config";
import { getApplicationById, getMembershipsForUser, getRoleById, recordReviewTimingSpan } from "@signal-audit/db";
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
 * AF-54: the only way a review-timing span is created.
 *
 * Three things about the shape, each of which is the point rather than
 * a detail:
 *
 *   1. The reviewer is `readSessionUserId(request)` and nothing else.
 *      recordReviewTimingSpanInputSchema is a strictObject with no
 *      reviewerUserId, so a caller cannot file time under another name.
 *   2. `review_candidates`, not `record_decision`. Recording that you
 *      looked at a candidate is a review action; requiring the stronger
 *      capability would mean an auditor's reading time silently went
 *      unmeasured while the same reading counted for a recruiter, and a
 *      baseline built from a self-selected subset is not a baseline.
 *   3. There is no GET here. AF-55 owns the read path and the grain it
 *      needs is per application; an endpoint scoped to one application
 *      and one requester is a per-reviewer read in all but name, which
 *      is the exact query this ticket declined to make easy.
 *
 * Also no PATCH or DELETE: a span is a measurement that was taken, and
 * migration 0021's trigger rejects both at the row level anyway.
 */
export async function POST(request: NextRequest, context: RouteContext): Promise<Response> {
  const requestId = generateRequestId();
  const { roleId, applicationId } = await context.params;
  const userId = readSessionUserId(request);
  if (userId === undefined) {
    const error = buildApiError({ requestId, code: "unauthorized", message: "Sign in required." });
    return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
  }

  let parsedBody: z.infer<typeof recordReviewTimingSpanInputSchema>;
  try {
    parsedBody = recordReviewTimingSpanInputSchema.parse(await request.json());
  } catch {
    const error = buildApiError({
      requestId,
      code: "invalid_request",
      message:
        "A review timing span needs startedAt and endedAt timestamps, a non-negative activeMs no larger than the span between them, and truncatedByIdle."
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

    await recordReviewTimingSpan(config.database.url, config.database.schema, {
      organizationId: role.organizationId,
      applicationId: application.applicationId,
      reviewerUserId: userId,
      startedAt: new Date(parsedBody.startedAt),
      endedAt: new Date(parsedBody.endedAt),
      activeMs: parsedBody.activeMs,
      truncatedByIdle: parsedBody.truncatedByIdle
    });

    return Response.json({ recorded: true }, { status: 201, headers: withRequestId(undefined, requestId) });
  } catch (error) {
    // A span that fails to record is lost, and that is the right
    // trade: a measurement is not worth interrupting a review over, so
    // nothing here is surfaced to the reviewer. It is logged because a
    // baseline quietly built from a fraction of the reviews is worse
    // than no baseline, and this line is the only place that would say
    // so.
    console.error("recording a review timing span failed", error);
    const apiError = buildApiError({ requestId, code: "internal_error", message: "Could not record review timing." });
    return Response.json(apiError.body, { status: apiError.status, headers: withRequestId(undefined, requestId) });
  }
}
