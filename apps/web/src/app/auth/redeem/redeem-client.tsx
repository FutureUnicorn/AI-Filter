"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export function RedeemClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const [message, setMessage] = useState("Signing you in…");

  useEffect(() => {
    if (token === null || token.length === 0) {
      setMessage("This sign-in link is missing its token. Request a new one from the home page.");
      return;
    }

    let cancelled = false;

    async function redeem() {
      try {
        const response = await fetch("/api/auth/magic-link/redeem", {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": crypto.randomUUID()
          },
          body: JSON.stringify({ token })
        });
        if (cancelled) {
          return;
        }
        if (!response.ok) {
          setMessage("This sign-in link is invalid, expired, or already used. Request a new one from the home page.");
          return;
        }
        router.replace("/");
        router.refresh();
      } catch {
        if (!cancelled) {
          setMessage("Could not complete sign-in. Request a new link from the home page.");
        }
      }
    }

    void redeem();
    return () => {
      cancelled = true;
    };
  }, [router, token]);

  return (
    <section className="panel">
      <p className="eyebrow">Signal Audit</p>
      <h1>Sign in</h1>
      <p>{message}</p>
    </section>
  );
}
