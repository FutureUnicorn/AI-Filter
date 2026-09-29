"use client";

import { useState } from "react";

/**
 * The interactive half of `/auth/confirm`. Takes no token: it lives only
 * in the `HttpOnly` cookie `GET /auth/redeem` set (review #88 round 5,
 * REV-002), which this script cannot read and does not need to -- the
 * click just tells `POST /auth/confirm/accept` to act on whatever the
 * browser attaches, and that route reads the cookie itself.
 */
type ConfirmState =
  | { readonly kind: "idle" }
  | { readonly kind: "confirming" }
  | { readonly kind: "error"; readonly message: string };

export function AcceptInviteButton({ label }: { readonly label: string }) {
  const [state, setState] = useState<ConfirmState>({ kind: "idle" });

  async function accept(): Promise<void> {
    setState({ kind: "confirming" });
    try {
      const response = await fetch("/auth/confirm/accept", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() }
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

  return (
    <>
      <button type="button" onClick={accept} disabled={state.kind === "confirming"}>
        {state.kind === "confirming" ? "Accepting…" : label}
      </button>
      {state.kind === "error" && <p role="alert">{state.message}</p>}
    </>
  );
}
