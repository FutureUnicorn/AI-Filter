"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

interface RoleListItem {
  readonly roleId: string;
  readonly title: string;
  readonly status: "draft" | "active" | "closed";
  readonly createdAt: string;
}

type ListState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly roles: readonly RoleListItem[] };

/**
 * AF-24: the recruiter's working-home view of an organization's roles.
 * organizationId travels as a query param (?organizationId=...) rather
 * than being read from an org-switcher UI, since no such shell exists
 * yet anywhere in this app -- that's separate, unticketed infrastructure,
 * not something to invent inside this ticket.
 *
 * Rubric approval state and import readiness are shown as "not available
 * yet" rather than fabricated: neither AF-27 (rubric publishing) nor
 * AF-32 (import finalization) exists yet, so there is no honest value
 * to show in those columns.
 */
export default function RolesPage() {
  return (
    <Suspense fallback={<main><p>Loading…</p></main>}>
      <RolesList />
    </Suspense>
  );
}

function RolesList() {
  const organizationId = useSearchParams().get("organizationId");
  const [state, setState] = useState<ListState>({ kind: "loading" });

  useEffect(() => {
    if (organizationId === null) {
      setState({ kind: "error", message: "Missing organizationId in the URL." });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    fetch(`/api/roles?organizationId=${encodeURIComponent(organizationId)}`, {
      headers: { Accept: "application/json" }
    })
      .then(async (response) => {
        const body = (await response.json()) as { roles?: RoleListItem[]; error?: { message: string } };
        if (cancelled) return;
        if (!response.ok) {
          setState({ kind: "error", message: body.error?.message ?? `Request failed (${response.status}).` });
          return;
        }
        setState({ kind: "ready", roles: body.roles ?? [] });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({ kind: "error", message: error instanceof Error ? error.message : "Request failed." });
      });
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  return (
    <main>
      <p className="eyebrow">Roles</p>
      <h1>Your hiring roles</h1>

      {state.kind === "loading" && <p>Loading roles…</p>}
      {state.kind === "error" && <p role="alert">Could not load roles: {state.message}</p>}
      {state.kind === "ready" && state.roles.length === 0 && (
        <p>No roles yet for this organization.</p>
      )}
      {state.kind === "ready" && state.roles.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Title</th>
              <th scope="col">Status</th>
              <th scope="col">Created</th>
              <th scope="col">Rubric approval</th>
              <th scope="col">Import readiness</th>
            </tr>
          </thead>
          <tbody>
            {state.roles.map((role) => (
              <tr key={role.roleId}>
                <td>{role.title}</td>
                <td>{role.status}</td>
                <td>{new Date(role.createdAt).toLocaleDateString()}</td>
                <td className="data-table-pending">Not available yet</td>
                <td className="data-table-pending">Not available yet</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
