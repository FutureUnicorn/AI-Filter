"use client";

import { useMemo, useState, type FormEvent } from "react";

import type { Membership, MembershipRole, Organization, RoleListItem } from "@signal-audit/domain";
import { roleHasCapability } from "@signal-audit/domain";

interface RolesHomeProps {
  readonly userId: string;
  readonly memberships: readonly Membership[];
  readonly organizations: readonly Organization[];
  readonly initialOrganizationId: string;
  readonly initialRoles: readonly RoleListItem[];
}

function organizationName(
  organizations: readonly Organization[],
  organizationId: string
): string {
  return organizations.find((organization) => organization.organizationId === organizationId)?.name ?? organizationId;
}

function membershipRole(
  memberships: readonly Membership[],
  organizationId: string
): MembershipRole | undefined {
  return memberships.find((membership) => membership.organizationId === organizationId)?.role;
}

function rubricLabel(state: RoleListItem["rubricApprovalState"]): string {
  if (state === "approved") {
    return "Approved";
  }
  if (state === "draft") {
    return "Draft";
  }
  return "No rubric";
}

function importLabel(item: RoleListItem): string {
  if (item.importReadiness.outcome === "ready") {
    return "Ready";
  }
  if (item.importReadiness.reason === "role_closed") {
    return "Closed";
  }
  if (item.importReadiness.reason === "role_not_active") {
    return "Not active";
  }
  return "Waiting on rubric";
}

export function RolesHome({
  userId,
  memberships,
  organizations,
  initialOrganizationId,
  initialRoles
}: RolesHomeProps) {
  const reviewable = useMemo(
    () =>
      memberships.filter((membership) => roleHasCapability(membership.role, "review_candidates")),
    [memberships]
  );
  const [organizationId, setOrganizationId] = useState(initialOrganizationId);
  const [roles, setRoles] = useState<readonly RoleListItem[]>(initialRoles);
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "creating" | "error">("idle");
  const [error, setError] = useState<string | undefined>(undefined);

  const currentRole = membershipRole(memberships, organizationId);
  const canManage = currentRole !== undefined && roleHasCapability(currentRole, "manage_roles");
  const canReview = currentRole !== undefined && roleHasCapability(currentRole, "review_candidates");

  async function loadRoles(nextOrganizationId: string) {
    setStatus("loading");
    setError(undefined);
    try {
      const response = await fetch(`/api/roles?organizationId=${encodeURIComponent(nextOrganizationId)}`, {
        credentials: "include"
      });
      if (!response.ok) {
        setStatus("error");
        setError("Could not load roles for this organization.");
        setRoles([]);
        return;
      }
      const body = (await response.json()) as { roles: RoleListItem[] };
      setRoles(body.roles);
      setStatus("idle");
    } catch {
      setStatus("error");
      setError("Could not load roles for this organization.");
    }
  }

  async function onSelectOrganization(nextOrganizationId: string) {
    setOrganizationId(nextOrganizationId);
    await loadRoles(nextOrganizationId);
  }

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("creating");
    setError(undefined);
    try {
      const response = await fetch("/api/roles", {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": crypto.randomUUID()
        },
        body: JSON.stringify({ organizationId, title })
      });
      if (!response.ok) {
        setStatus("error");
        setError("Could not create the role. Check that you can manage roles in this organization.");
        return;
      }
      setTitle("");
      await loadRoles(organizationId);
    } catch {
      setStatus("error");
      setError("Could not create the role.");
    }
  }

  if (reviewable.length === 0) {
    return (
      <section className="panel">
        <p className="eyebrow">Signal Audit</p>
        <h1>Roles</h1>
        <p>This working home is for recruiters. Your account does not have access to review roles in any organization.</p>
      </section>
    );
  }

  return (
    <section className="workspace">
      <header className="workspace-header">
        <div>
          <p className="eyebrow">Signal Audit</p>
          <h1>Roles</h1>
        </div>
        {reviewable.length > 1 ? (
          <label className="org-picker">
            Organization
            <select
              value={organizationId}
              onChange={(event) => {
                void onSelectOrganization(event.target.value);
              }}
            >
              {reviewable.map((membership) => (
                <option key={membership.membershipId} value={membership.organizationId}>
                  {organizationName(organizations, membership.organizationId)}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="org-name">{organizationName(organizations, organizationId)}</p>
        )}
      </header>

      <p className="lede">
        Working home for {organizationName(organizations, organizationId)}. Counts, rubric approval, and import
        readiness are per role — none of these is a ranking or a hiring recommendation.
      </p>

      {canManage ? (
        <form className="create-role" onSubmit={onCreate}>
          <label htmlFor="role-title">New hiring role</label>
          <div className="create-role-row">
            <input
              id="role-title"
              name="title"
              type="text"
              required
              maxLength={200}
              placeholder="e.g. Backend Engineer"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <button type="submit" disabled={status === "creating" || title.trim().length === 0}>
              {status === "creating" ? "Creating…" : "Create role"}
            </button>
          </div>
        </form>
      ) : null}

      {status === "loading" ? <p className="notice">Loading roles…</p> : null}
      {error !== undefined ? <p className="error">{error}</p> : null}

      {!canReview ? (
        <p className="notice">Your role in this organization cannot list hiring roles.</p>
      ) : roles.length === 0 ? (
        <p className="empty">No roles yet. Create one to start a rubric and intake.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Role</th>
                <th>Status</th>
                <th>Rubric</th>
                <th>Import</th>
                <th>Applications</th>
                <th>Processed</th>
                <th>Waiting</th>
                <th>Failed</th>
              </tr>
            </thead>
            <tbody>
              {roles.map((item) => (
                <tr key={item.role.roleId}>
                  <td>
                    <strong>{item.role.title}</strong>
                  </td>
                  <td className="status">{item.role.status}</td>
                  <td>{rubricLabel(item.rubricApprovalState)}</td>
                  <td>{importLabel(item)}</td>
                  <td className="num">{item.counts.applications}</td>
                  <td className="num">{item.counts.processed}</td>
                  <td className="num">{item.counts.waiting}</td>
                  <td className="num">{item.counts.failed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="session-meta">Signed in · {userId.slice(0, 8)}</p>
    </section>
  );
}
