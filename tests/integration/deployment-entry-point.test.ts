import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

import {
  bootstrapOrganizationOwner,
  dropProbeSchema,
  getMembershipIdForEmail,
  listAuditEventsForEntity,
  listOrganizationsForUser,
  provisionRouteProbeSchema,
  seedOrganizationMembership
} from "../../packages/db/src/index.ts";
import { REQUEST_ID_HEADER } from "../../packages/contracts/src/index.ts";
import {
  SESSION_COOKIE_NAME,
  createSessionToken,
  hashMagicLinkToken
} from "../../packages/security/src/index.ts";
import { loadWebRoute } from "../support/web-route-loader.ts";

/**
 * AF-97: can a human get into a freshly migrated deployment at all.
 *
 * Every piece of authentication already had passing tests -- token
 * generation, atomic single-use redemption, the verification decision,
 * the session cookie, resource authorization -- and the product was
 * still unreachable, because nothing created the first organization,
 * user or membership, and nothing exposed the invite machinery over
 * HTTP. `POST /api/auth/magic-link/request` only mails a link to an
 * address that already holds a membership, so on an empty database it
 * correctly mailed nobody, forever.
 *
 * That is the failure this file exists to make impossible to reintroduce:
 * it starts from a schema with nothing in it and walks the whole path an
 * operator and then a user actually walk. Individually-green pieces
 * either side of a missing entry point prove nothing about entering a
 * deployment.
 */

const SESSION_SECRET = "entry-point-test-session-secret-at-least-32-chars";

function requireDatabase(): string {
  const databaseUrl = process.env.SIGNAL_AUDIT_RLS_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    assert.fail(
      "SIGNAL_AUDIT_RLS_DATABASE_URL must be set to a real Postgres connection string so this test drives the " +
        "bootstrap command and the entry-point routes against a real database. Locally: run `pnpm dev:infra`, " +
        "then set it to postgresql://signal_audit_local:local-only-password@localhost:5432/signal_audit_local " +
        "(see README.md)."
    );
  }
  return databaseUrl;
}

/** The routes read process.env at request time through
 * loadEnvironmentConfig, so the environment is the only injection point
 * available without changing their signatures. `test` selects the console
 * sender, which is the same path a developer runs locally. */
function applyRouteEnvironment(databaseUrl: string, routeSchema: string): void {
  Object.assign(process.env, {
    APP_ENV: "test",
    DEPLOYMENT_COMMIT_SHA: "0000000",
    DATABASE_URL: databaseUrl,
    DATABASE_SCHEMA: routeSchema,
    STORAGE_ENDPOINT: "http://localhost:9000",
    STORAGE_REGION: "us-east-1",
    STORAGE_BUCKET: "signal-audit-test",
    STORAGE_ACCESS_KEY_ID: "test-access-key",
    STORAGE_SECRET_ACCESS_KEY: "test-secret-access-key",
    STORAGE_FORCE_PATH_STYLE: "true",
    WEB_PORT: "3000",
    WORKER_PORT: "3001",
    PUBLIC_APP_ORIGIN: "https://canonical.acme.test",
    SESSION_SECRET
  });
  delete process.env.MAGIC_LINK_EMAIL_ENDPOINT;
  delete process.env.MAGIC_LINK_EMAIL_API_KEY;
  delete process.env.MAGIC_LINK_EMAIL_FROM;
}

/** In a local environment the console sender IS the delivery mechanism,
 * so reading stderr for the link is exactly what a developer does. */
async function captureStderr(action: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await action();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join("");
}

