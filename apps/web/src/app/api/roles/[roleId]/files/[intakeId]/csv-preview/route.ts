import { buildApiError, csvPreviewInputSchema, generateRequestId, withRequestId } from "@signal-audit/contracts";
import { loadEnvironmentConfig } from "@signal-audit/config";
import {
  getFileIntakeById,
  getMembershipsForUser,
  invalidateChangedIntake,
  invalidateOversizedIntake
} from "@signal-audit/db";
import { ALLOWED_SNIFFED_MIME_TYPES, buildCsvPreview, validateCsvColumnMapping } from "@signal-audit/domain";
import {
  ObjectChangedError,
  ObjectTooLargeError,
  fetchValidatedObjectBytes,
  parseCsvFile
} from "@signal-audit/ingestion";
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

    // Bound to the bytes validation approved (review #83). Completing an
    // intake does not revoke the presigned PUT, so the key stays writable for
    // the rest of its TTL; without this, an overwrite after validation would
    // be processed here as though it had passed MIME, size and quarantine
    // checks. A validated intake always carries a hash, so its absence means
    // the row is not in the state its status claims.
    if (intake.sha256Hash === undefined) {
      const error = buildApiError({
        requestId,
        code: "conflict",
        message: "This intake has no recorded content hash, so its bytes cannot be verified. Re-validate it."
      });
      return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
    }
    let bytes;
    try {
      bytes = await fetchValidatedObjectBytes(config.storage, intake.storageKey, intake.sha256Hash);
    } catch (readError) {
      // Review #83: these typed errors were falling into the generic catch and
      // returning 500, so an overwritten object left the intake `validated`
      // and every later call failed the same opaque way. They exist to mark an
      // expected rejection: invalidate the intake so it cannot be reprocessed,
      // and tell the caller what happened.
      if (readError instanceof ObjectChangedError) {
        await invalidateChangedIntake(config.database.url, config.database.schema, intakeId, readError);
        const error = buildApiError({
          requestId,
          code: "conflict",
          message:
            "The stored file no longer matches the bytes that were validated, so it has been quarantined. Upload it again."
        });
        return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
      }
      if (readError instanceof ObjectTooLargeError) {
        // The bytes validation approved already passed this same limit, so an
        // object that now exceeds it cannot be those bytes: it was replaced
        // after validation, same as a hash mismatch (review #83, REV-014).
        await invalidateOversizedIntake(config.database.url, config.database.schema, intakeId, readError);
        const error = buildApiError({
          requestId,
          code: "payload_too_large",
          message:
            `This file is larger than the ${readError.limitBytes}-byte limit, so it no longer matches what was ` +
            `validated and has been quarantined. Upload it again.`
        });
        return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
      }
      throw readError;
    }

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
