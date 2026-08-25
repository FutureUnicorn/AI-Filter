import { cookies } from "next/headers";

import { loadEnvironmentConfig } from "@signal-audit/config";
import { getMembershipsForUser, getOrganizationsByIds, listRolesForOrganization } from "@signal-audit/db";
import { EMPTY_ROLE_PIPELINE_COUNTS, roleHasCapability, toRoleListItem } from "@signal-audit/domain";
import { SESSION_COOKIE_NAME } from "@signal-audit/security";

import { RolesHome } from "./components/roles-home";
import { SignInPanel } from "./components/sign-in-panel";
import { userIdFromSessionToken } from "../lib/session";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams
}: {
  searchParams: Promise<{ org?: string }>;
}) {
  const cookieStore = await cookies();
  const userId = userIdFromSessionToken(cookieStore.get(SESSION_COOKIE_NAME)?.value);
  if (userId === undefined) {
    return (
      <main>
        <SignInPanel />
      </main>
    );
  }

  const { org } = await searchParams;
  const config = loadEnvironmentConfig(process.env);
  const memberships = await getMembershipsForUser(config.database.url, config.database.schema, userId);
  const reviewable = memberships.filter((membership) => roleHasCapability(membership.role, "review_candidates"));
  const organizations = await getOrganizationsByIds(
    config.database.url,
    config.database.schema,
    memberships.map((membership) => membership.organizationId)
  );

  const requestedOrg =
    org !== undefined && reviewable.some((membership) => membership.organizationId === org)
      ? org
      : reviewable[0]?.organizationId;

  const roles =
    requestedOrg === undefined
      ? []
      : (await listRolesForOrganization(config.database.url, config.database.schema, requestedOrg)).map((role) =>
          toRoleListItem(role, EMPTY_ROLE_PIPELINE_COUNTS, "none")
        );

  return (
    <main>
      <RolesHome
        userId={userId}
        memberships={memberships}
        organizations={organizations}
        initialOrganizationId={requestedOrg ?? ""}
        initialRoles={roles}
      />
    </main>
  );
}
