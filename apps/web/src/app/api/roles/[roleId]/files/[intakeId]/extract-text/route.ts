import { ALLOWED_SNIFFED_MIME_TYPES } from "@signal-audit/domain";
import { buildApiError, generateRequestId, withRequestId } from "@signal-audit/contracts";
import { loadEnvironmentConfig } from "@signal-audit/config";
import {
  createCanonicalTextExtraction,
  getFileIntakeById,
  getMembershipsForUser
} from "@signal-audit/db";
import {
  extractCanonicalTextFromDocx,
  extractCanonicalTextFromPdf,
  fetchObjectBytes
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
 * AF-30: only ever runs against a 'validated' intake -- AF-29 is the
 * gate that must pass first, so this never hands an untrusted or
 * quarantined file to a parser. Dispatches on sniffed_mime_type (the
 * real type AF-29 found), never the client-declared one. csv is
 * explicitly out of scope: it has no "canonical text" in this sense,
 * it goes through AF-31/32's own mapping path instead.
 */
export async function POST(request: NextRequest, context: RouteContext): Promise<Response> {
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

    if (intake.status !== "validated") {
      const error = buildApiError({
        requestId,
        code: "conflict",
        message: `Cannot extract text from an intake in status ${intake.status}; it must be validated first.`
      });
      return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
    }

    const bytes = await fetchObjectBytes(config.storage, intake.storageKey);
    const result =
      intake.sniffedMimeType === ALLOWED_SNIFFED_MIME_TYPES.pdf
        ? await extractCanonicalTextFromPdf(bytes)
        : intake.sniffedMimeType === ALLOWED_SNIFFED_MIME_TYPES.docx
          ? await extractCanonicalTextFromDocx(bytes)
          : undefined;
    if (result === undefined) {
      const error = buildApiError({
        requestId,
        code: "invalid_request",
        message: "This intake's file type has no canonical text parser (only pdf and docx do)."
      });
      return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
    }

    const extraction = await createCanonicalTextExtraction(config.database.url, config.database.schema, {
      intakeId,
      pages: result.pages,
      quality: result.quality
    });
    return Response.json(extraction, { status: 200, headers: withRequestId(undefined, requestId) });
  } catch (error) {
    console.error("canonical text extraction failed", error);
    const apiError = buildApiError({ requestId, code: "internal_error", message: "Could not extract text." });
    return Response.json(apiError.body, { status: apiError.status, headers: withRequestId(undefined, requestId) });
  }
}