function extractToken(emitted: string): string {
  const token = /[?&]token=([^\s&"]+)/u.exec(emitted)?.[1];
  assert.ok(
    token !== undefined && token !== "[REDACTED]",
    `a usable token must be obtainable from the local delivery channel, got: ${JSON.stringify(emitted)}`
  );
  return token;
}

interface PostRouteModule {
  POST(request: Request): Promise<Response>;
}

interface GetRouteModule {
  GET(request: Request): Promise<Response>;
}

/**
 * The genuine NextRequest, loaded from apps/web's own installed Next.
 *
 * readSessionUserId reads `request.cookies.get(...)`, which is Next's API
 * and not the WHATWG Request's. Hand-rolling a `cookies` object would be
 * faking the exact surface every authenticated handler here authenticates
 * through, so the real class is used and only its module path is resolved
 * by hand: `next` is installed under apps/web, which a test at the
 * repository root cannot reach by bare specifier.
 */
const nextServerUrl = new URL("../../apps/web/node_modules/next/server.js", import.meta.url).href;
const { NextRequest } = (await import(nextServerUrl)) as {
  NextRequest: new (url: string, init?: RequestInit) => Request;
};

const REQUEST_ROUTE = "../../apps/web/src/app/api/auth/magic-link/request/route.ts";
const REDEEM_ROUTE = "../../apps/web/src/app/api/auth/magic-link/redeem/route.ts";
const INVITE_ROUTE = "../../apps/web/src/app/api/invites/route.ts";
const ORGANIZATIONS_ROUTE = "../../apps/web/src/app/api/me/organizations/route.ts";
const ROLES_ROUTE = "../../apps/web/src/app/api/roles/route.ts";

function sessionCookie(userId: string): string {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(createSessionToken(userId, SESSION_SECRET))}`;
}

function authenticatedJsonRequest(
  url: string,
  body: unknown,
  idempotencyKey: string,
  userId: string
): Request {
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": idempotencyKey,
      cookie: sessionCookie(userId)
    },
    body: JSON.stringify(body)
  });
}

function authenticatedGetRequest(url: string, userId: string): Request {
  return new NextRequest(url, { headers: { cookie: sessionCookie(userId) } });
}

test("an operator can bootstrap the first owner of an empty deployment and sign in as them", async () => {
  const databaseUrl = requireDatabase();
  const schema = await provisionRouteProbeSchema(databaseUrl);
  const email = `founder-${Date.now()}@acme.test`;
  try {
    applyRouteEnvironment(databaseUrl, schema);

    // Precondition, and the whole reason this ticket exists: before the
    // bootstrap there is no address the login endpoint will mail.
    const requestRoute = await loadWebRoute<PostRouteModule>(import.meta.url, REQUEST_ROUTE);
    const beforeBootstrap = await captureStderr(async () => {
      const response = await requestRoute.POST(
        new NextRequest("http://localhost:3000/api/auth/magic-link/request", {
          method: "POST",
          headers: { "content-type": "application/json", "Idempotency-Key": "pre-bootstrap" },
          body: JSON.stringify({ email })
        })
      );
      assert.equal(response.status, 202);
    });
    assert.equal(
      /[?&]token=/u.test(beforeBootstrap),
      false,
      "an empty deployment must mail nobody -- that is the gap, not a bug in the endpoint"
    );

    const bootstrapped = await bootstrapOrganizationOwner(databaseUrl, schema, {
      organizationName: "Acme",
      email,
      displayName: "Dana Ops"
    });
    assert.equal(bootstrapped.organizationCreated, true);
    assert.equal(bootstrapped.userCreated, true);
    assert.equal(bootstrapped.membership, "created");

    // The same request, now that somebody exists, produces a redeemable
    // credential -- which is the definition of "the deployment can be
    // entered".
    const emitted = await captureStderr(async () => {
      const response = await requestRoute.POST(
        new NextRequest("http://localhost:3000/api/auth/magic-link/request", {
          method: "POST",
          headers: { "content-type": "application/json", "Idempotency-Key": "post-bootstrap" },
          body: JSON.stringify({ email })
        })
      );
      assert.equal(response.status, 202);
    });

    const redeemRoute = await loadWebRoute<PostRouteModule>(import.meta.url, REDEEM_ROUTE);
    const redeemed = await redeemRoute.POST(
      new NextRequest("http://localhost:3000/api/auth/magic-link/redeem", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": "redeem-founder" },
        body: JSON.stringify({ token: extractToken(emitted) })
      })
    );
    assert.equal(redeemed.status, 200, await redeemed.clone().text());
    const redemption = (await redeemed.json()) as { userId: string; email: string };
    assert.equal(redemption.userId, bootstrapped.userId);
    assert.equal(redemption.email, email);
  } finally {
    await dropProbeSchema(databaseUrl, schema);
  }
});

test("re-running the bootstrap converges instead of creating a second organization", async () => {
  const databaseUrl = requireDatabase();
  const schema = await provisionRouteProbeSchema(databaseUrl);
  const email = `repeat-${Date.now()}@acme.test`;
  try {
    const first = await bootstrapOrganizationOwner(databaseUrl, schema, {
      organizationName: "Repeat Co",
      email,
      displayName: "Dana Ops"
    });
    const second = await bootstrapOrganizationOwner(databaseUrl, schema, {
      organizationName: "Repeat Co",
      email,
      displayName: "Dana Ops"
    });

    // An operator re-running a command after an ambiguous failure is the
    // normal case, not the exceptional one. Two organizations of the same
    // name, each owned by the same person, is the outcome that would be
    // impossible to notice and painful to unpick.
    assert.equal(second.organizationId, first.organizationId);
    assert.equal(second.userId, first.userId);
    assert.equal(second.organizationCreated, false);
    assert.equal(second.userCreated, false);
    assert.equal(second.membership, "unchanged");

    const organizations = await listOrganizationsForUser(databaseUrl, schema, first.userId);
    assert.equal(organizations.length, 1);
    assert.equal(organizations[0]?.name, "Repeat Co");
    assert.equal(organizations[0]?.role, "owner");
  } finally {
    await dropProbeSchema(databaseUrl, schema);
  }
});

test("bootstrapping an address that already belongs to the organization promotes it, and says so", async () => {
  const databaseUrl = requireDatabase();
  const schema = await provisionRouteProbeSchema(databaseUrl);
  const organizationId = "22222222-2222-4222-8222-222222222222";
  const email = `promote-${Date.now()}@acme.test`;
  try {
    await seedOrganizationMembership(databaseUrl, schema, {
      organizationId,
      organizationName: "Promote Co",
      email,
      displayName: "Dana Ops",
      role: "recruiter"
    });

    const result = await bootstrapOrganizationOwner(databaseUrl, schema, {
      organizationName: "Promote Co",
      email,
      displayName: "Dana Ops"
    });

    // Granting ownership to somebody who is already a member is the one
    // change this command can make to existing data, so it is reported
    // rather than silent: an operator re-running it to recover access
    // should be able to see that they changed a role, not just that the
    // command exited zero.
    assert.equal(result.organizationId, organizationId);
    assert.equal(result.organizationCreated, false);
    assert.equal(result.userCreated, false);
    assert.equal(result.membership, "promoted");

    const organizations = await listOrganizationsForUser(databaseUrl, schema, result.userId);
    assert.deepEqual(
      organizations.map((organization) => organization.role),
      ["owner"]
    );
  } finally {
    await dropProbeSchema(databaseUrl, schema);
  }
});

test("a bootstrapped owner can invite a recruiter, who redeems into a real membership", async () => {
  const databaseUrl = requireDatabase();
  const schema = await provisionRouteProbeSchema(databaseUrl);
  const ownerEmail = `owner-${Date.now()}@acme.test`;
  const recruiterEmail = `recruiter-${Date.now()}@acme.test`;
  try {
    applyRouteEnvironment(databaseUrl, schema);
    const owner = await bootstrapOrganizationOwner(databaseUrl, schema, {
      organizationName: "Invite Co",
      email: ownerEmail,
      displayName: "Dana Ops"
    });

    const inviteRoute = await loadWebRoute<PostRouteModule>(import.meta.url, INVITE_ROUTE);
    let inviteRequestId: string | null = null;
    const emitted = await captureStderr(async () => {
      const response = await inviteRoute.POST(
        authenticatedJsonRequest(
          "http://localhost:3000/api/invites",
          { email: recruiterEmail, organizationId: owner.organizationId, role: "recruiter" },
          "invite-key-1",
          owner.userId
        )
      );
      assert.equal(response.status, 202, await response.clone().text());
      inviteRequestId = response.headers.get(REQUEST_ID_HEADER);
      // The invite token is a bearer credential for the invitee's mailbox;
      // echoing it to the inviter would make it interceptable by anyone who
      // can read the response.
      assert.equal(await response.text(), "");
    });

    const token = extractToken(emitted);

    /*
     * The audit row, read back rather than inferred (review #88).
     *
     * An earlier version of this test treated the 202 above as proof that
     * the `admin_action` event had been written. It is not: deleting the
     * appendAuditEvent call outright would still insert the token, send the
     * mail and answer 202, and this test would have gone on passing while
     * AF-20's "every consequential action is attributable" invariant was
     * unenforced. Granting a role in an organization is exactly that kind
     * of action, so every field that makes it attributable is checked --
     * who did it, where, what, and under which request.
     */
    assert.ok(inviteRequestId !== null, "the invite response must carry a request id");
    const auditEvents = await listAuditEventsForEntity(
      databaseUrl,
      schema,
      "membership_invite",
      hashMagicLinkToken(token)
    );
    assert.deepEqual(auditEvents, [
      {
        organizationId: owner.organizationId,
        actorUserId: owner.userId,
        action: "admin_action",
        entityType: "membership_invite",
        // The token hash, never the invited address: audit_events is
        // append-only by trigger with no delete path, so an email written
        // there could never be removed.
        entityId: hashMagicLinkToken(token),
        requestId: inviteRequestId
      }
    ]);
    assert.equal(
      auditEvents[0]?.entityId.includes(recruiterEmail),
      false,
      "the audit trail must not carry the invited address"
    );

    const redeemRoute = await loadWebRoute<PostRouteModule>(import.meta.url, REDEEM_ROUTE);
    const redeemed = await redeemRoute.POST(
      new NextRequest("http://localhost:3000/api/auth/magic-link/redeem", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": "redeem-invite" },
        body: JSON.stringify({ token })
      })
    );
    assert.equal(redeemed.status, 200, await redeemed.clone().text());
    const redemption = (await redeemed.json()) as { userId: string; email: string };
    assert.equal(redemption.email, recruiterEmail);

    // Redemption is what creates the account AND the membership, in one
    // transaction. A user row without the invited membership would be a
    // stuck half-onboarded account, which the login path reports as
    // "no account" -- indistinguishable from never having been invited.
    const organizations = await listOrganizationsForUser(databaseUrl, schema, redemption.userId);
    assert.deepEqual(
      organizations.map((organization) => [organization.organizationId, organization.role]),
      [[owner.organizationId, "recruiter"]]
    );
  } finally {
    await dropProbeSchema(databaseUrl, schema);
  }
});

test("a recruiter cannot invite: the invite route gates on access_admin_settings, not manage_roles", async () => {
  const databaseUrl = requireDatabase();
  const schema = await provisionRouteProbeSchema(databaseUrl);
  const ownerEmail = `gate-owner-${Date.now()}@acme.test`;
  const recruiterEmail = `gate-recruiter-${Date.now()}@acme.test`;
  try {
    applyRouteEnvironment(databaseUrl, schema);
    const owner = await bootstrapOrganizationOwner(databaseUrl, schema, {
      organizationName: "Gate Co",
      email: ownerEmail,
      displayName: "Dana Ops"
    });

    const inviteRoute = await loadWebRoute<PostRouteModule>(import.meta.url, INVITE_ROUTE);
    const redeemRoute = await loadWebRoute<PostRouteModule>(import.meta.url, REDEEM_ROUTE);
    const emitted = await captureStderr(async () => {
      await inviteRoute.POST(
        authenticatedJsonRequest(
          "http://localhost:3000/api/invites",
          { email: recruiterEmail, organizationId: owner.organizationId, role: "recruiter" },
          "gate-invite-1",
          owner.userId
        )
      );
    });
    const redeemed = await redeemRoute.POST(
      new NextRequest("http://localhost:3000/api/auth/magic-link/redeem", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": "gate-redeem" },
        body: JSON.stringify({ token: extractToken(emitted) })
      })
    );
    const recruiter = (await redeemed.json()) as { userId: string };

    // A recruiter holds `manage_roles` and can create hiring roles. Adding
    // people to the tenant is a different authority, and using the wrong
    // capability here would hand every recruiter the ability to mint an
    // owner. 403 rather than 404, because they do belong to this
    // organization -- the honest distinction AF-19 draws.
    const refused = await inviteRoute.POST(
      authenticatedJsonRequest(
        "http://localhost:3000/api/invites",
        { email: `escalation-${Date.now()}@acme.test`, organizationId: owner.organizationId, role: "owner" },
        "gate-invite-2",
        recruiter.userId
      )
    );
    assert.equal(refused.status, 403, await refused.clone().text());
  } finally {
    await dropProbeSchema(databaseUrl, schema);
  }
});

test("an invite for an organization the caller does not belong to is not_found, not forbidden", async () => {
  const databaseUrl = requireDatabase();
  const schema = await provisionRouteProbeSchema(databaseUrl);
  try {
    applyRouteEnvironment(databaseUrl, schema);
    const acme = await bootstrapOrganizationOwner(databaseUrl, schema, {
      organizationName: "Acme Outsider",
      email: `outsider-a-${Date.now()}@acme.test`,
      displayName: "Dana Ops"
    });
    const other = await bootstrapOrganizationOwner(databaseUrl, schema, {
      organizationName: "Other Co",
      email: `outsider-b-${Date.now()}@other.test`,
      displayName: "Sam Ops"
    });

    const inviteRoute = await loadWebRoute<PostRouteModule>(import.meta.url, INVITE_ROUTE);
    const response = await inviteRoute.POST(
      authenticatedJsonRequest(
        "http://localhost:3000/api/invites",
        { email: `cross-${Date.now()}@other.test`, organizationId: other.organizationId, role: "admin" },
        "cross-tenant-invite",
        acme.userId
      )
    );
    // 404, not 403: telling a caller with no relationship to an
    // organization that it exists but they may not touch it confirms the
    // organizationId is real.
    assert.equal(response.status, 404, await response.clone().text());
  } finally {
    await dropProbeSchema(databaseUrl, schema);
  }
});

test("a signed-in user can discover their own organizations and reach a role without a hand-made URL", async () => {
  const databaseUrl = requireDatabase();
  const schema = await provisionRouteProbeSchema(databaseUrl);
  const email = `navigator-${Date.now()}@acme.test`;
  try {
    applyRouteEnvironment(databaseUrl, schema);
    const owner = await bootstrapOrganizationOwner(databaseUrl, schema, {
      organizationName: "Navigable Co",
      email,
      displayName: "Dana Ops"
    });

    const organizationsRoute = await loadWebRoute<GetRouteModule>(import.meta.url, ORGANIZATIONS_ROUTE);
    const anonymous = await organizationsRoute.GET(
      new NextRequest("http://localhost:3000/api/me/organizations")
    );
    assert.equal(anonymous.status, 401, "the switcher must not answer without a session");

    const listed = await organizationsRoute.GET(
      authenticatedGetRequest("http://localhost:3000/api/me/organizations", owner.userId)
    );
    assert.equal(listed.status, 200, await listed.clone().text());
    const body = (await listed.json()) as {
      organizations: { organizationId: string; name: string; role: string }[];
    };
    assert.deepEqual(
      body.organizations.map((organization) => [
        organization.organizationId,
        organization.name,
        organization.role
      ]),
      [[owner.organizationId, "Navigable Co", "owner"]]
    );

    // The organizationId the switcher hands back is the one the roles API
    // accepts. That is the whole navigation claim: nothing in this chain
    // came from a human editing a query string.
    const rolesRoute = await loadWebRoute<PostRouteModule & GetRouteModule>(import.meta.url, ROLES_ROUTE);
    const created = await rolesRoute.POST(
      authenticatedJsonRequest(
        "http://localhost:3000/api/roles",
        { organizationId: body.organizations[0]?.organizationId, title: "Staff Engineer" },
        "create-role-1",
        owner.userId
      )
    );
    assert.equal(created.status, 201, await created.clone().text());

    const roles = await rolesRoute.GET(
      authenticatedGetRequest(
        `http://localhost:3000/api/roles?organizationId=${encodeURIComponent(owner.organizationId)}`,
        owner.userId
      )
    );
    assert.equal(roles.status, 200, await roles.clone().text());
    const roleBody = (await roles.json()) as { roles: { title: string }[] };
    assert.deepEqual(
      roleBody.roles.map((role) => role.title),
      ["Staff Engineer"]
    );
  } finally {
    await dropProbeSchema(databaseUrl, schema);
  }
});

