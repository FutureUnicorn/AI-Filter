import { buildApiError, generateRequestId, withRequestId } from "@signal-audit/contracts";
import { loadEnvironmentConfig } from "@signal-audit/config";
import { getFileIntakeById, getImportRowsForIntake, getMembershipsForUser } from "@signal-audit/db";
import { ALLOWED_SNIFFED_MIME_TYPES, buildImportStatusSummary } from "@signal-audit/domain";
import { fetchObjectBytes, parseCsvFile } from "@signal-audit/ingestion";
import { authorizeResourceAccess, resourceAuthorizationErrorResponse } from "@signal-audit/security";
import { readSessionUserId } from "../../../../../../../lib/session";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  readonly params: Promise<{ roleId: string; intakeId: string }>;
}

/**
 * AF-33: "waiting" counts come from re-parsing the CSV (same as AF-31's
 * discovery mode) when nothing has been finalized yet -- there is no
 * stored row count before finalize actually runs. Once import_rows
 * exist (finalize has committed at least once), those are authoritative
 * and the file is never re-read.
 */
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

    if (intake.status !== "validated" && intake.status !== "imported") {
      const error = buildApiError({
        requestId,
        code: "conflict",
        message: `Cannot report import status for an intake in status ${intake.status}; it must be validated first.`
      });
      return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
    }
    if (intake.sniffedMimeType !== ALLOWED_SNIFFED_MIME_TYPES.csv) {
      const error = buildApiError({ requestId, code: "invalid_request", message: "This intake is not a CSV file." });
      return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
    }

    const rows = await getImportRowsForIntake(config.database.url, config.database.schema, intakeId);
    const totalRows =
      rows.length > 0 ? rows.length : (await parseCsvFile(await fetchObjectBytes(config.storage, intake.storageKey))).rows.length;

    return Response.json(buildImportStatusSummary(totalRows, rows), {
      status: 200,
      headers: withRequestId(undefined, requestId)
    });
  } catch (error) {
    console.error("import status lookup failed", error);
    const apiError = buildApiError({ requestId, code: "internal_error", message: "Could not load import status." });
    return Response.json(apiError.body, { status: apiError.status, headers: withRequestId(undefined, requestId) });
  }
}
