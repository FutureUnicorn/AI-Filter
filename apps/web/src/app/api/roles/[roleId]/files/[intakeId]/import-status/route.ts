import { buildApiError, generateRequestId, withRequestId } from "@signal-audit/contracts";
import { loadEnvironmentConfig } from "@signal-audit/config";
import {
  getFileIntakeById,
  getImportRowsForIntake,
  getMembershipsForUser,
  invalidateChangedIntake,
  invalidateOversizedIntake
} from "@signal-audit/db";
import { ALLOWED_SNIFFED_MIME_TYPES, buildImportStatusSummary } from "@signal-audit/domain";
import {
  ObjectChangedError,
  ObjectTooLargeError,
  fetchValidatedObjectBytes,
  parseCsvFile
} from "@signal-audit/ingestion";
import { authorizeResourceAccess, resourceAuthorizationErrorResponse } from "@signal-audit/security";
import { readSessionUserId } from "../../../../../../../lib/session";
import { captureServerError } from "../../../../../../../lib/observability";
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

/** A validated intake always has a hash; its absence means the row is not in
 * the state its status claims, which must fail loudly rather than skip the
 * integrity check. */
function requireValidatedHash(hash: string | undefined): string {
  if (hash === undefined) {
    throw new Error("intake is marked validated but has no recorded content hash");
  }
  return hash;
}

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
    let totalRows = rows.length;
    if (rows.length === 0) {
      // Same binding as the other post-validation reads (review #83): the
      // presigned PUT outlives validation, so a re-fetch must be checked
      // against the validated digest rather than trusted.
      try {
        const bytes = await fetchValidatedObjectBytes(
          config.storage,
          intake.storageKey,
          requireValidatedHash(intake.sha256Hash)
        );
        totalRows = (await parseCsvFile(bytes)).rows.length;
      } catch (readError) {
        // Handled rather than left to the generic catch, for the same reason
        // as the other readers: a substituted object is an expected rejection
        // and must invalidate the intake, not answer 500 forever.
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
          // The bytes validation approved already passed this same limit, so
          // an object that now exceeds it cannot be those bytes: it was
          // replaced after validation, same as a hash mismatch (review #83,
          // REV-014).
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
    }

    return Response.json(buildImportStatusSummary(totalRows, rows), {
      status: 200,
      headers: withRequestId(undefined, requestId)
    });
  } catch (error) {
    captureServerError(error, { requestId, operation: "csv.import_status" });
    const apiError = buildApiError({ requestId, code: "internal_error", message: "Could not load import status." });
    return Response.json(apiError.body, { status: apiError.status, headers: withRequestId(undefined, requestId) });
  }
}
