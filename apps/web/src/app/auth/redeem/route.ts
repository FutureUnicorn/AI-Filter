import { generateRequestId, withRequestId } from "@signal-audit/contracts";
import { SESSION_COOKIE_NAME } from "@signal-audit/security";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { SESSION_COOKIE_OPTIONS, redeemMagicLinkForSession } from "../../../lib/magic-link";

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
 * Tradeoff worth stating: a GET that consumes a single-use token can be
 * spent by an aggressive link scanner or mail-client prefetch. That is
 * inherent to emailed magic links, and the mitigations already in place are
 * the ones that matter -- single use enforced atomically in
 * `redeemMagicLinkToken`, and a short expiry. A confirm-button interstitial
 * would remove the prefetch risk at the cost of an extra click; that is a
 * product decision, not one to make silently here.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const requestId = generateRequestId();
  const token = new URL(request.url).searchParams.get("token");
  const headers = withRequestId(undefined, requestId);

  if (token === null || token.length === 0) {
    return NextResponse.redirect(new URL("/?auth=missing_token", request.url), { headers });
  }

  try {
    const redemption = await redeemMagicLinkForSession(token);
    if (redemption.outcome === "invalid") {
      return NextResponse.redirect(new URL("/?auth=invalid_link", request.url), { headers });
    }
    if (redemption.outcome === "no_account") {
      return NextResponse.redirect(new URL("/?auth=no_account", request.url), { headers });
    }
    // 303 so the browser issues a GET for the destination and the consumed
    // token is not re-sent if the user reloads the landing page.
    const response = NextResponse.redirect(new URL("/roles", request.url), { status: 303, headers });
    response.cookies.set(SESSION_COOKIE_NAME, redemption.sessionToken, SESSION_COOKIE_OPTIONS);
    return response;
  } catch (error) {
    // Never echo the failure to the caller: the same opaque destination for
    // any server-side fault, with the detail kept to the server log.
    console.error("magic-link redeem (email link) failed", error);
    return NextResponse.redirect(new URL("/?auth=error", request.url), { headers });
  }
}
