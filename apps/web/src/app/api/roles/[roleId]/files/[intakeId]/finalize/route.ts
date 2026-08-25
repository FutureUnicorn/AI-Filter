import {
  buildApiError,
  checkIdempotencyRequirement,
  finalizeCsvImportInputSchema,
  generateRequestId,
  idempotencyErrorResponse,
  withRequestId
} from "@signal-audit/contracts";
import { loadEnvironmentConfig } from "@signal-audit/config";
import { finalizeCsvImport, getFileIntakeById, getMembershipsForUser } from "@signal-audit/db";
import { ALLOWED_SNIFFED_MIME_TYPES, validateCsvColumnMapping } from "@signal-audit/domain";
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

    const bytes = await fetchObjectBytes(config.storage, intake.storageKey);
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
