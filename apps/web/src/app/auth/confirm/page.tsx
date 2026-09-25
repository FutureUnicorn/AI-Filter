"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";

/**
 * The explicit action review #88 (REV-011) requires before an invite token
 * is consumed.
 *
 * `GET /auth/redeem` lands here, unconsumed, for any still-live invite
 * token -- it never reaches this page for a plain login link, which that
 * route still redeems directly. Accepting POSTs to the same
 * `POST /api/auth/magic-link/redeem` that performs every other redemption
 * in this app, so a mail scanner's earlier GET (non-mutating, see that
 * route's doc comment) cannot have done anything but bring the recipient
 * here -- the token is still live, waiting on this click.
 */
type ConfirmState =
  | { readonly kind: "idle" }
  | { readonly kind: "confirming" }
  | { readonly kind: "error"; readonly message: string };

export default function ConfirmInvitePage() {
  return (
    <Suspense
      fallback={
        <main>
          <p>Loading…</p>
        </main>
      }
    >
      <ConfirmInvite />
    </Suspense>
  );
}

function ConfirmInvite() {
  const token = useSearchParams().get("token");
  const [state, setState] = useState<ConfirmState>({ kind: "idle" });

  async function accept(): Promise<void> {
    if (token === null || token.length === 0) {
      return;
    }
    setState({ kind: "confirming" });
    try {
      const response = await fetch("/api/auth/magic-link/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ token })
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => undefined)) as
          | { error?: { message: string } }
          | undefined;
        setState({
          kind: "error",
          message: body?.error?.message ?? `Could not accept this invite (${response.status}).`
        });
        return;
      }
      // A full navigation, not client-side routing: /roles reads the
      // session cookie this response just set, and it must do that on a
      // fresh server request rather than a client-cached one.
      window.location.href = "/roles";
    } catch (error: unknown) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "Could not accept this invite."
      });
    }
  }

  if (token === null || token.length === 0) {
    return (
      <main>
        <p className="eyebrow">Signal Audit</p>
        <h1>Invite link incomplete</h1>
        <p role="alert">This link is missing its token. Ask whoever invited you to send it again.</p>
        <p className="footnote">
          <a href="/">Back to sign in</a>.
        </p>
      </main>
    );
  }

  return (
    <main>
      <p className="eyebrow">Signal Audit</p>
      <h1>Accept invite</h1>
      <p>
        Someone invited you to join an organization on Signal Audit. Accepting signs you in and applies the
        membership they granted you.
      </p>
      <button type="button" onClick={accept} disabled={state.kind === "confirming"}>
        {state.kind === "confirming" ? "Accepting…" : "Accept invite"}
      </button>
      {state.kind === "error" && <p role="alert">{state.message}</p>}
    </main>
  );
}