/**
 * The bootstrap command's own argument boundary, exercised as a real
 * process rather than by calling the function it wraps.
 *
 * Review #88: `bootstrapOrganizationOwner`'s own check was structural,
 * and the database CHECK is only `position('@' in email) > 1`, so
 * `owner@`, `foo@@bar` and `a@b` all got through -- and every one of
 * them is rejected by `requestMagicLinkInputSchema`. The single command
 * whose purpose is to create somebody who can sign in could create
 * somebody who provably could not, and nothing would say so until they
 * tried.
 *
 * Driven through `node scripts/environment/bootstrap.mjs` because the
 * fix lives in the CLI layer (it parses with contracts' own
 * `storedEmailSchema`, which packages/db may not depend on). Validation
 * runs before configuration is loaded and before any connection is
 * opened, so these cases need no database at all.
 */
const runCommand = promisify(execFile);

const BOOTSTRAP_SCRIPT = new URL("../../scripts/environment/bootstrap.mjs", import.meta.url).pathname;

async function runBootstrap(
  args: readonly string[]
): Promise<{ readonly code: number; readonly stderr: string }> {
  try {
    await runCommand(process.execPath, [BOOTSTRAP_SCRIPT, ...args]);
    return { code: 0, stderr: "" };
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    return { code: failure.code ?? -1, stderr: failure.stderr ?? "" };
  }
}

