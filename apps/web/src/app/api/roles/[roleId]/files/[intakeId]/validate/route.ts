import { buildApiError, generateRequestId, withRequestId } from "@signal-audit/contracts";
import { loadEnvironmentConfig } from "@signal-audit/config";
import {
  getFileIntakeById,
  getMembershipsForUser,
  recordFileValidationResult
} from "@signal-audit/db";
import { evaluateFileValidation } from "@signal-audit/domain";
import { sniffUploadedFile } from "@signal-audit/ingestion";
import { authorizeResourceAccess, resourceAuthorizationErrorResponse } from "@signal-audit/security";
import { readSessionUserId } from "../../../../../../../lib/session";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  readonly params: Promise<{ roleId: string; intakeId: string }>;
}

/**
 * AF-29: fetches the uploaded object once, sniffs its real bytes,
 * hashes it, and (for docx) reads its ZIP central directory -- all in
 * packages/ingestion, which owns every piece of this that needs real
 * I/O or a third-party sniffer. The actual allow/quarantine decision is
 * packages/domain's pure evaluateFileValidation, given only those
 * already-gathered facts, so that decision stays unit-testable without
 * a real bucket. No POST body: idempotency doesn't apply here in AF-14's
 * sense (this reads an existing object and records a fact about it, it
 * doesn't create anything a duplicate call could double-create), and
 * the one-shot WHERE status = 'uploaded' in packages/db is what actually
 * prevents a second, more lenient pass from overriding a quarantine.
 */
export async function POST(_request: NextRequest, context: RouteContext): Promise<Response> {
  const requestId = generateRequestId();
  const { roleId, intakeId } = await context.params;
  const userId = readSessionUserId(_request);
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

    if (intake.status !== "uploaded") {
      const error = buildApiError({
        requestId,
        code: "conflict",
        message: `Cannot validate an intake in status ${intake.status}; it must be uploaded first.`
      });
      return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
    }

    const sniffed = await sniffUploadedFile(config.storage, intake.storageKey);
    const validation = evaluateFileValidation({
      declaredFilename: intake.declaredFilename,
      sniffedMimeType: sniffed.sniffedMimeType,
      sizeBytes: sniffed.sizeBytes,
      zipUncompressedBytes: sniffed.zipUncompressedBytes
    });

    const outcome = await recordFileValidationResult(config.database.url, config.database.schema, intakeId, {
      sniffedMimeType: sniffed.sniffedMimeType,
      sizeBytes: sniffed.sizeBytes,
      sha256Hash: sniffed.sha256Hash,
      validation
    });
    if (outcome.outcome === "not_uploaded") {
      const error = buildApiError({
        requestId,
        code: "conflict",
        message: "This intake changed status before validation completed; try again."
      });
      return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
    }
    return Response.json(outcome.intake, { status: 200, headers: withRequestId(undefined, requestId) });
  } catch (error) {
    console.error("file validation failed", error);
    const apiError = buildApiError({ requestId, code: "internal_error", message: "Could not validate the file." });
    return Response.json(apiError.body, { status: apiError.status, headers: withRequestId(undefined, requestId) });
  }
}
