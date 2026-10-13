"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { roleHasCapability } from "@signal-audit/domain";
import type { MembershipRole } from "@signal-audit/domain";

interface RoleListItem {
  readonly roleId: string;
  readonly title: string;
  readonly status: "draft" | "active" | "closed";
  readonly createdAt: string;
}

interface CallerOrganizationItem {
  readonly organizationId: string;
  readonly name: string;
  /** The domain's own union, not a re-spelled copy: the forms below gate
   * on ROLE_CAPABILITIES, so a role this page invented would type-check
   * against a policy that has never heard of it. */
  readonly role: MembershipRole;
}

type ListState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly roles: readonly RoleListItem[] };

type OrganizationState =
  | { readonly kind: "loading" }
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly organizations: readonly CallerOrganizationItem[] };

/**
 * AF-24's roles view, plus AF-97's way of reaching it.
 *
 * organizationId used to be a query parameter with nothing that could
 * produce one: a recruiter who reached this page from anywhere but a
 * hand-edited URL saw "Missing organizationId in the URL." and had no
 * way forward, which is why redeeming a magic link -- which redirects
 * here -- landed every new user on a dead end.
 *
 * The parameter still works and is still the source of truth when
 * present, so existing links keep working and a user in two
 * organizations can be pointed at a specific one. What is new is that
 * the page can now answer the question itself, from the caller's own
 * memberships.
 */
export default function RolesPage() {
  return (
    <Suspense
      fallback={
        <main>
          <p>Loading…</p>
        </main>
      }
    >
      <RolesList />
    </Suspense>
  );
}