for (const rejected of ["owner@", "foo@@bar", "a@b", "@acme.test", "not-an-email"]) {
  test(`the bootstrap command refuses ${JSON.stringify(rejected)}, which could never sign in`, async () => {
    const result = await runBootstrap(["--organization", "Acme", "--email", rejected, "--name", "Dana"]);
    assert.equal(result.code, 1, `expected a clean exit 1 for ${JSON.stringify(rejected)}`);
    assert.match(result.stderr, /is not an address the sign-in endpoint would accept/u);
    // An operator error gets the reason, not a stack trace whose first
    // useful line is thirty characters in.
    assert.equal(/^\s*at /mu.test(result.stderr), false, `expected no stack trace, got: ${result.stderr}`);
  });
}

test("the bootstrap command reports a missing argument without a stack trace", async () => {
  const result = await runBootstrap(["--organization", "Acme"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Missing required argument/u);
  assert.equal(/^\s*at /mu.test(result.stderr), false);
});

// ---- Review #88 round 2: what an invite does to an existing member ----
//
// `POST /api/invites` is not only an "add somebody" endpoint, because
// redemption ends in `ON CONFLICT ... DO UPDATE SET role`. Nothing could
// reach that line before this ticket exposed invite creation over HTTP, and
// nothing covered it.

/** Bootstraps an owner, then invites and redeems `email` into `role`. */
async function seedMemberThroughInvite(
  databaseUrl: string,
  schema: string,
  owner: { readonly organizationId: string; readonly userId: string },
  email: string,
  role: "owner" | "admin" | "recruiter" | "auditor",
  keySuffix: string
): Promise<{ readonly userId: string }> {
  const inviteRoute = await loadWebRoute<PostRouteModule>(import.meta.url, INVITE_ROUTE);
  const redeemRoute = await loadWebRoute<PostRouteModule>(import.meta.url, REDEEM_ROUTE);
  const emitted = await captureStderr(async () => {
    const response = await inviteRoute.POST(
      authenticatedJsonRequest(
        "http://localhost:3000/api/invites",
        { email, organizationId: owner.organizationId, role },
        `seed-invite-${keySuffix}`,
        owner.userId
      )
    );
    assert.equal(response.status, 202, await response.clone().text());
  });
  const redeemed = await redeemRoute.POST(
    new NextRequest("http://localhost:3000/api/auth/magic-link/redeem", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": `seed-redeem-${keySuffix}` },
      body: JSON.stringify({ token: extractToken(emitted) })
    })
  );
  assert.equal(redeemed.status, 200, await redeemed.clone().text());
  return (await redeemed.json()) as { userId: string };
}

