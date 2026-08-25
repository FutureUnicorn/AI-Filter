import { Suspense } from "react";

import { RedeemClient } from "./redeem-client";

export default function RedeemPage() {
  return (
    <main>
      <Suspense fallback={<p>Signing you in…</p>}>
        <RedeemClient />
      </Suspense>
    </main>
  );
}