function RolesList() {
  const requestedOrganizationId = useSearchParams().get("organizationId");
  const [organizationState, setOrganizationState] = useState<OrganizationState>({ kind: "loading" });
  const [state, setState] = useState<ListState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/me/organizations", { headers: { Accept: "application/json" } })
      .then(async (response) => {
        if (cancelled) return;
        if (response.status === 401) {
          setOrganizationState({ kind: "unauthenticated" });
          return;
        }
        const body = (await response.json()) as {
          organizations?: CallerOrganizationItem[];
          error?: { message: string };
        };
        if (cancelled) return;
        if (!response.ok) {
          setOrganizationState({
            kind: "error",
            message: body.error?.message ?? `Request failed (${response.status}).`
          });
          return;
        }
        setOrganizationState({ kind: "ready", organizations: body.organizations ?? [] });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setOrganizationState({
          kind: "error",
          message: error instanceof Error ? error.message : "Request failed."
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * The organization actually in effect. An explicit `?organizationId=`
   * wins, including one the caller turns out not to belong to -- that
   * request is still made, and the API answers not_found, which is the
   * honest outcome rather than this page silently substituting an
   * organization the user did not ask for. Otherwise a sole membership
   * is used directly, because asking someone to choose between one
   * option is not a choice.
   */
  const organizations = organizationState.kind === "ready" ? organizationState.organizations : [];
  const soleOrganizationId = organizations.length === 1 ? organizations[0]?.organizationId : undefined;
  const organizationId = requestedOrganizationId ?? soleOrganizationId;
  const activeOrganization = organizations.find(
    (organization) => organization.organizationId === organizationId
  );

  const loadRoles = useCallback((): (() => void) | undefined => {
    if (organizationId === undefined) {
      return undefined;
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

  useEffect(() => loadRoles(), [loadRoles]);

  if (organizationState.kind === "loading") {
    return (
      <main>
        <p>Loading…</p>
      </main>
    );
  }

  if (organizationState.kind === "unauthenticated") {
    return (
      <main>
        <p className="eyebrow">Roles</p>
        <h1>Sign in first</h1>
        <p>
          Your session has expired or you have not signed in yet. <a href="/">Request a sign-in link</a>.
        </p>
      </main>
    );
  }

  if (organizationState.kind === "error") {
    return (
      <main>
        <p role="alert">Could not load your organizations: {organizationState.message}</p>
      </main>
    );
  }

  // A signed-in user with no membership is a real state, not an error:
  // an invite creates the membership on redemption, so it means the
  // invite has not been accepted or was issued for a different address.
  if (organizations.length === 0) {
    return (
      <main>
        <p className="eyebrow">Roles</p>
        <h1>No organizations yet</h1>
        <p>
          You are signed in, but you do not belong to an organization. Ask an owner or admin to invite
          this email address — an invite is what creates the membership.
        </p>
      </main>
    );
  }

  if (organizationId === undefined) {
    return (
      <main>
        <p className="eyebrow">Organizations</p>
        <h1>Choose an organization</h1>
        <p>You belong to more than one. Everything below is scoped to the one you pick.</p>
        <ul className="organization-list">
          {organizations.map((organization) => (
            <li key={organization.organizationId}>
              <a href={`/roles?organizationId=${encodeURIComponent(organization.organizationId)}`}>
                {organization.name}
              </a>{" "}
              <span className="data-table-pending">({organization.role})</span>
            </li>
          ))}
        </ul>
      </main>
    );
  }

  return (
    <main>
      <p className="eyebrow">Roles</p>
      <h1>Your hiring roles</h1>

      <p>
        {activeOrganization === undefined
          ? `Organization ${organizationId}`
          : `${activeOrganization.name} — you are ${activeOrganization.role} here`}
        {organizations.length > 1 && (
          <>
            {" "}
            <a href="/roles">Switch organization</a>
          </>
        )}
      </p>

      {state.kind === "loading" && <p>Loading roles…</p>}
      {state.kind === "error" && <p role="alert">Could not load roles: {state.message}</p>}
      {state.kind === "ready" && state.roles.length === 0 && <p>No roles yet for this organization.</p>}
      {state.kind === "ready" && state.roles.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Title</th>
              <th scope="col">Status</th>
              <th scope="col">Created</th>
              <th scope="col">Rubric approval</th>
              <th scope="col">Import readiness</th>
              <th scope="col">Open</th>
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
                <td>
                  {/*
                    Rubric and applications only. The import page needs an
                    `?intakeId=`, and nothing in this app can create an
                    intake yet -- POST /api/roles/[roleId]/files has no UI
                    caller -- so a link to it would be a dead end wearing a
                    working link's clothes. The upload step is its own
                    ticket.
                  */}
                  <a href={`/roles/${role.roleId}/rubric`}>Rubric</a>{" "}
                  <a href={`/roles/${role.roleId}/applications`}>Applications</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/*
        Both forms are shown only to a role that holds the capability the
        API will check, and both ask ROLE_CAPABILITIES rather than naming
        roles here. This is presentation, not enforcement -- each route
        authorizes the caller server-side regardless of what this page
        rendered -- but offering someone a form guaranteed to be refused
        is its own kind of dishonesty.

        Review #88: `CreateRole` was rendered unconditionally, so an
        auditor (no `manage_roles`) got a form that always 403s, and so
        did a caller who reached an `?organizationId=` they have no
        membership for -- `activeOrganization` is undefined there, which
        is exactly the case to render nothing for. The invite form had
        the gate and the role form did not; deriving both from the same
        policy is what stops them diverging again.
      */}
      {activeOrganization !== undefined && roleHasCapability(activeOrganization.role, "manage_roles") && (
        <CreateRole organizationId={organizationId} onCreated={loadRoles} />
      )}

      {activeOrganization !== undefined &&
        roleHasCapability(activeOrganization.role, "access_admin_settings") && (
          <InviteMember organizationId={organizationId} />
        )}
    </main>
  );
}

/**
 * `POST /api/roles` had no caller either, so an organization created by
 * the bootstrap command contained nothing and there was no role for a
 * rubric or an application to belong to. Recruiter and above hold
 * `manage_roles`; an auditor does not, and the API says so rather than
 * this form guessing at the policy.
 */
function CreateRole({
  organizationId,
  onCreated
}: {
  readonly organizationId: string;
  readonly onCreated: () => void;
}) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function create(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ organizationId, title })
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => undefined)) as
          | { error?: { message: string } }
          | undefined;
        setError(body?.error?.message ?? `Request failed (${response.status}).`);
        return;
      }
      setTitle("");
      onCreated();
      // The roles list is client-fetched, so onCreated is what actually
      // refreshes it; this keeps the router cache from serving a stale
      // render of this route later.
      router.refresh();
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stacked-form" onSubmit={create}>
      <h2>Add a role</h2>
      <label htmlFor="role-title">Role title</label>
      <input
        id="role-title"
        name="title"
        type="text"
        required
        maxLength={200}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        disabled={busy}
      />
      <button type="submit" disabled={busy || title.trim().length === 0}>
        {busy ? "Creating…" : "Create role"}
      </button>
      {error !== undefined && <p role="alert">Could not create the role: {error}</p>}
    </form>
  );
}

/**
 * AF-97: the owner/admin side of invite-only authentication.
 *
 * `POST /api/invites` is the first HTTP exposure of AF-16's invite
 * machinery, and this is its caller. Without it, the only way to add the
 * second person to a deployment was `curl` with a hand-made
 * Idempotency-Key.
 */
function InviteMember({ organizationId }: { readonly organizationId: string }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MembershipRole>("recruiter");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  /** Set when the API refused because this would replace an existing role,
   * so the confirmation is a second, deliberate action rather than a
   * checkbox nobody reads. */
  const [replaceConflict, setReplaceConflict] = useState<string | undefined>(undefined);

  async function send(replaceExistingRole: boolean): Promise<void> {
    setBusy(true);
    setSent(false);
    setError(undefined);
    try {
      const response = await fetch("/api/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          email,
          organizationId,
          role,
          ...(replaceExistingRole ? { replaceExistingRole: true } : {})
        })
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => undefined)) as
          | { error?: { code?: string; message: string } }
          | undefined;
        const message = body?.error?.message ?? `Request failed (${response.status}).`;
        // A 409 naming an existing role is the opt-in prompt, not a failure
        // to report and forget: the admin is one confirmed click from what
        // they meant, and the message already names the current role.
        if (response.status === 409 && !replaceExistingRole && /already belongs/u.test(message)) {
          setReplaceConflict(message);
          return;
        }
        setError(message);
        return;
      }
      setEmail("");
      setReplaceConflict(undefined);
      setSent(true);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  async function invite(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setReplaceConflict(undefined);
    await send(false);
  }

  return (
    <form className="stacked-form" onSubmit={invite}>
      <h2>Invite someone</h2>
      <p className="footnote">
        They receive a single-use link. Opening it creates their account and their membership in this
        organization with the role you choose here.
      </p>
      {/*
        Review #88, REV-002: the copy above described only the add case, and
        the endpoint also replaces an existing member's role. That is now
        refused unless the admin opts in, and this says so before they send,
        rather than leaving them to discover it from a 409.
      */}
      <p className="footnote">
        If they already belong to this organization, sending this replaces their current role — the
        change takes effect when they open the link. You will be asked to confirm.
      </p>
      <label htmlFor="invite-email">Their work email</label>
      <input
        id="invite-email"
        name="email"
        type="email"
        autoComplete="off"
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        disabled={busy}
      />
      <label htmlFor="invite-role">Role</label>
      <select
        id="invite-role"
        name="role"
        value={role}
        onChange={(event) => setRole(event.target.value as MembershipRole)}
        disabled={busy}
      >
        <option value="owner">owner — full control, including admin settings</option>
        <option value="admin">admin — approve rubrics, review, invite</option>
        <option value="recruiter">recruiter — manage roles, review, record decisions</option>
        <option value="auditor">auditor — read-only oversight</option>
      </select>
      <button type="submit" disabled={busy || email.length === 0}>
        {busy ? "Sending…" : "Send invite"}
      </button>
      {replaceConflict !== undefined && (
        <div role="alert" className="notice">
          <p>{replaceConflict}</p>
          <button type="button" onClick={() => void send(true)} disabled={busy}>
            {busy ? "Sending…" : `Yes, change their role to ${role}`}
          </button>
        </div>
      )}
      {sent && <p role="status">Invite sent. It expires shortly and can be used once.</p>}
      {error !== undefined && <p role="alert">Could not send the invite: {error}</p>}
    </form>
  );
}