test("an invite that would replace an existing member's role is refused unless the admin says so", async () => {
  const databaseUrl = requireDatabase();
  const schema = await provisionRouteProbeSchema(databaseUrl);
  const ownerEmail = `replace-owner-${Date.now()}@acme.test`;
  const memberEmail = `replace-member-${Date.now()}@acme.test`;
  try {
    applyRouteEnvironment(databaseUrl, schema);
    const owner = await bootstrapOrganizationOwner(databaseUrl, schema, {
      organizationName: "Replace Co",
      email: ownerEmail,
      displayName: "Dana Ops"
    });
    const member = await seedMemberThroughInvite(
      databaseUrl,
      schema,
      owner,
      memberEmail,
      "recruiter",
      "replace"
    );

    const inviteRoute = await loadWebRoute<PostRouteModule>(import.meta.url, INVITE_ROUTE);

    // Without the opt-in: refused, and the message names the current role so
    // the admin can tell whether they meant it.
    const refused = await inviteRoute.POST(
      authenticatedJsonRequest(
        "http://localhost:3000/api/invites",
        { email: memberEmail, organizationId: owner.organizationId, role: "auditor" },
        "replace-no-optin",
        owner.userId
      )
    );
    assert.equal(refused.status, 409, await refused.clone().text());
    const refusedBody = (await refused.json()) as { error: { message: string } };
    assert.match(refusedBody.error.message, /already belongs to this organization as recruiter/u);

    // Nothing was minted by the refusal: the member is untouched and no
    // link went out.
    assert.deepEqual(
      (await listOrganizationsForUser(databaseUrl, schema, member.userId)).map((o) => o.role),
      ["recruiter"]
    );

    // With the opt-in: accepted, and the redemption actually applies it.
    const emitted = await captureStderr(async () => {
      const accepted = await inviteRoute.POST(
        authenticatedJsonRequest(
          "http://localhost:3000/api/invites",
          {
            email: memberEmail,
            organizationId: owner.organizationId,
            role: "auditor",
            replaceExistingRole: true
          },
          "replace-optin",
          owner.userId
        )
      );
      assert.equal(accepted.status, 202, await accepted.clone().text());
    });

    // The mail must not call a role change a sign-in link: the recipient's
    // click is what commits it.
    assert.match(emitted, /purpose: role_change/u);

    const redeemRoute = await loadWebRoute<PostRouteModule>(import.meta.url, REDEEM_ROUTE);
    const redeemed = await redeemRoute.POST(
      new NextRequest("http://localhost:3000/api/auth/magic-link/redeem", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": "replace-redeem" },
        body: JSON.stringify({ token: extractToken(emitted) })
      })
    );
    assert.equal(redeemed.status, 200, await redeemed.clone().text());
    assert.deepEqual(
      (await listOrganizationsForUser(databaseUrl, schema, member.userId)).map((o) => o.role),
      ["auditor"]
    );

    // And the effect is in the durable trail, not only the intent: an
    // investigator reading audit_events can see that this membership went
    // from recruiter to auditor, and who authorized it.
    const membershipId = await getMembershipIdForEmail(
      databaseUrl,
      schema,
      owner.organizationId,
      memberEmail
    );
    assert.ok(membershipId !== undefined);
    const roleChangeEvents = await listAuditEventsForEntity(
      databaseUrl,
      schema,
      "membership_role_change",
      `${membershipId}:recruiter->auditor`
    );
    assert.equal(roleChangeEvents.length, 1);
    assert.equal(roleChangeEvents[0]?.actorUserId, owner.userId);
    assert.equal(roleChangeEvents[0]?.action, "admin_action");
  } finally {
    await dropProbeSchema(databaseUrl, schema);
  }
});

