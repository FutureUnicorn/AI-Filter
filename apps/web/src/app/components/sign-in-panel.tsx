"use client";

import { useState, type FormEvent } from "react";

export function SignInPanel() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("sending");
    try {
      const response = await fetch("/api/auth/magic-link/request", {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": crypto.randomUUID()
        },
        body: JSON.stringify({ email })
      });
      setStatus(response.status === 202 ? "sent" : "error");
    } catch {
      setStatus("error");
    }
  }

  return (
    <section className="panel">
      <p className="eyebrow">Signal Audit</p>
      <h1>Roles</h1>
      <p>Sign in with the email an admin invited. We email a one-time link; there is no password and no self-serve signup.</p>
      <form className="stack" onSubmit={onSubmit}>
        <label htmlFor="email">Work email</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <button type="submit" disabled={status === "sending"}>
          {status === "sending" ? "Sending…" : "Email me a sign-in link"}
        </button>
      </form>
      {status === "sent" ? (
        <p className="notice">If that email has an account, a sign-in link is on its way. In local dev it is printed to the web server log.</p>
      ) : null}
      {status === "error" ? <p className="error">Could not send the link. Try again.</p> : null}
    </section>
  );
}
