import { buildApiError, csvPreviewInputSchema, generateRequestId, withRequestId } from "@signal-audit/contracts";
import { loadEnvironmentConfig } from "@signal-audit/config";
import { getFileIntakeById, getMembershipsForUser } from "@signal-audit/db";
import { ALLOWED_SNIFFED_MIME_TYPES, buildCsvPreview, validateCsvColumnMapping } from "@signal-audit/domain";
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
 * AF-31: read-only. An empty/omitted mapping is how the recruiter
 * discovers the file's real header row before choosing one; once a
 * mapping is supplied it's checked against packages/domain's closed
 * field set and those same headers (validateCsvColumnMapping) before any
 * preview rows are computed. Never persists anything -- AF-32 is where
 * an accepted mapping is actually applied to every row and turned into
 * durable application records.
 */
export async function POST(request: NextRequest, context: RouteContext): Promise<Response> {
  const requestId = generateRequestId();
  const { roleId, intakeId } = await context.params;
  const userId = readSessionUserId(request);
  if (userId === undefined) {
    const error = buildApiError({ requestId, code: "unauthorized", message: "Sign in required." });
    return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
  }

  const parsed = csvPreviewInputSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    const error = buildApiError({
      requestId,
      code: "invalid_request",
      message: parsed.error.issues[0]?.message ?? "Body must be { mapping?: { field, csvColumnHeader }[] }."
    });
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

    if (intake.status !== "validated") {
      const error = buildApiError({
        requestId,
        code: "conflict",
        message: `Cannot preview an intake in status ${intake.status}; it must be validated first.`
      });
      return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
    }

    if (intake.sniffedMimeType !== ALLOWED_SNIFFED_MIME_TYPES.csv) {
      const error = buildApiError({
        requestId,
        code: "invalid_request",
        message: "This intake is not a CSV file."
      });
      return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
    }

    const bytes = await fetchObjectBytes(config.storage, intake.storageKey);
    const { headers, rows } = parseCsvFile(bytes);
    if (headers.length === 0) {
      const error = buildApiError({ requestId, code: "invalid_request", message: "CSV file has no header row." });
      return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
    }

    const mapping = parsed.data.mapping ?? [];
    if (mapping.length === 0) {
      return Response.json(
        { headers, totalDataRows: rows.length },
        { status: 200, headers: withRequestId(undefined, requestId) }
      );
    }

    const validation = validateCsvColumnMapping(headers, mapping);
    if (validation.outcome === "invalid") {
      const error = buildApiError({
        requestId,
        code: "invalid_request",
        message: "This column mapping is invalid.",
        details: { reasons: validation.reasons }
      });
      return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
    }

    const preview = buildCsvPreview(rows, mapping);
    return Response.json({ headers, ...preview }, { status: 200, headers: withRequestId(undefined, requestId) });
  } catch (error) {
    console.error("csv preview failed", error);
    const apiError = buildApiError({ requestId, code: "internal_error", message: "Could not preview the CSV file." });
    return Response.json(apiError.body, { status: apiError.status, headers: withRequestId(undefined, requestId) });
  }
}
