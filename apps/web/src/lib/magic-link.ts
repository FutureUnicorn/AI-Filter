import { loadEnvironmentConfig } from "@signal-audit/config";
import { getUserByEmail, peekMagicLinkTokenIsInvite, redeemMagicLinkToken } from "@signal-audit/db";
import { createSessionToken, hashMagicLinkToken, verifyMagicLinkToken } from "@signal-audit/security";

import { readSessionSecret } from "./session";

/**
 * One redemption implementation, shared by the two entry points that must
 * agree about it:
 *
 *   GET  /auth/redeem                  -- the URL actually inside the email
 *   POST /api/auth/magic-link/redeem   -- the programmatic/API boundary
 *
 * They were separate before, and only the POST one existed, so the emailed
 * link 404'd while a route-level test passed by calling the API handler
 * directly with a token it had extracted itself. Two entry points with two
 * copies of this logic is exactly how that gap reappears, so the rules live
 * here once and both routes are thin HTTP wrappers over this.
 */
export type MagicLinkRedemption =
  | {
      readonly outcome: "redeemed";
      readonly sessionToken: string;
      readonly userId: string;
      readonly email: string;
      readonly schemaVersion: string;
    }
  /** The token itself is not usable: unknown, expired, or already consumed. */
  | { readonly outcome: "invalid"; readonly reason: string }
  /** The token was valid but no account exists for its email. */
  | { readonly outcome: "no_account" };

/**
 * Non-mutating: tells GET /auth/redeem whether to defer to a confirmation
 * step instead of consuming the token itself (review #88, REV-011). See
 * peekMagicLinkTokenIsInvite for why an invalid/expired/consumed token is
 * deliberately indistinguishable from a plain login token here -- both
 * fall through to the real, consuming redemption below.
 */
export async function isRedeemableInviteToken(token: string): Promise<boolean> {
  const config = loadEnvironmentConfig(process.env);
  return peekMagicLinkTokenIsInvite(config.database.url, config.database.schema, hashMagicLinkToken(token));
}

export async function redeemMagicLinkForSession(token: string): Promise<MagicLinkRedemption> {
  const config = loadEnvironmentConfig(process.env);
  const attempt = await redeemMagicLinkToken(
    config.database.url,
    config.database.schema,
    hashMagicLinkToken(token)
  );
  const verification = verifyMagicLinkToken(attempt);
  if (verification.outcome !== "valid") {
    return { outcome: "invalid", reason: verification.outcome.replace("_", " ") };
  }
  const user = await getUserByEmail(config.database.url, config.database.schema, verification.email);
  if (user === undefined) {
    return { outcome: "no_account" };
  }
  return {
    outcome: "redeemed",
    sessionToken: createSessionToken(user.userId, readSessionSecret()),
    userId: user.userId,
    email: user.email,
    schemaVersion: user.schemaVersion
  };
}

/** The session cookie attributes both entry points set, kept in one place so
 * a hardening change (SameSite, max age) cannot apply to only one of them. */
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
  maxAge: 12 * 60 * 60
} as const;
