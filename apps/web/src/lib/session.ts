import { SESSION_COOKIE_NAME, verifySessionToken } from "@signal-audit/security";
import type { NextRequest } from "next/server";

/**
 * SESSION_SECRET is read directly here rather than added to
 * packages/config's shared environment schema (AF-11) -- that file
 * belongs to a ticket outside this one's scope, and every other required
 * field there is validated at process startup for every service, which
 * SESSION_SECRET (web-only) doesn't need. Worth consolidating later if
 * that boundary changes.
 */
export function readSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (secret === undefined || secret.length < 32) {
    throw new Error("SESSION_SECRET must be set to a string of at least 32 characters");
  }
  return secret;
}

/** Cookie-value form so server pages (next/headers `cookies()`) and
 * Route Handlers share the same check. Does not change how the cookie
 * is issued -- that stays in the AF-23 redeem route. */
export function userIdFromSessionToken(token: string | undefined): string | undefined {
  if (token === undefined) {
    return undefined;
  }
  const verification = verifySessionToken(token, readSessionSecret());
  return verification.outcome === "valid" ? verification.userId : undefined;
}

/** Returns the authenticated user's id, or undefined if there is no
 * valid session -- callers decide what "no session" means for their
 * route (most should respond `unauthorized`). */
export function readSessionUserId(request: NextRequest): string | undefined {
  return userIdFromSessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value);
}
