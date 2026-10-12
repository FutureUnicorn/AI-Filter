import {
  buildApiError,
  generateRequestId,
  metricSampleSchema,
  reviewTimeBaselineSchema,
  withRequestId
} from "@signal-audit/contracts";
import { loadEnvironmentConfig } from "@signal-audit/config";
import {
  countApplicationsForRole,
  getMembershipsForUser,
  getRoleById,
  listReviewTimingSpansForRole
} from "@signal-audit/db";
import {
  REVIEW_TIME_REDUCTION_MINIMUM_SAMPLE_SIZE,
  describeReviewTimeReduction,
  summarizeReviewTiming
} from "@signal-audit/domain";
import { authorizeResourceAccess, resourceAuthorizationErrorResponse } from "@signal-audit/security";
import { readSessionUserId } from "../../../../../../lib/session";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  readonly params: Promise<{ roleId: string }>;
}

/**
 * AF-55: the review-time reduction for one role, as a MetricSample.
 *
 * Four decisions worth stating, because each of them is a way this
 * endpoint could have overstated the product's headline number.
 *
 * 1. `view_audit_reports`, not `review_candidates`. A recruiter has the
 *    latter, and this is a number about how long reviews take: giving
 *    the people being measured the measurement turns a product metric
 *    into a performance dashboard, which is the thing AF-54 refused to
 *    build a query for. Auditor has it and cannot review candidates,
 *    which is the correct shape for oversight.
 *
 * 2. The minimum sample is REVIEW_TIME_REDUCTION_MINIMUM_SAMPLE_SIZE and
 *    is NOT readable from the request. A caller who could send
 *    `minimumSampleSize=1` could extract a headline number from a single
 *    review, and suppression that the reader can switch off is not
 *    suppression.
 *
 * 3. The baseline's AMOUNT comes from the request. Its PROVENANCE does
 *    not. `source` is fixed to `employer_reported` here and
 *    `baselineSource` is rejected outright. An earlier version read the
 *    source from the query string, so a caller could send
 *    `measured_preassist` and describeReviewTimeReduction would omit
 *    `baseline_self_reported`: the caller could delete the one
 *    limitation that says the two sides were not measured the same way.
 *    A baseline arriving in a request is an estimate by construction,
 *    whatever it calls itself.
 *
 *    A genuine measured_preassist baseline needs two things that do not
 *    exist yet: timing spans recorded while assistance was off, and a
 *    persisted per-role record of when it was switched on to tell those
 *    spans from the assisted ones. Until both exist no route can
 *    honestly produce that source, so none may accept it.
 *
 *    The amount is still validated by reviewTimeBaselineSchema before it
 *    reaches the domain, so a zero is a 400 rather than
 *    describeReviewTimeReduction's throw surfacing as a 500.
 *
 * 4. The response is the MetricSample and nothing else. No target, no
 *    pass/fail against the 50% goal, and no candidate-level anything:
 *    POL-003 permits a mechanical metric about system processing and
 *    forbids presenting one as a statement about candidates, so this
 *    returns a role-level aggregate with no application, candidate or
 *    reviewer identifier in it.
 */
export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  const requestId = generateRequestId();
  const { roleId } = await context.params;
  const userId = readSessionUserId(request);
  if (userId === undefined) {
    const error = buildApiError({ requestId, code: "unauthorized", message: "Sign in required." });
    return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
  }

  // Rejected rather than ignored. A caller who sent this was told a
  // source would be honoured, and silently relabelling their baseline
  // would leave them believing the opposite of what the response says.
  if (request.nextUrl.searchParams.has("baselineSource")) {
    const error = buildApiError({
      requestId,
      code: "invalid_request",
      message:
        "baselineSource is not accepted. A baseline that arrives with a request is the employer's own " +
        "estimate by definition and is labelled as one. A measured pre-assist baseline can only come from " +
        "timing this system recorded before assistance was enabled, which nothing persists yet."
    });
    return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
  }

  const rawMedianActiveMs = request.nextUrl.searchParams.get("employerReportedMedianActiveMs");
  const parsedBaseline = reviewTimeBaselineSchema.safeParse({
    // Fixed here, never read from the request. This is the whole of the
    // fix for REV-002: `source` decides whether the reader is told the
    // two sides were measured differently, so a caller able to set it is
    // a caller able to delete that warning.
    source: "employer_reported",
    // Number("") is 0 and Number(null) is 0, both of which the schema's
    // .positive() rejects; NaN is rejected by .finite(). Coercing here
    // and validating there keeps one definition of a usable baseline.
    medianActiveMs: rawMedianActiveMs === null ? Number.NaN : Number(rawMedianActiveMs)
  });
  if (!parsedBaseline.success) {
    const error = buildApiError({
      requestId,
      code: "invalid_request",
      message:
        "employerReportedMedianActiveMs must be a positive number of milliseconds. There is no default: a " +
        "baseline of unknown provenance is the one fact this comparison cannot lose."
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
    const authorization = authorizeResourceAccess(memberships, role.organizationId, "view_audit_reports", userId);
    const authError = resourceAuthorizationErrorResponse(authorization, requestId);
    if (authError !== undefined) {
      return Response.json(authError.body, {
        status: authError.status,
        headers: withRequestId(undefined, requestId)
      });
    }

    const [spans, population] = await Promise.all([
      listReviewTimingSpansForRole(config.database.url, config.database.schema, role.organizationId, role.roleId),
      countApplicationsForRole(config.database.url, config.database.schema, role.organizationId, role.roleId)
    ]);

    const sample = describeReviewTimeReduction(
      summarizeReviewTiming(spans, population),
      parsedBaseline.data,
      REVIEW_TIME_REDUCTION_MINIMUM_SAMPLE_SIZE
    );

    // The contract refinement that says a value may not be reported
    // below its minimum sample is only worth having if something
    // actually runs it at the boundary it describes. summarizeMetric
    // already enforces it; this is the check that would catch a future
    // caller assembling a sample by hand.
    const validated = metricSampleSchema.safeParse(sample);
    if (!validated.success) {
      throw new Error(`review_time_reduction sample failed its own contract: ${validated.error.message}`);
    }

    return Response.json(validated.data, { status: 200, headers: withRequestId(undefined, requestId) });
  } catch (error) {
    console.error("review-time reduction lookup failed", error);
    const apiError = buildApiError({
      requestId,
      code: "internal_error",
      message: "Could not calculate the review-time reduction."
    });
    return Response.json(apiError.body, { status: apiError.status, headers: withRequestId(undefined, requestId) });
  }
}
