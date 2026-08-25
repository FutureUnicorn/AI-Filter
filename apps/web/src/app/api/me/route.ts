import { buildApiError, generateRequestId, withRequestId } from "@signal-audit/contracts";
import { loadEnvironmentConfig } from "@signal-audit/config";
import { getMembershipsForUser, getOrganizationsByIds } from "@signal-audit/db";
import { CONTRACT_SCHEMA_VERSION } from "@signal-audit/domain";
import { readSessionUserId } from "../../../lib/session";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Unticketed prerequisite for the first UI screen: the working-home
 * needs to know which organizations the session belongs to so it can
 * call GET /api/roles without inventing an organizationId. Memberships
 * are fetched server-side for the session's own userId, same as AF-23.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const requestId = generateRequestId();
  const userId = readSessionUserId(request);
  if (userId === undefined) {
    const error = buildApiError({ requestId, code: "unauthorized", message: "Sign in required." });
    return Response.json(error.body, { status: error.status, headers: withRequestId(undefined, requestId) });
  }

  try {
    const config = loadEnvironmentConfig(process.env);
    const memberships = await getMembershipsForUser(config.database.url, config.database.schema, userId);
    const organizations = await getOrganizationsByIds(
      config.database.url,
      config.database.schema,
      memberships.map((membership) => membership.organizationId)
    );
    return Response.json(
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        userId,
        memberships,
        organizations
      },
      { status: 200, headers: withRequestId(undefined, requestId) }
    );
  } catch (error) {
    console.error("session context failed", error);
    const apiError = buildApiError({
      requestId,
      code: "internal_error",
      message: "Could not load the session."
    });
    return Response.json(apiError.body, {
      status: apiError.status,
      headers: withRequestId(undefined, requestId)
    });
  }
}
