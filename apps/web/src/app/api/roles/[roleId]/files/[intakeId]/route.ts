import { buildApiError, generateRequestId, withRequestId } from "@signal-audit/contracts";
import { loadEnvironmentConfig } from "@signal-audit/config";
import { getFileIntakeById, getMembershipsForUser } from "@signal-audit/db";
import { authorizeResourceAccess, resourceAuthorizationErrorResponse } from "@signal-audit/security";
import { readSessionUserId } from "../../../../../../lib/session";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  readonly params: Promise<{ roleId: string; intakeId: string }>;
}

/** AF-33: the status page needs to read an intake's current state
 * (declared filename, status, sniffed type) without triggering any of
 * the mutating action routes -- none of those existed as a plain GET
 * before this. */
export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  const requestId = generateRequestId();
  const { roleId, intakeId } = await context.params;
  const userId = readSessionUserId(request);
  if (userId === undefined) {
    const error = buildApiError({ requestId, code: "unauthorized", message: "Sign in required." });
    return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
  }

  try {
    const config = loadEnvironmentConfig(process.env);
    const intake = await getFileIntakeById(config.database.url, config.database.schema, intakeId);
    if (intake === undefined || intake.roleId !== roleId) {
      const error = buildApiError({ requestId, code: "not_found", message: "File intake not found." });
      return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
    }

    const memberships = await getMembershipsForUser(config.database.url, config.database.schema, userId);
    const authorization = authorizeResourceAccess(memberships, intake.organizationId, "manage_roles", userId);
    const authError = resourceAuthorizationErrorResponse(authorization, requestId);
    if (authError !== undefined) {
      return Response.json(authError.body, {
        status: authError.status,
        headers: withRequestId(undefined, requestId)
      });
    }

    return Response.json(intake, { status: 200, headers: withRequestId(undefined, requestId) });
  } catch (error) {
    console.error("file intake lookup failed", error);
    const apiError = buildApiError({ requestId, code: "internal_error", message: "Could not load the file intake." });
    return Response.json(apiError.body, { status: apiError.status, headers: withRequestId(undefined, requestId) });
  }
}
