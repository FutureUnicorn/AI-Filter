"use client";

import { Suspense, useState } from "react";
import type { FormEvent } from "react";
import { useSearchParams } from "next/navigation";

/**
 * AF-97: the sign-in entry point, and the only page that reads the
 * `?auth=` codes `GET /auth/redeem` has always redirected here with.
 *
 * Both halves were missing. `POST /api/auth/magic-link/request` had no
 * caller anywhere in the app, so the one way to request a link was
 * `curl`; and every redemption failure redirected to `/?auth=<reason>`
 * where nothing read it, so an expired link, an unknown account and a
 * server fault were all indistinguishable from a page that had simply
 * reloaded.
 *
 * The codes are a closed map rather than text taken from the query
 * string: the parameter is attacker-supplied, and a page that renders
 * whatever it is handed is a page that can be linked to with someone
 * else's wording. An unrecognized code gets the generic message, not
 * its own text.
 */
const AUTH_FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  missing_token: "That sign-in link was incomplete. Request a new one below.",
  invalid_link:
    "That sign-in link has expired or was already used. Sign-in links work once; request a new one below.",
  no_account:
    "That link is valid, but no account here matches its email address. Ask an owner or admin of your organization to invite you.",
  error: "Something went wrong while signing you in. Request a new link and try again."
};

const GENERIC_AUTH_FAILURE = "Sign-in did not complete. Request a new link below.";

type RequestState =
  | { readonly kind: "idle" }
  | { readonly kind: "sending" }
  | { readonly kind: "sent" }
  | { readonly kind: "error"; readonly message: string };

export default function Home() {
  return (
    <Suspense
      fallback={
        <main>
          <p>Loading…</p>
        </main>
      }
    >
      <SignIn />
    </Suspense>
  );
}

function SignIn() {
  const authCode = useSearchParams().get("auth");
  const [email, setEmail] = useState("");
  const [state, setState] = useState<RequestState>({ kind: "idle" });

  async function requestLink(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setState({ kind: "sending" });
    try {
      const response = await fetch("/api/auth/magic-link/request", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ email })
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => undefined)) as
          | { error?: { message: string } }
          | undefined;
        setState({
          kind: "error",
          message: body?.error?.message ?? `Request failed (${response.status}).`
        });
        return;
      }
      setState({ kind: "sent" });
    } catch (error: unknown) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "Request failed." });
    }
  }

  return (
    <main>
      <p className="eyebrow">Signal Audit</p>
      <h1>Sign in</h1>

      {authCode !== null && (
        <p role="alert" className="notice">
          {AUTH_FAILURE_MESSAGES[authCode] ?? GENERIC_AUTH_FAILURE}
        </p>
      )}

      <p>
        Enter the email address your organization invited. We will send a single-use link that signs you
        in — there is no password to remember or lose.
      </p>

      <form onSubmit={requestLink}>
        <label htmlFor="email">Work email</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={state.kind === "sending"}
        />
        <button type="submit" disabled={state.kind === "sending" || email.length === 0}>
          {state.kind === "sending" ? "Sending…" : "Email me a sign-in link"}
        </button>
      </form>

      {/*
        The same confirmation whether or not the address has an account.
        The endpoint answers 202 either way on purpose -- a response that
        varied would turn this form into a way to test whether a given
        person works here -- so the wording must not quietly undo that by
        promising mail that is not coming.
      */}
      {state.kind === "sent" && (
        <p role="status">
          If that address has an account here, a sign-in link is on its way. It expires shortly, and
          using it signs you in on this device.
        </p>
      )}
      {state.kind === "error" && <p role="alert">Could not request a link: {state.message}</p>}

      <p className="footnote">
        Already signed in? <a href="/roles">Go to your organizations</a>.
      </p>
    </main>
  );
}
