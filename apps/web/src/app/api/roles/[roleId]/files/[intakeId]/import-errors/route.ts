import { buildApiError, generateRequestId, withRequestId } from "@signal-audit/contracts";
import { loadEnvironmentConfig } from "@signal-audit/config";
import { getFileIntakeById, getImportRowsForIntake, getMembershipsForUser } from "@signal-audit/db";
import { buildImportErrorsCsv } from "@signal-audit/domain";
import { authorizeResourceAccess, resourceAuthorizationErrorResponse } from "@signal-audit/security";
import { readSessionUserId } from "../../../../../../../lib/session";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  readonly params: Promise<{ roleId: string; intakeId: string }>;
}

/** AF-33: the recruiter's downloadable error list. Only meaningful once
 * finalize has actually run -- an intake with nothing finalized yet has
 * no failed rows to report, not an empty-but-valid download. */
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

    if (intake.status !== "imported") {
      const error = buildApiError({
        requestId,
        code: "conflict",
        message: "This intake has not been finalized yet; there is no error list."
      });
      return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
    }

    const rows = await getImportRowsForIntake(config.database.url, config.database.schema, intakeId);
    const csv = buildImportErrorsCsv(rows);
    return new Response(csv, {
      status: 200,
      headers: withRequestId(
        new Headers({
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="import-errors-${intakeId}.csv"`
        }),
        requestId
      )
    });
  } catch (error) {
    console.error("import errors export failed", error);
    const apiError = buildApiError({ requestId, code: "internal_error", message: "Could not build the error list." });
    return Response.json(apiError.body, { status: apiError.status, headers: withRequestId(undefined, requestId) });
  }
}
