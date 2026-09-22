import { buildApiError, generateRequestId, withRequestId } from "@signal-audit/contracts";
import { loadEnvironmentConfig } from "@signal-audit/config";
import { listOrganizationsForUser } from "@signal-audit/db";
import { captureServerError, withServerOperation } from "../../../../lib/observability";
import type { NextRequest } from "next/server";

import { readSessionUserId } from "../../../../lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * AF-97: the organizations the signed-in caller may act in.
 *
 * Every other route takes an organizationId it never produces -- by
 * design, since a caller may belong to more than one organization and
 * the request has to say which one it means (see
 * createRoleInputSchema's comment). Nothing produced one either, so the
 * only way to obtain an organizationId was to be told it out of band
 * and paste it into a query string.
 *
 * There is no authorization check here beyond having a session, because
 * there is no organizationId to check: the answer is derived entirely
 * from the caller's own membership rows, so it cannot disclose an
 * organization they do not belong to. `/me/` rather than
 * `/organizations` for exactly that reason -- this is not an
 * organization directory and must never be mistaken for one.
 */
async function handleGET(request: NextRequest): Promise<Response> {
  const requestId = generateRequestId();
  const userId = readSessionUserId(request);
  if (userId === undefined) {
    const error = buildApiError({ requestId, code: "unauthorized", message: "Sign in required." });
    return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
  }

  try {
    const config = loadEnvironmentConfig(process.env);
    const organizations = await listOrganizationsForUser(
      config.database.url,
      config.database.schema,
      userId
    );
    return Response.json({ organizations }, { status: 200, headers: withRequestId(undefined, requestId) });
  } catch (error) {
    captureServerError(error, { requestId, operation: "organization.list" });
    const apiError = buildApiError({
      requestId,
      code: "internal_error",
      message: "Could not list your organizations."
    });
    return Response.json(apiError.body, {
      status: apiError.status,
      headers: withRequestId(undefined, requestId)
    });
  }
}

export const GET = withServerOperation("organization.list", handleGET);