test("an invite that would strand an organization without an owner is refused at creation, not at redemption", async () => {
  const databaseUrl = requireDatabase();
  const schema = await provisionRouteProbeSchema(databaseUrl);
  const ownerEmail = `strand-owner-${Date.now()}@acme.test`;
  try {
    applyRouteEnvironment(databaseUrl, schema);
    const owner = await bootstrapOrganizationOwner(databaseUrl, schema, {
      organizationName: "Strand Co",
      email: ownerEmail,
      displayName: "Dana Ops"
    });

    const inviteRoute = await loadWebRoute<PostRouteModule>(import.meta.url, INVITE_ROUTE);
    const emitted = await captureStderr(async () => {
      const response = await inviteRoute.POST(
        authenticatedJsonRequest(
          "http://localhost:3000/api/invites",
          {
            email: ownerEmail,
            organizationId: owner.organizationId,
            role: "recruiter",
            // Even with the opt-in: this is not a role change the admin is
            // permitted to make, it is one redemption would refuse forever.
            replaceExistingRole: true
          },
          "strand-invite",
          owner.userId
        )
      );
      // 409 at the admin who can act on it. Before this, the invite was
      // created, audited, emailed and answered 202, then failed at
      // redemption on every attempt until expiry -- bouncing the invitee to
      // /?auth=error with nothing telling the admin anything.
      assert.equal(response.status, 409, await response.clone().text());
      const body = (await response.json()) as { error: { message: string } };
      assert.match(body.error.message, /no owner/u);
    });

    // The refusal must mint nothing: no token delivered, and the owner is
    // still the owner.
    assert.equal(/[?&]token=/u.test(emitted), false, "a refused invite must not deliver a link");
    assert.deepEqual(
      (await listOrganizationsForUser(databaseUrl, schema, owner.userId)).map((o) => o.role),
      ["owner"]
    );
  } finally {
    await dropProbeSchema(databaseUrl, schema);
  }
});

