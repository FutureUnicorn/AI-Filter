import { loadEnvironmentConfig } from "@signal-audit/config";
import {
  getUserByEmail,
  peekInviteDetails,
  peekMagicLinkTokenIsInvite,
  redeemMagicLinkToken,
  type InvitePeek
} from "@signal-audit/db";
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

/**
 * What `/auth/confirm` needs to render before the person clicks (review
 * #88 round 5, REV-003): which organization, which role, and -- the case
 * that matters most -- whether accepting replaces a role they already
 * hold. Undefined for anything that is not a currently-live invite token.
 */
export async function peekInviteConfirmationDetails(token: string): Promise<InvitePeek | undefined> {
  const config = loadEnvironmentConfig(process.env);
  return peekInviteDetails(config.database.url, config.database.schema, hashMagicLinkToken(token));
}

/**
 * The cookie `GET /auth/redeem` sets in place of the query string it used
 * to put the raw invite token in (review #88 round 5, REV-002): that
 * redirect target is what the browser actually navigates to and renders,
 * not an intermediate the browser never shows, so the token was in the
 * address bar, in history, and in the `Referer` of any cross-origin
 * subresource `/auth/confirm` loaded. `HttpOnly` keeps it out of reach of
 * any script running on that page; `path` scopes it to the two routes that
 * ever need it, so it is never attached to a request anywhere else in the
 * app.
 */
export const INVITE_CONFIRM_COOKIE_NAME = "invite_confirm_token";
export const INVITE_CONFIRM_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "strict",
  path: "/auth/confirm",
  // Short: this cookie only ever needs to survive from the redirect to the
  // click that follows it, not anywhere near the token's own expiry.
  maxAge: 10 * 60
} as const;

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
