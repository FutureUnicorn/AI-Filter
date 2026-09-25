import { loadEnvironmentConfig } from "@signal-audit/config";
import { generateRequestId, withRequestId } from "@signal-audit/contracts";
import { SESSION_COOKIE_NAME } from "@signal-audit/security";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { SESSION_COOKIE_OPTIONS, isRedeemableInviteToken, redeemMagicLinkForSession } from "../../../lib/magic-link";
import { captureServerError, withServerOperation } from "../../../lib/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The URL that is actually inside the delivered email.
 *
 * `POST /api/auth/magic-link/redeem` already implemented redemption, but the
 * request handler emails `/auth/redeem?token=...`, and nothing served that
 * path: a real recipient clicking a real link got a 404 while the route-level
 * test passed by extracting the token and calling the API handler directly.
 * This is a GET handler because an email client can only issue a GET.
 *
 * Outcomes are reported by redirecting to `/?auth=<reason>` rather than
 * rendering an error body, so the token never survives in the address bar of
 * a failed attempt and the user lands somewhere they can retry from. The
 * token is never placed in a redirect target.
 *
 * Tradeoff worth stating for a plain login token: a GET that consumes a
 * single-use token can be spent by an aggressive link scanner or mail-client
 * prefetch. That is inherent to emailed magic links, and the mitigations
 * already in place are the ones that matter -- single use enforced
 * atomically in `redeemMagicLinkToken`, and a short expiry. Redemption there
 * only mints a session, so a scanner spending it costs the real recipient a
 * second request for a link, and is left as-is.
 *
 * An invite token is a different risk (review #88, REV-011): redemption
 * also provisions or changes a persistent membership, so a scanner spending
 * it silently creates the membership, or applies a role change, before the
 * invitee ever acted -- and the invitee's own click then lands on a dead
 * token with no way to tell what happened. So this GET does not consume an
 * invite token at all; it peeks (non-mutating) and, if the token is still a
 * live invite, redirects to `/auth/confirm`, which requires an explicit
 * action before calling the same redemption this route uses for everything
 * else.
 */
async function handleGET(request: NextRequest): Promise<Response> {
  const requestId = generateRequestId();
  const token = new URL(request.url).searchParams.get("token");
  const headers = withRequestId(undefined, requestId);
  // Redirect targets are resolved against the configured origin rather than
  // the request URL, for the same reason the emailed link is (review #83): the
  // request host is caller-controlled. Reading the token from the request's
  // own query string is fine, since that is the value being redeemed.
  const origin = loadEnvironmentConfig(process.env).publicAppOrigin;

  if (token === null || token.length === 0) {
    return NextResponse.redirect(new URL("/?auth=missing_token", origin), { headers });
  }

  try {
    // Non-mutating (review #88, REV-011): a still-live invite token defers
    // to a confirmation step instead of being consumed by this GET, so a
    // mail scanner's prefetch cannot provision or change a membership on
    // the invitee's behalf. The token stays in the query string here only
    // because this redirect is same-origin and server-issued, never shown
    // to the browser as the page it lands on -- unlike the outcomes below,
    // which deliberately drop it.
    if (await isRedeemableInviteToken(token)) {
      const confirmUrl = new URL("/auth/confirm", origin);
      confirmUrl.searchParams.set("token", token);
      return NextResponse.redirect(confirmUrl, { headers });
    }

    const redemption = await redeemMagicLinkForSession(token);
    if (redemption.outcome === "invalid") {
      return NextResponse.redirect(new URL("/?auth=invalid_link", origin), { headers });
    }
    if (redemption.outcome === "no_account") {
      return NextResponse.redirect(new URL("/?auth=no_account", origin), { headers });
    }
    // 303 so the browser issues a GET for the destination and the consumed
    // token is not re-sent if the user reloads the landing page.
    const response = NextResponse.redirect(new URL("/roles", origin), { status: 303, headers });
    response.cookies.set(SESSION_COOKIE_NAME, redemption.sessionToken, SESSION_COOKIE_OPTIONS);
    return response;
  } catch (error) {
    // Never echo the failure to the caller: the same opaque destination for
    // any server-side fault, with the detail kept to the server log.
    captureServerError(error, { requestId, operation: "auth.magic_link.redeem" });
    return NextResponse.redirect(new URL("/?auth=error", origin), { headers });
  }
}

export const GET = withServerOperation("auth.magic_link.redeem", handleGET);