test("retrying an invite with the same Idempotency-Key mints one token, one audit trail, one email", async () => {
  const databaseUrl = requireDatabase();
  const schema = await provisionRouteProbeSchema(databaseUrl);
  const ownerEmail = `idem-owner-${Date.now()}@acme.test`;
  const inviteeEmail = `idem-invitee-${Date.now()}@acme.test`;
  try {
    applyRouteEnvironment(databaseUrl, schema);
    const owner = await bootstrapOrganizationOwner(databaseUrl, schema, {
      organizationName: "Idem Co",
      email: ownerEmail,
      displayName: "Dana Ops"
    });

    const inviteRoute = await loadWebRoute<PostRouteModule>(import.meta.url, INVITE_ROUTE);
    const body = { email: inviteeEmail, organizationId: owner.organizationId, role: "recruiter" };

    const first = await captureStderr(async () => {
      const response = await inviteRoute.POST(
        authenticatedJsonRequest("http://localhost:3000/api/invites", body, "retry-me", owner.userId)
      );
      assert.equal(response.status, 202, await response.clone().text());
    });
    const token = extractToken(first);

    // The retry a timed-out client makes. Same answer, and nothing new.
    const second = await captureStderr(async () => {
      const response = await inviteRoute.POST(
        authenticatedJsonRequest("http://localhost:3000/api/invites", body, "retry-me", owner.userId)
      );
      assert.equal(response.status, 202, await response.clone().text());
    });
    assert.equal(
      /[?&]token=/u.test(second),
      false,
      "a replayed invite must not put a second live link in the recipient's mailbox"
    );

    // One audit row for one administrative act, not two.
    const events = await listAuditEventsForEntity(
      databaseUrl,
      schema,
      "membership_invite",
      hashMagicLinkToken(token)
    );
    assert.equal(events.length, 1, "a retry must not show two grants where the admin performed one");

    // A different key for the same body is a different act and is allowed.
    const third = await captureStderr(async () => {
      const response = await inviteRoute.POST(
        authenticatedJsonRequest("http://localhost:3000/api/invites", body, "retry-me-again", owner.userId)
      );
      assert.equal(response.status, 202, await response.clone().text());
    });
    assert.equal(/[?&]token=/u.test(third), true, "a new key is a new invite");
  } finally {
    await dropProbeSchema(databaseUrl, schema);
  }
});
