import {
  buildApiError,
  checkIdempotencyRequirement,
  finalizeCsvImportInputSchema,
  generateRequestId,
  idempotencyErrorResponse,
  withRequestId
} from "@signal-audit/contracts";
import { loadEnvironmentConfig } from "@signal-audit/config";
import {
  finalizeCsvImport,
  getFileIntakeById,
  getMembershipsForUser,
  invalidateChangedIntake,
  invalidateOversizedIntake
} from "@signal-audit/db";
import { ALLOWED_SNIFFED_MIME_TYPES, validateCsvColumnMapping } from "@signal-audit/domain";
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
 * AF-32: the Idempotency-Key header (required on every mutating request
 * since AF-14) is what makes a retried finalize call safe here, not
 * just a required-but-unused header like on other routes -- packages/db's
 * finalizeCsvImport actually stores it and compares it (and the mapping)
 * on every call against the same intake, distinguishing a genuine replay
 * from a real conflict. status is accepted as either 'validated' (first
 * attempt) or already 'imported' (a legitimate retry after a prior
 * success): rejecting 'imported' outright here would break replay for
 * exactly the case idempotency keys exist to handle.
 */
export async function POST(request: NextRequest, context: RouteContext): Promise<Response> {
  const requestId = generateRequestId();
  const requirement = checkIdempotencyRequirement(request.method, request.headers.get("Idempotency-Key"));
  const idempotencyError = idempotencyErrorResponse(requirement, requestId);
  if (idempotencyError !== undefined) {
    return Response.json(idempotencyError.body, {
      status: idempotencyError.status,
      headers: withRequestId(undefined, requestId)
    });
  }
  const idempotencyKey = requirement.required && requirement.outcome === "present" ? requirement.key : undefined;
  if (idempotencyKey === undefined) {
    const error = buildApiError({
      requestId,
      code: "invalid_request",
      message: "Idempotency-Key header is required."
    });
    return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
  }

  const { roleId, intakeId } = await context.params;
  const userId = readSessionUserId(request);
  if (userId === undefined) {
    const error = buildApiError({ requestId, code: "unauthorized", message: "Sign in required." });
    return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
  }

  const parsed = finalizeCsvImportInputSchema.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) {
    const error = buildApiError({
      requestId,
      code: "invalid_request",
      message: parsed.error.issues[0]?.message ?? "Body must be { mapping: { field, csvColumnHeader }[] }."
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

    if (intake.status !== "validated" && intake.status !== "imported") {
      const error = buildApiError({
        requestId,
        code: "conflict",
        message: `Cannot finalize an intake in status ${intake.status}; it must be validated first.`
      });
      return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
    }

    if (intake.sniffedMimeType !== ALLOWED_SNIFFED_MIME_TYPES.csv) {
      const error = buildApiError({ requestId, code: "invalid_request", message: "This intake is not a CSV file." });
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

    const validation = validateCsvColumnMapping(headers, parsed.data.mapping);
    if (validation.outcome === "invalid") {
      const error = buildApiError({
        requestId,
        code: "invalid_request",
        message: "This column mapping is invalid.",
        details: { reasons: validation.reasons }
      });
      return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
    }

    const outcome = await finalizeCsvImport(config.database.url, config.database.schema, {
      organizationId: intake.organizationId,
      roleId,
      intakeId,
      idempotencyKey,
      mapping: parsed.data.mapping,
      rows
    });

    if (outcome.outcome === "conflict") {
      const error = buildApiError({
        requestId,
        code: "idempotency_key_conflict",
        message: "This intake was already finalized with a different idempotency key or column mapping."
      });
      return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
    }
    if (outcome.outcome === "not_validated") {
      const error = buildApiError({
        requestId,
        code: "conflict",
        message: "This intake changed status before finalization completed; try again."
      });
      return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
    }

    return Response.json(
      { summary: outcome.summary, rows: outcome.rows },
      { status: outcome.outcome === "finalized" ? 201 : 200, headers: withRequestId(undefined, requestId) }
    );
  } catch (error) {
    console.error("csv import finalization failed", error);
    const apiError = buildApiError({ requestId, code: "internal_error", message: "Could not finalize the import." });
    return Response.json(apiError.body, { status: apiError.status, headers: withRequestId(undefined, requestId) });
  }
}
