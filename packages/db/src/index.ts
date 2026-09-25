import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  Application,
  AuditAction,
  CandidateDecision,
  CandidateDecisionKind,
  CanonicalTextExtraction,
  CallerOrganization,
  CanonicalTextPage,
  CanonicalTextQuality,
  CsvColumnMapping,
  DomainPort,
  EvidenceExtractionRunRef,
  EvidenceExtractionJob,
  EvidenceExtractionQueueMonitoringSnapshot,
  EvidenceOutcome,
  FailedDocumentRate,
  FileIntake,
  FileIntakeStatus,
  ImportFinalizationSummary,
  ImportRow,
  ImportRowOutcome,
  MagicLinkInvite,
  MagicLinkRedemptionAttempt,
  MagicLinkTokenRecord,
  Membership,
  MembershipRole,
  Role,
  RoleStatus,
  Rubric,
  RubricCriterion,
  RubricStatus,
  User
} from "@signal-audit/domain";
import {
  CONTRACT_SCHEMA_VERSION,
  buildEvidenceExtractionFailureOutcomes,
  canonicalizeCsvColumnMapping,
  classifyCsvImportRow,
  normalizeAppliedAt,
  compareApplicationsBySourceOrder,
  mapCsvRowToApplication,
  summarizeFailedDocuments,
  summarizeImportRows
} from "@signal-audit/domain";
import { Client, Pool } from "pg";
import type { ClientBase, PoolClient } from "pg";

/** Persistence adapters will implement domain-owned ports in this package. */
/**
 * One pool per connection string, shared for the life of the process.
 *
 * Review #83: every function here used to open its own `Client`, so a single
 * request that called getRoleById, getMembershipsForUser, getApplicationById
 * and recordCandidateDecision paid four TCP, TLS and authentication handshakes
 * in sequence and left four Postgres backends to be started and torn down.
 * Correct, and needlessly expensive under any real concurrency.
 *
 * Keyed by connection string because tests and probes legitimately point at
 * different databases in one process, and a single global pool would send
 * their queries to whichever one happened to be first.
 *
 * `allowExitOnIdle` is what keeps this from being a trap: without it an idle
 * pooled connection is an open handle, and `node --test` and every script in
 * scripts/ would hang after finishing their work instead of exiting.
 */
const connectionPools = new Map<string, Pool>();

function getPool(databaseUrl: string): Pool {
  const existing = connectionPools.get(databaseUrl);
  if (existing !== undefined) {
    return existing;
  }
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
    max: 10,
    allowExitOnIdle: true
  });
  // Without a listener, an error raised on an idle pooled client (the server
  // closing it, a network drop) reaches the process as an unhandled 'error'
  // event and takes it down. The pool discards the client either way; this
  // only stops that being fatal.
  pool.on("error", () => undefined);
  connectionPools.set(databaseUrl, pool);
  return pool;
}

/**
 * A pooled connection, released by the caller's `finally`.
 *
 * Deliberately not offered to the probe helpers below. They run
 * `SET search_path`, `SET LOCAL ROLE` and CREATE/DROP SCHEMA, which are
 * session state that would outlive the borrower and leak onto whoever got the
 * connection next. Their own dedicated `Client` is not an oversight.
 */
async function acquireConnection(databaseUrl: string): Promise<PoolClient> {
  return getPool(databaseUrl).connect();
}

/**
 * Closes every pool. Not needed for process exit, which `allowExitOnIdle`
 * already handles; this is for a caller that wants the connections gone at a
 * known point, such as a graceful shutdown draining in-flight work first.
 */
export async function closeDatabasePools(): Promise<void> {
  const pools = [...connectionPools.values()];
  connectionPools.clear();
  await Promise.all(pools.map(async (pool) => pool.end().catch(() => undefined)));
}

export interface ConnectionReuseObservations {
  /** Distinct Postgres backend PIDs used across the sequence. */
  readonly distinctBackends: number;
  readonly calls: number;
  /** Sessions Postgres itself counted as established during the sequence. */
  readonly sessionsEstablished: number;
  /** The health check, which is deliberately unpooled, must still open one. */
  readonly healthCheckSessions: number;
}

/**
 * Review #83: proves the pool is actually reused rather than merely present.
 *
 * Measured two independent ways, because each alone is weak. `pg_backend_pid()`
 * says which backend served a query but could repeat by chance if a backend
 * were recycled onto the same PID. `pg_stat_database.sessions` counts sessions
 * Postgres established, which is exact but would be polluted by anything else
 * connecting concurrently -- so this runs against its own database, created
 * and dropped here, where nothing else does.
 *
 * Together they distinguish the fix from the defect. Before pooling, N
 * sequential calls meant N backends and N sessions. After, one of each.
 */
export async function assertConnectionsAreReused(
  adminDatabaseUrl: string,
  calls = 6
): Promise<ConnectionReuseObservations> {
  const suffix = randomBytes(4).toString("hex");
  const database = `reuse_probe_${suffix}`;
  const admin = new Client({ connectionString: adminDatabaseUrl, connectionTimeoutMillis: 5_000 });
  let probeUrl: string;
  try {
    await admin.connect();
    // CREATE DATABASE cannot run inside a transaction block, which is why this
    // is a bare query on a dedicated connection.
    await admin.query(`CREATE DATABASE "${database}"`);
    const target = new URL(adminDatabaseUrl);
    target.pathname = `/${database}`;
    probeUrl = target.toString();
  } finally {
    await admin.end().catch(() => undefined);
  }

  const observer = new Client({ connectionString: adminDatabaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await observer.connect();
    const readSessions = async (): Promise<number> => {
      const counted = await observer.query<{ sessions: string }>(
        `SELECT sessions::text AS sessions FROM pg_stat_database WHERE datname = $1`,
        [database]
      );
      return Number(counted.rows[0]?.sessions ?? "-1");
    };

    const backends = new Set<number>();
    const before = await readSessions();
    for (let index = 0; index < calls; index += 1) {
      const client = await acquireConnection(probeUrl);
      try {
        const pid = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const observed = pid.rows[0]?.pid;
        if (observed === undefined) {
          throw new Error("probe could not read a backend pid");
        }
        backends.add(observed);
      } finally {
        client.release();
      }
    }
    const afterSequence = await readSessions();

    // The unpooled health check, as a control in the same run: if the
    // measurement could not see a new session it would report reuse for
    // everything, including code that pools nothing.
    await checkDatabaseConnection(probeUrl, "public");
    const afterHealthCheck = await readSessions();

    await closeDatabasePools();
    return {
      distinctBackends: backends.size,
      calls,
      sessionsEstablished: afterSequence - before,
      healthCheckSessions: afterHealthCheck - afterSequence
    };
  } finally {
    await closeDatabasePools().catch(() => undefined);
    await observer.query(`DROP DATABASE IF EXISTS "${database}"`).catch(() => undefined);
    await observer.end().catch(() => undefined);
  }
}



export interface DatabaseAdapterBoundary {
  readonly domain: DomainPort;
}

export interface DatabaseHealth {
  readonly database: string;
  readonly schema: string;
}

/**
 * Deliberately not pooled, unlike every other reader here.
 *
 * A liveness probe that borrows a warm pooled connection reports the pool's
 * health, not the database's: it would answer healthy from a cached connection
 * while a new one could not be established at all. Its own handshake is the
 * thing being measured. The per-client statement and query timeouts below are
 * the other reason -- they bound this check without bounding every other
 * caller that would share a pooled connection.
 */
export async function checkDatabaseConnection(
  databaseUrl: string,
  expectedSchema: string
): Promise<DatabaseHealth> {
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
    statement_timeout: 5_000
  });

  try {
    await client.connect();
    const result = await client.query<{ database: string; schema_exists: boolean }>(
      "SELECT current_database() AS database, to_regnamespace($1) IS NOT NULL AS schema_exists",
      [expectedSchema]
    );
    const row = result.rows[0];
    if (row === undefined || !row.schema_exists) {
      throw new Error(`Expected database schema is unavailable: ${expectedSchema}`);
    }
    return { database: row.database, schema: expectedSchema };
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Everything below this point keeps its own dedicated `Client` on purpose.
 *
 * These probes and seed helpers run `SET search_path`, `SET LOCAL ROLE` and
 * CREATE/DROP SCHEMA. That is session state, and on a pooled connection it
 * would outlive the borrower and land on whoever got the connection next,
 * which is a far worse bug than the handshake cost pooling saves. They also
 * run once per test rather than once per request, so there is nothing to save.
 */
export async function verifySyntheticDatabaseFixture(
  databaseUrl: string,
  schema: string
): Promise<void> {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(schema)) {
    throw new Error("Unsafe database schema identifier");
  }

  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    const result = await client.query<{ contact_email: string; synthetic: boolean }>(
      `SELECT contact_email, synthetic FROM "${schema}".af11_synthetic_environment_fixture WHERE fixture_id = $1`,
      ["af11-candidate-001"]
    );
    const row = result.rows[0];
    if (
      row === undefined ||
      row.synthetic !== true ||
      !row.contact_email.endsWith("@example.test")
    ) {
      throw new Error("Expected synthetic database fixture is unavailable");
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

// ---- AF-16: invite-only magic-link authentication ----

function assertSafeSchema(schema: string): void {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(schema)) {
    throw new Error("Unsafe database schema identifier");
  }
}

interface MagicLinkTokenRow {
  readonly email: string;
  readonly organization_id: string | null;
  readonly role: MembershipRole | null;
  readonly expires_at: Date;
  readonly consumed_at: Date | null;
}

function mapMagicLinkTokenRow(row: MagicLinkTokenRow): MagicLinkTokenRecord {
  const invite: MagicLinkInvite | undefined =
    row.organization_id !== null && row.role !== null
      ? { organizationId: row.organization_id, role: row.role }
      : undefined;
  return {
    email: row.email,
    ...(invite === undefined ? {} : { invite }),
    expiresAt: row.expires_at,
    ...(row.consumed_at === null ? {} : { consumedAt: row.consumed_at })
  };
}

export interface CreateMagicLinkTokenInput {
  readonly tokenHash: string;
  readonly email: string;
  readonly invite?: MagicLinkInvite;
  readonly expiresAt: Date;
}

/**
 * The membership lookup below is unavoidably cross-organization: a plain
 * login token names no organization, so there is no app.current_org_id
 * to scope it with. AF-18's memberships policy requires exactly that
 * setting (0004_tenant_scoped_rls.sql), so under a role RLS actually
 * applies to, the SELECT returns zero rows for *every* email -- and the
 * caller would reject every legitimate login with "no membership".
 *
 * Today that does not happen, because AF-11's app role is the postgres
 * image's bootstrap superuser and superusers bypass RLS -- the migration
 * documents this as a known gap. But "the security control is currently
 * inert" is not something to depend on silently: the moment the role is
 * tightened, this must fail loudly and say what to change, not lock out
 * the entire user base behind an error that claims their account does
 * not exist.
 */
async function requireMembershipLookupVisible(client: ClientBase, schema: string, caller: string): Promise<void> {
  const rls = await client.query<{ active: boolean }>(
    `SELECT row_security_active('"${schema}".memberships'::regclass) AS active`
  );
  if (rls.rows[0]?.active === true) {
    throw new Error(
      `${caller} cannot read memberships: row-level security is active on "${schema}".memberships for the ` +
        `current database role, so a cross-organization lookup by user_id alone can never match. ` +
        `Grant this role BYPASSRLS, or move the lookup into a SECURITY DEFINER function owned by the table owner.`
    );
  }
}

/**
 * Per connection string and schema, because whether RLS applies is a property
 * of the table and the role, not of the request. Checking on every call would
 * add a round trip to every authenticated request for an answer that cannot
 * change while the process is running; a restart re-checks it.
 */
const membershipVisibilityChecked = new Map<string, Promise<void>>();

async function requireMembershipLookupVisibleOnce(
  databaseUrl: string,
  schema: string,
  caller: string
): Promise<void> {
  const key = `${databaseUrl}\u0000${schema}`;
  const existing = membershipVisibilityChecked.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const check = (async (): Promise<void> => {
    const client = await acquireConnection(databaseUrl);
    try {
      await requireMembershipLookupVisible(client, schema, caller);
    } finally {
      client.release();
    }
  })();
  // Cached before awaiting so concurrent first requests share one check, and
  // removed on failure so a fixed deployment does not keep serving the error
  // from cache.
  membershipVisibilityChecked.set(key, check);
  try {
    await check;
  } catch (error) {
    membershipVisibilityChecked.delete(key);
    throw error;
  }
}

async function emailHasMembership(
  client: ClientBase,
  schema: string,
  email: string
): Promise<boolean> {
  await requireMembershipLookupVisible(client, schema, "a login magic link");
  const found = await client.query(
    `SELECT 1
       FROM "${schema}".users u
       INNER JOIN "${schema}".memberships m ON m.user_id = u.user_id
      WHERE u.email = $1
      LIMIT 1`,
    [email]
  );
  return found.rows[0] !== undefined;
}

async function provisionInvitedMembership(
  client: ClientBase,
  schema: string,
  email: string,
  organizationId: string,
  role: MembershipRole
): Promise<void> {
  const displayName = email.split("@")[0] || email;
  const userResult = await client.query<{ user_id: string }>(
    `INSERT INTO "${schema}".users (email, display_name)
     VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING user_id`,
    [email, displayName]
  );
  const userId = userResult.rows[0]?.user_id;
  if (userId === undefined) {
    throw new Error("invite redemption did not produce a user row");
  }
  // Unlike the login lookup, an invite names its organization, so there
  // is a correct value for AF-18's memberships policy -- whose WITH CHECK
  // would otherwise reject this INSERT outright under a role RLS applies
  // to. is_local = true ties it to the enclosing transaction (this is
  // only ever called inside redeemMagicLinkToken's BEGIN/COMMIT), so it
  // reverts on COMMIT or ROLLBACK and cannot leak onto a later query
  // sharing the connection.
  await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [organizationId]);
  // Applying the invited role (below) makes one destructive direction
  // reachable that DO NOTHING made impossible: a re-invite naming a
  // non-owner role for the organization's only owner would leave it with
  // zero owners and no way back, because granting `owner` is itself an
  // owner-level action. So the upsert only gets to be unconditional in
  // the direction that cannot strand an organization. FOR UPDATE locks
  // the owner rows for the rest of this transaction, so two concurrent
  // demotions cannot each see the other's owner and both proceed.
  if (role !== "owner") {
    const owners = await client.query<{ user_id: string }>(
      `SELECT user_id
         FROM "${schema}".memberships
        WHERE organization_id = $1 AND role = 'owner'
        FOR UPDATE`,
      [organizationId]
    );
    const ownerIds = owners.rows.map((owner) => owner.user_id);
    if (ownerIds.length === 1 && ownerIds[0] === userId) {
      throw new Error(
        `invite would demote the last owner of organization ${organizationId} to ${role}; ` +
          `promote another owner before changing this membership`
      );
    }
  }

  // DO UPDATE, not DO NOTHING: an invite that names a role is an explicit
  // instruction from whoever had permission to create it (invite creation
  // is where that authorization boundary lives, not redemption) -- silently
  // keeping the old role on conflict would let a deliberate promotion
  // (recruiter -> admin, say) redeem successfully while leaving the actual
  // membership unchanged, with no error or signal to anyone.
  await client.query(
    `INSERT INTO "${schema}".memberships (organization_id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [organizationId, userId, role]
  );
}

export async function createMagicLinkToken(
  databaseUrl: string,
  schema: string,
  input: CreateMagicLinkTokenInput
): Promise<void> {
  assertSafeSchema(schema);
  const email = input.email.toLowerCase();
  const client = await acquireConnection(databaseUrl);
  try {
    // A plain login token (no invite) is not a signup path: refuse to mint
    // one for an email that has no user+membership pair. Invite tokens are
    // the only way an unknown email becomes a member, and they name the
    // organization and role up front.
    if (input.invite === undefined && !(await emailHasMembership(client, schema, email))) {
      throw new Error("login magic link requires an existing user with a membership");
    }
    await client.query(
      `INSERT INTO "${schema}".magic_link_tokens (token_hash, email, organization_id, role, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        input.tokenHash,
        email,
        input.invite?.organizationId ?? null,
        input.invite?.role ?? null,
        input.expiresAt
      ]
    );
  } finally {
    client.release();
  }
}

/**
 * What redeeming an invite would actually do to the target's membership.
 *
 * Review #88, REV-002 and REV-003: `POST /api/invites` is not only an
 * "add somebody" endpoint. `provisionInvitedMembership` ends in
 * `ON CONFLICT ... DO UPDATE SET role`, which nothing could reach before
 * this ticket exposed invite creation over HTTP. So an invite naming an
 * existing member silently replaces their role when they click what their
 * mail client shows as a routine sign-in link; and an invite that would
 * demote an organization's sole owner is accepted, audited and delivered,
 * then fails at redemption forever, bouncing the invitee to `/?auth=error`
 * with nothing telling the admin who issued it.
 *
 * This lets the route answer for both before minting anything.
 */
export type InviteEffect =
  /** No membership exists yet: the ordinary invite. */
  | { readonly outcome: "creates_membership" }
  /** Already a member in exactly this role; redemption changes nothing. */
  | { readonly outcome: "unchanged"; readonly role: MembershipRole }
  /** Replaces an existing member's role. */
  | { readonly outcome: "changes_role"; readonly from: MembershipRole; readonly to: MembershipRole }
  /** Would leave the organization with no owner; redemption refuses this. */
  | { readonly outcome: "strands_organization"; readonly from: MembershipRole; readonly to: MembershipRole };

/**
 * Advisory, not the enforcement.
 *
 * This is a read, so between it and redemption the membership can change.
 * `provisionInvitedMembership`'s own last-owner guard, inside the
 * redemption transaction and holding `FOR UPDATE` on the owner rows, stays
 * the actual invariant. What this buys is that the common case fails at the
 * admin who can act on it rather than at an invitee holding a link that can
 * never work.
 */
export async function previewInviteEffect(
  databaseUrl: string,
  schema: string,
  input: { readonly organizationId: string; readonly email: string; readonly role: MembershipRole }
): Promise<InviteEffect> {
  assertSafeSchema(schema);
  const email = input.email.toLowerCase();
  const client = await acquireConnection(databaseUrl);
  try {
    await client.query("BEGIN");
    try {
      // AF-18's memberships policy needs this for the reads below under any
      // role RLS applies to; is_local ties it to this transaction.
      await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [input.organizationId]);
      const existing = await client.query<{ user_id: string; role: MembershipRole }>(
        `SELECT m.user_id, m.role
           FROM "${schema}".users u
           INNER JOIN "${schema}".memberships m ON m.user_id = u.user_id
          WHERE u.email = $1 AND m.organization_id = $2`,
        [email, input.organizationId]
      );
      const current = existing.rows[0];
      if (current === undefined) {
        await client.query("COMMIT");
        return { outcome: "creates_membership" };
      }
      if (current.role === input.role) {
        await client.query("COMMIT");
        return { outcome: "unchanged", role: current.role };
      }
      if (input.role !== "owner") {
        const owners = await client.query<{ user_id: string }>(
          `SELECT user_id FROM "${schema}".memberships
            WHERE organization_id = $1 AND role = 'owner'`,
          [input.organizationId]
        );
        const ownerIds = owners.rows.map((owner) => owner.user_id);
        if (ownerIds.length === 1 && ownerIds[0] === current.user_id) {
          await client.query("COMMIT");
          return { outcome: "strands_organization", from: current.role, to: input.role };
        }
      }
      await client.query("COMMIT");
      return { outcome: "changes_role", from: current.role, to: input.role };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
  }
}

/** The membership an invite would change, for the audit row that records it. */
export async function getMembershipIdForEmail(
  databaseUrl: string,
  schema: string,
  organizationId: string,
  email: string
): Promise<string | undefined> {
  assertSafeSchema(schema);
  const client = await acquireConnection(databaseUrl);
  try {
    await client.query("BEGIN");
    try {
      await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [organizationId]);
      const result = await client.query<{ membership_id: string }>(
        `SELECT m.membership_id
           FROM "${schema}".users u
           INNER JOIN "${schema}".memberships m ON m.user_id = u.user_id
          WHERE u.email = $1 AND m.organization_id = $2`,
        [email.toLowerCase(), organizationId]
      );
      await client.query("COMMIT");
      return result.rows[0]?.membership_id;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
  }
}

export interface CreateInviteMagicLinkTokenInput {
  readonly tokenHash: string;
  readonly email: string;
  readonly invite: MagicLinkInvite;
  readonly expiresAt: Date;
  /**
   * Not optional, and not a second call the caller could forget to make.
   * An invite grants a named role in an organization to whoever redeems
   * it, which is exactly the consequential `admin_action` AF-20 requires
   * to be attributable -- and redemption itself records nothing, because
   * the person redeeming is not the person who decided to grant it.
   * Making this a field means an invite that is not attributable cannot
   * be expressed, rather than merely discouraged.
   */
  readonly audit: {
    readonly actorUserId: string;
    readonly requestId: string;
  };
  /**
   * Present when this invite replaces an existing member's role, so the
   * effect lands in the audit trail and not only the intent.
   *
   * Review #88, REV-002: the `membership_invite` row records that an invite
   * was minted. It does not record that member X went from `recruiter` to
   * `auditor`, and redemption writes no audit row at all -- so the durable
   * half of the trail carried the act and not its consequence, on exactly
   * the invariant AF-20 and POL-001 exist for.
   *
   * It is recorded here, at creation, rather than at redemption, because
   * this is where the accountable human is. The person clicking the link is
   * not the person who decided; `magic_link_tokens` does not carry an
   * inviter, and audit_events' membership trigger would reject a row naming
   * an actor who has since been offboarded, turning an old invite into an
   * unredeemable one. The admin who authorized the change is the honest
   * actor and is known right here.
   */
  readonly roleChange?: {
    readonly membershipId: string;
    readonly from: MembershipRole;
    readonly to: MembershipRole;
  };
  /**
   * The caller's Idempotency-Key, honoured rather than merely validated
   * (review #88, REV-007). A retry after a timeout must not mint a second
   * live credential, a second audit trail and a second email for one
   * administrative act.
   *
   * Bound to the request it was issued for, not accepted bare (review #88,
   * REV-009): a key reused against a different email, role or
   * `replaceExistingRole` -- a client bug, a copy-pasted header, a key
   * minted once per admin session instead of once per submission -- hit
   * the same unique-index conflict as a genuine retry and answered the
   * same silent-success 202, for an invite that was never created. See
   * `replaceExistingRole` below and `createInviteMagicLinkToken`'s
   * fingerprint comparison.
   */
  readonly idempotencyKey: string;
  /**
   * The caller's stated intent, folded into the idempotency fingerprint
   * alongside email and role. Required, not defaulted to `false` inside
   * this function: the fingerprint must reflect what the caller actually
   * sent, and a default here would make two different requests -- one that
   * omitted the field and one that sent `false` -- fingerprint identically,
   * which happens to be harmless today only because they mean the same
   * thing; a silent default is still the wrong place to encode that.
   */
  readonly replaceExistingRole: boolean;
}

export type CreateInviteOutcome =
  | { readonly outcome: "created" }
  /** This exact request, replayed under the same key: nothing was written
   * and nothing should be sent. */
  | { readonly outcome: "replayed" }
  /** The key was reused for a different request. Refused, not replayed:
   * silently discarding the second request would tell its caller it
   * succeeded when nothing was created for it. */
  | { readonly outcome: "conflict" };

/**
 * Mints an invite token and its audit row in one transaction.
 *
 * Separate from createMagicLinkToken rather than an optional argument on
 * it: a login link re-sends access somebody already has, an invite
 * creates it, and only the second is an administrative act with an
 * actor to record.
 *
 * The audit row's entity_id is the token hash, not the invited email.
 * audit_events is append-only by trigger and has no delete path, so an
 * address written there could never be removed; the token hash points at
 * the magic_link_tokens row, which holds the email, organization and
 * role together and can be deleted. The audit trail keeps the fact and
 * its actor, and the joinable row keeps the detail.
 */
export async function createInviteMagicLinkToken(
  databaseUrl: string,
  schema: string,
  input: CreateInviteMagicLinkTokenInput
): Promise<CreateInviteOutcome> {
  assertSafeSchema(schema);
  const email = input.email.toLowerCase();
  // Review #88, REV-009: what makes a replay "the same request" as the one
  // that first claimed this key. Same shape as claimIdempotentRequest's own
  // request_fingerprint -- a canonical hash of the fields that determine the
  // invite's effect -- kept as its own column rather than reusing that
  // generic mechanism, because invites already have their own idempotency
  // column (REV-007) and this repo's convention is a bespoke column per
  // consequential write (candidate decisions, import finalization,
  // evidence corrections), not a shared table every route funnels through.
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ email, organizationId: input.invite.organizationId, role: input.invite.role, replaceExistingRole: input.replaceExistingRole }))
    .digest("hex");
  const client = await acquireConnection(databaseUrl);
  try {
    await client.query("BEGIN");
    try {
      // The INSERT is the deduplication, not a check before it: the partial
      // unique index means exactly one concurrent caller can claim a key, so
      // two simultaneous retries cannot both proceed. On conflict nothing is
      // written and the audit rows below are skipped with it, inside this
      // same transaction.
      const inserted = await client.query(
        `INSERT INTO "${schema}".magic_link_tokens
           (token_hash, email, organization_id, role, expires_at, idempotency_key, idempotency_fingerprint)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL
         DO NOTHING`,
        [
          input.tokenHash,
          email,
          input.invite.organizationId,
          input.invite.role,
          input.expiresAt,
          input.idempotencyKey,
          fingerprint
        ]
      );
      if (inserted.rowCount === 0) {
        // Same key, but is it the same request? The unique index alone
        // cannot tell: it only knows the (organization, key) pair
        // conflicted, not whether this call's fingerprint matches the one
        // that won the race. Read back what actually claimed the key and
        // compare, the same distinction claimIdempotentRequest draws
        // between `replay` and `fingerprint_mismatch`.
        const existing = await client.query<{ idempotency_fingerprint: string | null }>(
          `SELECT idempotency_fingerprint FROM "${schema}".magic_link_tokens
            WHERE organization_id = $1 AND idempotency_key = $2`,
          [input.invite.organizationId, input.idempotencyKey]
        );
        const existingFingerprint = existing.rows[0]?.idempotency_fingerprint;
        if (existingFingerprint === undefined) {
          // Only reachable if the row was deleted between the two
          // statements, which nothing here does. Reported rather than
          // silently treated as either outcome.
          throw new Error("invite idempotency record vanished between claim and read");
        }
        if (existingFingerprint !== fingerprint) {
          // A different request reused this key. Refused, not replayed:
          // treating it as a replay would answer 202 for an invite that
          // was never created, which is the exact failure mode reported
          // in review #88 (REV-009).
          await client.query("ROLLBACK");
          return { outcome: "conflict" };
        }
        await client.query("COMMIT");
        return { outcome: "replayed" };
      }
      await appendAuditEvent(
        databaseUrl,
        schema,
        {
          organizationId: input.invite.organizationId,
          actorUserId: input.audit.actorUserId,
          action: "admin_action",
          entityType: "membership_invite",
          entityId: input.tokenHash,
          requestId: input.audit.requestId
        },
        client
      );
      if (input.roleChange !== undefined) {
        // Same transaction as the token, so an authorized role change cannot
        // exist without the record of who authorized it.
        //
        // The roles travel in entity_id because audit_events has no column
        // for them, and adding one to an append-only table is not a change to
        // make in passing. Semantic content in entity_id has precedent here:
        // the kill-switch path writes "engaged"/"disengaged" rather than an
        // id. The membership id leads the value so the row still joins.
        await appendAuditEvent(
          databaseUrl,
          schema,
          {
            organizationId: input.invite.organizationId,
            actorUserId: input.audit.actorUserId,
            action: "admin_action",
            entityType: "membership_role_change",
            entityId: `${input.roleChange.membershipId}:${input.roleChange.from}->${input.roleChange.to}`,
            requestId: input.audit.requestId
          },
          client
        );
      }
      await client.query("COMMIT");
      return { outcome: "created" };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
  }
}

/**
 * Atomic single-use redemption: the UPDATE only ever matches a row once,
 * so two concurrent redemption attempts on the same token cannot both
 * succeed. Expiry is compared to database time (clock_timestamp()), not
 * the caller's clock. If the token carries an invite, the user and
 * membership are granted in the same transaction as consume -- a crash
 * between those writes cannot leave the invite spent without a member.
 * If it matched nothing, a follow-up SELECT (no race risk, purely
 * diagnostic) reports whether the token never existed or was already
 * consumed/expired.
 */
export async function redeemMagicLinkToken(
  databaseUrl: string,
  schema: string,
  tokenHash: string
): Promise<MagicLinkRedemptionAttempt> {
  assertSafeSchema(schema);
  const client = await acquireConnection(databaseUrl);
  try {
    await client.query("BEGIN");
    try {
      const redeemed = await client.query<MagicLinkTokenRow>(
        `UPDATE "${schema}".magic_link_tokens
            SET consumed_at = clock_timestamp()
          WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > clock_timestamp()
          RETURNING email, organization_id, role, expires_at, consumed_at`,
        [tokenHash]
      );
      const redeemedRow = redeemed.rows[0];
      if (redeemedRow !== undefined) {
        const record = mapMagicLinkTokenRow(redeemedRow);
        if (record.invite !== undefined) {
          await provisionInvitedMembership(
            client,
            schema,
            record.email.toLowerCase(),
            record.invite.organizationId,
            record.invite.role
          );
        }
        await client.query("COMMIT");
        return { justRedeemed: true, record };
      }

      const existing = await client.query<MagicLinkTokenRow>(
        `SELECT email, organization_id, role, expires_at, consumed_at
           FROM "${schema}".magic_link_tokens WHERE token_hash = $1`,
        [tokenHash]
      );
      await client.query("COMMIT");
      const existingRow = existing.rows[0];
      return {
        justRedeemed: false,
        record: existingRow === undefined ? undefined : mapMagicLinkTokenRow(existingRow)
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
  }
}

// ---- AF-20: immutable audit events ----
//
// Insert only. There is deliberately no update or delete function here,
// on top of the database trigger that rejects them outright (migration
// 0005_immutable_audit_events.sql): immutability is enforced twice, not assumed from one layer.

export interface AppendAuditEventInput {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly action: AuditAction;
  readonly entityType: string;
  readonly entityId: string;
  readonly requestId: string;
}

/** Same format as contracts' requestIdSchema; duplicated here so db does not depend on contracts. */
const AUDIT_REQUEST_ID_PATTERN =
  /^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** Caller-owned client so an action and its audit row can share one transaction. */
export type DatabaseQueryable = Pick<Client, "query">;

export async function appendAuditEvent(
  databaseUrl: string,
  schema: string,
  input: AppendAuditEventInput,
  existingClient?: DatabaseQueryable
): Promise<void> {
  assertSafeSchema(schema);
  if (!AUDIT_REQUEST_ID_PATTERN.test(input.requestId)) {
    throw new Error("audit event request_id must match req_<uuid>");
  }

  const insert = async (client: DatabaseQueryable): Promise<void> => {
    await client.query(
      `INSERT INTO "${schema}".audit_events
         (organization_id, actor_user_id, action, entity_type, entity_id, request_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [input.organizationId, input.actorUserId, input.action, input.entityType, input.entityId, input.requestId]
    );
  };

  if (existingClient !== undefined) {
    await insert(existingClient);
    return;
  }

  const client = await acquireConnection(databaseUrl);
  try {
    await insert(client);
  } finally {
    client.release();
  }
}

export interface RecordedAuditEvent {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly action: AuditAction;
  readonly entityType: string;
  readonly entityId: string;
  readonly requestId: string;
}

/**
 * Reads back the audit rows for one entity.
 *
 * Exported for the same reason the assert* probes below are: `pg` lives
 * in this package, so a test that needs to see real rows either goes
 * through here or reaches for a driver it cannot resolve.
 *
 * It exists because of review #88, which caught a test asserting the
 * wrong thing. `POST /api/invites` answering 202 was taken as proof that
 * the `admin_action` row had been written; it is not. Deleting the
 * `appendAuditEvent` call entirely would still insert the token, send
 * the mail and answer 202, and the only assertion covering AF-20's
 * "every consequential action is attributable" invariant would have gone
 * on passing. The row has to be read to be checked.
 */
export async function listAuditEventsForEntity(
  databaseUrl: string,
  schema: string,
  entityType: string,
  entityId: string
): Promise<readonly RecordedAuditEvent[]> {
  assertSafeSchema(schema);
  const client = await acquireConnection(databaseUrl);
  try {
    const result = await client.query<{
      organization_id: string;
      actor_user_id: string;
      action: AuditAction;
      entity_type: string;
      entity_id: string;
      request_id: string;
    }>(
      `SELECT organization_id, actor_user_id, action, entity_type, entity_id, request_id
         FROM "${schema}".audit_events
        WHERE entity_type = $1 AND entity_id = $2
        ORDER BY occurred_at ASC`,
      [entityType, entityId]
    );
    return result.rows.map((row) => ({
      organizationId: row.organization_id,
      actorUserId: row.actor_user_id,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      requestId: row.request_id
    }));
  } finally {
    client.release();
  }
}

// ---- AF-40: persist model/prompt/schema/rubric versions ----
//
// Insert only, same as appendAuditEvent: immutability is enforced by
// the database trigger (0006_audit_events_delete_and_membership_fixes.sql), and there is deliberately no
// update/delete function here either.

export interface RecordEvidenceExtractionRunInput {
  readonly organizationId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly extractionSchemaVersion: string;
  readonly extractionSchemaName: string;
  readonly rubricVersion: string;
}

export async function recordEvidenceExtractionRun(
  databaseUrl: string,
  schema: string,
  input: RecordEvidenceExtractionRunInput,
  existingClient?: DatabaseQueryable
): Promise<string> {
  assertSafeSchema(schema);
  const insert = async (client: DatabaseQueryable): Promise<string> => {
    const result = await client.query<{ run_id: string }>(
      `INSERT INTO "${schema}".evidence_extraction_runs
         (organization_id, entity_type, entity_id, provider, model, prompt_version,
          extraction_schema_version, extraction_schema_name, rubric_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING run_id`,
      [
        input.organizationId,
        input.entityType,
        input.entityId,
        input.provider,
        input.model,
        input.promptVersion,
        input.extractionSchemaVersion,
        input.extractionSchemaName,
        input.rubricVersion
      ]
    );
    const runId = result.rows[0]?.run_id;
    if (runId === undefined) {
      throw new Error("evidence extraction run insert returned no row");
    }
    return runId;
  };
  if (existingClient !== undefined) {
    return insert(existingClient);
  }
  const client = await acquireConnection(databaseUrl);
  try {
    return await insert(client);
  } finally {
    client.release();
  }
}

// ---- AF-41: inference cost/budget tracking ----

export interface RecordInferenceUsageInput {
  readonly organizationId: string;
  readonly model: string;
  /** The caller decides period granularity (e.g. today's date for a daily budget). */
  readonly periodStart: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * Reads a Postgres bigint column, refusing to lose precision quietly.
 *
 * bigint arrives as a string precisely because it does not fit a JS
 * number. Number("9007199254740993") is 9007199254740992 -- off by one,
 * with no error -- and these values feed a budget comparison, so a
 * silently wrong total is a silently wrong spending decision. Failing here
 * is loud and fixable; the alternative is a cap that stops working
 * correctly at a threshold nobody is watching for.
 */
function bigintColumnToNumber(raw: string, column: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || String(value) !== raw.trim()) {
    throw new Error(
      `${column} is ${raw}, which exceeds the range a JavaScript number can hold exactly ` +
        `(max ${Number.MAX_SAFE_INTEGER}); refusing to return a value that has silently lost precision`
    );
  }
  return value;
}

/**
 * Rejects a negative delta before it reaches the upsert. The table's
 * CHECK only sees the RESULT of the addition, so once a row has a
 * positive total, recording -50 against 100 silently lowers usage to 50:
 * a faulty or untrusted caller could walk the meter backwards and
 * postpone the cap indefinitely.
 */
function assertNonNegativeUsage(input: RecordInferenceUsageInput): void {
  for (const [field, value] of [
    ["inputTokens", input.inputTokens],
    ["outputTokens", input.outputTokens]
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`recordInferenceUsage requires a non-negative safe integer ${field}, got: ${value}`);
    }
  }
}

/** Increments the existing row for this (organization, model, period), or creates it. */
export async function recordInferenceUsage(
  databaseUrl: string,
  schema: string,
  input: RecordInferenceUsageInput
): Promise<void> {
  assertSafeSchema(schema);
  assertNonNegativeUsage(input);
  const client = await acquireConnection(databaseUrl);
  try {
    await client.query(
      `INSERT INTO "${schema}".inference_usage_ledger
         (organization_id, model, period_start, input_tokens, output_tokens)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (organization_id, model, period_start) DO UPDATE SET
         input_tokens = "${schema}".inference_usage_ledger.input_tokens + EXCLUDED.input_tokens,
         output_tokens = "${schema}".inference_usage_ledger.output_tokens + EXCLUDED.output_tokens,
         updated_at = CURRENT_TIMESTAMP`,
      [input.organizationId, input.model, input.periodStart, input.inputTokens, input.outputTokens]
    );
  } finally {
    client.release();
  }
}

export interface GetInferenceUsageInput {
  readonly organizationId: string;
  readonly model: string;
  readonly periodStart: string;
}

/** Returns 0/0 when no calls have been made yet this period -- there is nothing to cap against. */
export async function getInferenceUsage(
  databaseUrl: string,
  schema: string,
  input: GetInferenceUsageInput
): Promise<{ inputTokens: number; outputTokens: number }> {
  assertSafeSchema(schema);
  const client = await acquireConnection(databaseUrl);
  try {
    const result = await client.query<{ input_tokens: string; output_tokens: string }>(
      `SELECT input_tokens, output_tokens FROM "${schema}".inference_usage_ledger
        WHERE organization_id = $1 AND model = $2 AND period_start = $3`,
      [input.organizationId, input.model, input.periodStart]
    );
    const row = result.rows[0];
    return {
      inputTokens: row === undefined ? 0 : bigintColumnToNumber(row.input_tokens, "input_tokens"),
      outputTokens: row === undefined ? 0 : bigintColumnToNumber(row.output_tokens, "output_tokens")
    };
  } finally {
    client.release();
  }
}

export interface SetInferenceKillSwitchInput {
  readonly engaged: boolean;
  readonly reason?: string;
  // No separate engagedByUserId: the audited actor below is the single
  // source of truth. Carrying both let the singleton row name one person
  // while the audit event named another, and the two are supposed to be
  // the same fact recorded twice -- so the row is written from the actor.

  /**
   * Required to audit the transition. Every engage/disengage overwrites
   * the singleton row -- including its actor, reason and timestamp -- so
   * without an audit row the previous incident-control action leaves no
   * trace at all once the next transition happens. `audit_events`
   * already covers consequential `admin_action`s explicitly, and the
   * transition plus its audit row now commit in ONE transaction, so a
   * flipped switch can never exist without the record of who flipped it.
   */
  readonly audit: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly requestId: string;
  };
}

/** Fail closed when the singleton control row is absent. */
export async function getInferenceKillSwitchStatus(
  databaseUrl: string,
  schema: string
): Promise<{ readonly engaged: boolean; readonly reason?: string }> {
  assertSafeSchema(schema);
  const client = await acquireConnection(databaseUrl);
  try {
    const result = await client.query<{ engaged: boolean; reason: string | null }>(
      `SELECT engaged, reason FROM "${schema}".inference_kill_switch WHERE id = true`
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("inference_kill_switch has no row; refusing to assume inference is allowed");
    }
    return {
      engaged: row.engaged,
      ...(row.reason === null ? {} : { reason: row.reason })
    };
  } finally {
    client.release();
  }
}

/**
 * The database CHECK constraint (0008_inference_kill_switch.sql) is the real enforcement:
 * engaging without a reason is rejected there, and the actor comes from
 * the audited actorUserId rather than a second field
 * regardless of what this function is called with, matching this
 * codebase's habit of enforcing an invariant at more than one layer.
 *
 * The UPDATE's rowCount is checked and throws on 0, mirroring
 * getInferenceKillSwitchStatus's own fail-closed handling of a missing
 * singleton row -- without this, a missing seed row would make this
 * function silently report success while changing nothing at all.
 */
export async function setInferenceKillSwitch(
  databaseUrl: string,
  schema: string,
  input: SetInferenceKillSwitchInput
): Promise<void> {
  assertSafeSchema(schema);
  const client = await acquireConnection(databaseUrl);
  try {
    await client.query("BEGIN");
    try {
      const result = await client.query(
        `UPDATE "${schema}".inference_kill_switch
            SET engaged = $1,
                reason = $2,
                -- Cleared on disengage: "who engaged it" is meaningless
                -- once it is off, and leaving the last engager's name on a
                -- disengaged switch reads like they are still holding it.
                engaged_by_user_id = CASE WHEN $1 THEN $3::uuid ELSE NULL END,
                updated_at = clock_timestamp()
          WHERE id = true`,
        [input.engaged, input.reason ?? null, input.audit.actorUserId]
      );
      if (result.rowCount === 0) {
        throw new Error("inference_kill_switch has no row; the seed insert from migration 0008 is missing");
      }
      // The reason, kept where the next transition cannot overwrite it.
      // The singleton above is the CURRENT state, so disengaging replaces or
      // clears the reason the engage recorded; this row is the history. Same
      // transaction as both the flip and the audit event, so a switch cannot
      // end up flipped with no record of why.
      await client.query(
        `INSERT INTO "${schema}".inference_kill_switch_transitions
           (engaged, reason, actor_user_id, request_id)
         VALUES ($1, $2, $3, $4)`,
        [input.engaged, input.reason ?? null, input.audit.actorUserId, input.audit.requestId]
      );
      // Same transaction, on the same client: the switch cannot end up
      // flipped without the audit row recording who did it, and a
      // failure here rolls the transition back rather than leaving an
      // unattributed change behind.
      await appendAuditEvent(
        databaseUrl,
        schema,
        {
          organizationId: input.audit.organizationId,
          actorUserId: input.audit.actorUserId,
          action: "admin_action",
          entityType: "inference_kill_switch",
          entityId: input.engaged ? "engaged" : "disengaged",
          requestId: input.audit.requestId
        },
        client
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
  }
}

// ---- AF-23 prerequisite: resolve a redeemed magic link to a real user ----
//
// AF-16 built token generation/redemption but stopped at "this email is
// verified" -- nothing yet turns that into a userId. A login-only token
// (no invite) must resolve to a user who already exists: if one
// redeems a login link for an email that was invited but never
// completed onboarding, that is exactly the not-onboarded case,
// reported honestly rather than papered over by silently creating a
// user with no membership. An invite token (organizationId + role
// present) may legitimately be the first thing that ever creates that
// user, so it upserts both the user and the membership together,
// atomically, since a user row without the invited membership would be
// a stuck half-onboarded account.

interface UserRow {
  readonly user_id: string;
  readonly email: string;
  readonly display_name: string;
  readonly created_at: Date;
}

function rowToUser(row: UserRow): User {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    createdAt: row.created_at.toISOString()
  };
}

export async function getUserByEmail(
  databaseUrl: string,
  schema: string,
  email: string
): Promise<User | undefined> {
  assertSafeSchema(schema);
  const client = await acquireConnection(databaseUrl);
  try {
    const result = await client.query<UserRow>(
      `SELECT user_id, email, display_name, created_at FROM "${schema}".users WHERE email = $1`,
      [email]
    );
    return result.rows[0] === undefined ? undefined : rowToUser(result.rows[0]);
  } finally {
    client.release();
  }
}

// ---- AF-23 prerequisite: fetch the caller's own memberships ----
//
// AF-19's authorizeResourceAccess takes a Membership[] but nothing before
// AF-23 needed one for real, so no query existed to produce it. This is
// the only place a session's bare userId ever becomes a set of
// (organization, role) facts -- authorizeResourceAccess still owns the
// actual decision, this just supplies its input.

interface MembershipRow {
  readonly membership_id: string;
  readonly organization_id: string;
  readonly user_id: string;
  readonly role: MembershipRole;
  readonly created_at: Date;
}

export async function getMembershipsForUser(
  databaseUrl: string,
  schema: string,
  userId: string
): Promise<readonly Membership[]> {
  assertSafeSchema(schema);
  // Review #83, REV-002: this is the same cross-organization lookup the login
  // path makes, keyed on user_id with no organization filter, and it was the
  // only one of the two without the visibility guard.
  //
  // 0004_tenant_scoped_rls.sql puts FORCE ROW LEVEL SECURITY on memberships
  // with a policy on app.current_org_id, which nothing sets here. That is inert
  // today only because the application role happens to be the Postgres image's
  // bootstrap superuser. Under any role RLS applies to, this query returns zero
  // rows, every authenticated caller looks like it holds no memberships, and
  // all 16 API routes answer not_found. Silently, and identically to a genuine
  // permission denial, which is the worst possible way for it to fail: the
  // login path at least refuses loudly with an actionable message.
  await requireMembershipLookupVisibleOnce(databaseUrl, schema, "reading a user's memberships");
  const client = await acquireConnection(databaseUrl);
  try {
    const result = await client.query<MembershipRow>(
      `SELECT membership_id, organization_id, user_id, role, created_at
         FROM "${schema}".memberships
        WHERE user_id = $1`,
      [userId]
    );
    return result.rows.map((row) => ({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      membershipId: row.membership_id,
      organizationId: row.organization_id,
      userId: row.user_id,
      role: row.role,
      createdAt: row.created_at.toISOString()
    }));
  } finally {
    client.release();
  }
}

// ---- AF-97: entering a deployment ----

interface CallerOrganizationRow {
  readonly organization_id: string;
  readonly name: string;
  readonly role: MembershipRole;
}

/**
 * The organizations a signed-in caller may act in, with the role they
 * hold in each.
 *
 * Every other route takes an organizationId it does not produce, so
 * before this existed a user had exactly one way to learn their own:
 * be told it out of band and paste it into a query string. This is the
 * one query that turns a session into a set of places to act in, which
 * is what an organization switcher renders.
 *
 * The organization name is only reachable through the caller's own
 * membership rows -- the join, not a filter applied afterwards -- so an
 * organizationId the caller has no membership for cannot be resolved to
 * a name here, and the list cannot become an organization directory.
 */
export async function listOrganizationsForUser(
  databaseUrl: string,
  schema: string,
  userId: string
): Promise<readonly CallerOrganization[]> {
  assertSafeSchema(schema);
  // Same cross-organization lookup as getMembershipsForUser, and the same
  // reason it must fail loudly: under a role RLS applies to, this returns
  // zero rows for every caller, and an organization switcher that renders
  // "you belong to no organizations" is indistinguishable from the truth.
  await requireMembershipLookupVisibleOnce(databaseUrl, schema, "listing a user's organizations");
  const client = await acquireConnection(databaseUrl);
  try {
    const result = await client.query<CallerOrganizationRow>(
      `SELECT o.organization_id, o.name, m.role
         FROM "${schema}".memberships m
         INNER JOIN "${schema}".organizations o ON o.organization_id = m.organization_id
        WHERE m.user_id = $1
        ORDER BY o.name ASC, o.organization_id ASC`,
      [userId]
    );
    return result.rows.map((row) => ({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      organizationId: row.organization_id,
      name: row.name,
      role: row.role
    }));
  } finally {
    client.release();
  }
}

export interface BootstrapOrganizationOwnerInput {
  readonly organizationName: string;
  readonly email: string;
  readonly displayName: string;
}

export interface BootstrapOrganizationOwnerResult {
  readonly organizationId: string;
  readonly userId: string;
  readonly organizationCreated: boolean;
  readonly userCreated: boolean;
  /** `promoted` means the user already belonged to this organization in a
   * non-owner role and now owns it -- reported rather than silent, because
   * it is the one privilege change this command can make to existing data. */
  readonly membership: "created" | "promoted" | "unchanged";
}

/**
 * Creates the first organization, user and owner membership of a
 * deployment, atomically.
 *
 * A fresh deployment has none of the three, and no code path creates
 * any: `POST /api/auth/magic-link/request` only mails a link to an email
 * that already holds a membership, and an invite can only be issued by
 * somebody who already owns an organization. That is a deliberate
 * invite-only design (AF-16) with one missing step -- the first invite
 * has nobody to come from -- so every route in the app was unreachable
 * without hand-editing the database.
 *
 * This is the missing step, and it is deliberately NOT an HTTP route.
 * Whatever creates the first owner cannot itself be behind
 * authentication, so as a route it would be an unauthenticated
 * privilege-granting endpoint that must be disabled after first use,
 * and "we remembered to disable it" is not a security control. Requiring
 * the operator to already hold database credentials moves the
 * authorization to something the deployment already has to protect.
 *
 * Idempotent, so an interrupted or repeated run converges instead of
 * creating a second organization with the same name: an existing
 * organization of that name is reused, the user is matched by email, and
 * the owner membership is upserted. See BootstrapOrganizationOwnerResult
 * for what a repeat run reports.
 */
export async function bootstrapOrganizationOwner(
  databaseUrl: string,
  schema: string,
  input: BootstrapOrganizationOwnerInput
): Promise<BootstrapOrganizationOwnerResult> {
  assertSafeSchema(schema);
  const organizationName = input.organizationName.trim();
  const displayName = input.displayName.trim();
  const email = input.email.trim().toLowerCase();
  // Checked here rather than left to the table's CHECK constraints: an
  // operator running this by hand should get the reason, not a raw
  // constraint-violation stack.
  if (organizationName.length === 0) {
    throw new Error("bootstrapOrganizationOwner requires a non-empty organization name");
  }
  if (displayName.length === 0) {
    throw new Error("bootstrapOrganizationOwner requires a non-empty display name");
  }
  // Structural only, and deliberately not an attempt to restate the
  // grammar (review #88). The authoritative check is contracts'
  // `storedEmailSchema` -- the very object `POST /api/auth/magic-link/request`
  // parses with -- applied by scripts/environment/bootstrap.mjs before it
  // gets here, because this package may not depend on contracts and a
  // second hand-written email regex would drift from the one that decides
  // whether the owner can actually sign in.
  //
  // This still refuses what the table's own CHECK is too weak to catch:
  // `position('@' in email) > 1` accepts `owner@`, `foo@@bar` and `a@b`,
  // every one of which `z.email()` rejects. Left unchecked, the one
  // command whose purpose is to create somebody who can sign in could
  // create somebody who provably cannot.
  const [localPart, domain, ...extraParts] = email.split("@");
  if (
    localPart === undefined ||
    localPart.length === 0 ||
    domain === undefined ||
    extraParts.length > 0 ||
    !/^[^\s@]+\.[^\s@]+$/u.test(domain)
  ) {
    throw new Error(
      `bootstrapOrganizationOwner requires an email address of the form name@example.com; ` +
        `an address the sign-in endpoint rejects would create an owner who can never request a link`
    );
  }

  const client = await acquireConnection(databaseUrl);
  try {
    await client.query("BEGIN");
    try {
      // One transaction for all three rows: a crash between them would
      // otherwise leave an organization nobody owns or a user with no
      // membership, and the second is exactly the "half-onboarded account"
      // the login path reports as no_account.
      //
      // organizations.name carries no unique constraint -- two real
      // employers may share a name -- so "insert unless one exists" is a
      // check-then-write that two concurrent runs could both pass,
      // producing the duplicate organization the idempotency below exists
      // to prevent. A transaction-scoped advisory lock on the name makes
      // the pair atomic without constraining the table, and is released by
      // COMMIT or ROLLBACK either way.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [organizationName]);
      const insertedOrganization = await client.query<{ organization_id: string }>(
        `INSERT INTO "${schema}".organizations (name)
         SELECT $1
          WHERE NOT EXISTS (SELECT 1 FROM "${schema}".organizations WHERE name = $1)
         RETURNING organization_id`,
        [organizationName]
      );
      const organizationCreated = insertedOrganization.rows[0] !== undefined;
      const organizationId =
        insertedOrganization.rows[0]?.organization_id ??
        (
          await client.query<{ organization_id: string }>(
            `SELECT organization_id FROM "${schema}".organizations
              WHERE name = $1
              ORDER BY created_at ASC, organization_id ASC
              LIMIT 1`,
            [organizationName]
          )
        ).rows[0]?.organization_id;
      if (organizationId === undefined) {
        throw new Error("bootstrap did not resolve an organization");
      }

      // Whether this row is new is read from the insert itself rather than
      // from a prior SELECT, because `xmax = 0` is true only for a tuple this
      // statement inserted.
      //
      // `DO UPDATE SET email = EXCLUDED.email` rather than `DO NOTHING`
      // (review #88, REV-008), matching provisionInvitedMembership above.
      // DO NOTHING returns no row on conflict and does not block on a
      // concurrent uncommitted insert of the same email; the fallback SELECT
      // could not see that uncommitted row under READ COMMITTED either, so
      // two operators bootstrapping the same person into differently named
      // organizations at the same moment would leave one of them throwing
      // "did not resolve a user". The advisory lock above only serialises
      // runs naming the same organization, so it does not cover this. The
      // no-op update takes the row lock, waits for the other transaction,
      // and then returns the row.
      //
      // Setting `email` to itself is what makes it a no-op: the display name
      // is deliberately not overwritten, because this command exists to grant
      // access, and silently renaming a person whose name an operator typed
      // differently is not that.
      const insertedUser = await client.query<{ user_id: string; inserted: boolean }>(
        `INSERT INTO "${schema}".users (email, display_name)
         VALUES ($1, $2)
         ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
         RETURNING user_id, (xmax = 0) AS inserted`,
        [email, displayName]
      );
      const userRow = insertedUser.rows[0];
      if (userRow === undefined) {
        throw new Error("bootstrap did not resolve a user");
      }
      const userCreated = userRow.inserted;
      const userId = userRow.user_id;

      // AF-18's memberships policy requires this for both the SELECT and
      // the INSERT below under any role RLS applies to; is_local = true
      // ties it to this transaction, so it cannot leak onto a later query
      // sharing the pooled connection. Same reasoning as
      // provisionInvitedMembership.
      await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [organizationId]);
      const existing = await client.query<{ role: MembershipRole }>(
        `SELECT role FROM "${schema}".memberships
          WHERE organization_id = $1 AND user_id = $2
          FOR UPDATE`,
        [organizationId, userId]
      );
      const existingRole = existing.rows[0]?.role;
      await client.query(
        `INSERT INTO "${schema}".memberships (organization_id, user_id, role)
         VALUES ($1, $2, 'owner')
         ON CONFLICT (organization_id, user_id) DO UPDATE SET role = 'owner'`,
        [organizationId, userId]
      );
      await client.query("COMMIT");
      return {
        organizationId,
        userId,
        organizationCreated,
        userCreated,
        membership:
          existingRole === undefined ? "created" : existingRole === "owner" ? "unchanged" : "promoted"
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
  }
}

/**
 * Seeds one organization + user + membership and returns the user id.
 *
 * Exported for the same reason the assert* probes below are: pg lives in
 * this package, so a test that needs real rows either goes through here
 * or reaches for a driver it cannot resolve. It exists specifically so
 * the route-level magic-link test can seed a real member and then drive
 * the actual request/redeem handlers -- that test cannot live in this
 * package, because the workspace boundaries forbid packages from
 * importing apps.
 *
 * Idempotent on all three rows so repeated runs are safe. Synthetic
 * fixtures only; callers in a hosted environment have no reason to
 * invoke it.
 */
/**
 * Provision a throwaway schema with the migrations the authentication and
 * entry-point routes touch, and return its name.
 *
 * Lives here rather than in the test because `pg` is a packages/db
 * dependency and tests do not import it directly (the same reason
 * seedOrganizationMembership is here). It exists because
 * tests/integration/magic-link-route.test.ts previously pointed
 * DATABASE_SCHEMA at `public` and assumed it was already migrated: true on a
 * workstation after `pnpm dev:infra`, false in the Integration CI job, which
 * starts a bare postgres service with no migrations applied. All three route
 * tests passed locally and failed in CI.
 *
 * AF-97 widened it from the two magic-link migrations to the five the way
 * INTO a deployment now spans: audit_events, because an invite writes its
 * `admin_action` row in the same transaction as the token, and roles,
 * because "a recruiter can reach a role" is the thing entering a deployment
 * is for. One fixture rather than a near-identical second one, so the two
 * cannot drift about what a route-level probe contains.
 */
export async function provisionRouteProbeSchema(databaseUrl: string): Promise<string> {
  const schema = `route_probe_${randomBytes(4).toString("hex")}`;
  const admin = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    for (const file of [
      "0002_organizations_users_memberships.sql",
      "0003_magic_link_tokens.sql",
      "0005_immutable_audit_events.sql",
      // 0005_immutable_audit_events.sql leaves audit_events with an
      // ON DELETE CASCADE that fights its own append-only trigger, and the
      // file below is the fix; applying the first without the second would
      // give the probe a shape no real database has ever had.
      "0006_audit_events_delete_and_membership_fixes.sql",
      "0009_roles.sql",
      // The invite route deduplicates on this column (review #88, REV-007),
      // so a probe without it would not exercise the route as it ships.
      "0023_invite_idempotency.sql",
      // The fingerprint that binds a key to the request it was issued for
      // (review #88, REV-009) -- same reasoning as the migration above.
      "0024_invite_idempotency_fingerprint.sql"
    ]) {
      await admin.query(`SET search_path TO "${schema}"`);
      await admin.query(readFileSync(join(MIGRATIONS_DIRECTORY, file), "utf8"));
    }
  } finally {
    await admin.end().catch(() => undefined);
  }
  return schema;
}

export interface InferenceBudgetProbe {
  readonly schema: string;
  readonly organizationId: string;
}

/** Provision the minimal isolated schema needed by the budgeted worker path. */
export async function provisionInferenceBudgetProbeSchema(
  databaseUrl: string
): Promise<InferenceBudgetProbe> {
  const suffix = randomBytes(4).toString("hex");
  const schema = `budget_path_probe_${suffix}`;
  const organizationId = randomUUID();
  const admin = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    for (const migration of [
      "0002_organizations_users_memberships.sql",
      "0007_inference_usage_ledger.sql"
    ]) {
      await admin.query(readFileSync(join(MIGRATIONS_DIRECTORY, migration), "utf8"));
    }
    await admin.query(
      `INSERT INTO organizations (organization_id, name) VALUES ($1, 'AF-67 Synthetic Budget Probe')`,
      [organizationId]
    );
    return { schema, organizationId };
  } finally {
    await admin.end().catch(() => undefined);
  }
}

export interface FileIntakeRouteProbe {
  readonly schema: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly roleId: string;
  readonly intakeId: string;
  readonly storageKey: string;
}

/**
 * Review #83 round 2: the file-intake routes had no route-level coverage at
 * all, which is how a fix that was unit-tested at both ends could ship with
 * nothing wiring the two together, and how typed errors created for callers
 * to handle reached a generic 500 instead.
 *
 * Provisions a schema with the intake migrations and seeds the whole chain a
 * request needs, so a test can call the real handlers rather than a helper
 * they happen to share.
 */
export async function provisionFileIntakeRouteSchema(
  databaseUrl: string,
  options: {
    readonly declaredFilename: string;
    readonly declaredMimeType: string;
    readonly status?: FileIntakeStatus;
    readonly sniffedMimeType?: string;
    readonly sha256Hash?: string;
    readonly sizeBytes?: number;
  }
): Promise<FileIntakeRouteProbe> {
  const suffix = randomBytes(4).toString("hex");
  const schema = `intake_route_probe_${suffix}`;
  const organizationId = "11111111-1111-4111-8111-111111111111";
  const storageKey = `intake-route/${suffix}/${options.declaredFilename}`;
  const admin = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    for (const migration of [
      "0002_organizations_users_memberships.sql",
      "0006_evidence_extraction_runs.sql",
      "0009_roles.sql",
      "0013_file_intakes.sql",
      "0014_file_intake_validation.sql",
      "0015_canonical_text_extractions.sql",
      "0016_applications_and_import_finalization.sql"
    ]) {
      await admin.query(readFileSync(join(MIGRATIONS_DIRECTORY, migration), "utf8"));
    }
    await admin.query(`INSERT INTO organizations (organization_id, name) VALUES ($1, 'Route Probe Org')`, [
      organizationId
    ]);
    const user = await admin.query<{ user_id: string }>(
      `INSERT INTO users (email, display_name) VALUES ($1, 'Route Probe') RETURNING user_id`,
      [`intake_route_${suffix}@acme.test`]
    );
    const userId = user.rows[0]?.user_id;
    if (userId === undefined) {
      throw new Error("provisionFileIntakeRouteSchema did not produce a user row");
    }
    await admin.query(`INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'recruiter')`, [
      organizationId,
      userId
    ]);
    const role = await admin.query<{ role_id: string }>(
      `INSERT INTO roles (organization_id, title, created_by_user_id) VALUES ($1, 'Route Probe Role', $2)
       RETURNING role_id`,
      [organizationId, userId]
    );
    const roleId = role.rows[0]?.role_id;
    const intake = await admin.query<{ intake_id: string }>(
      `INSERT INTO file_intakes
         (organization_id, role_id, storage_key, declared_filename, declared_mime_type, created_by_user_id,
          status, sniffed_mime_type, sha256_hash, size_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'uploaded'), $8, $9, $10)
       RETURNING intake_id`,
      [
        organizationId,
        roleId,
        storageKey,
        options.declaredFilename,
        options.declaredMimeType,
        userId,
        options.status ?? null,
        options.sniffedMimeType ?? null,
        options.sha256Hash ?? null,
        options.sizeBytes ?? null
      ]
    );
    const intakeId = intake.rows[0]?.intake_id;
    if (intakeId === undefined || roleId === undefined) {
      throw new Error("provisionFileIntakeRouteSchema did not produce a role and intake");
    }
    return { schema, organizationId, userId, roleId, intakeId, storageKey };
  } finally {
    await admin.end().catch(() => undefined);
  }
}

/** Best-effort teardown for provisionRouteProbeSchema; each run is unique. */
export async function dropProbeSchema(databaseUrl: string, schema: string): Promise<void> {
  assertSafeSchema(schema);
  const admin = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } catch {
    // Best-effort: the next run uses a different suffix.
  } finally {
    await admin.end().catch(() => undefined);
  }
}

export async function seedOrganizationMembership(
  databaseUrl: string,
  schema: string,
  input: {
    readonly organizationId: string;
    readonly organizationName: string;
    readonly email: string;
    readonly displayName: string;
    readonly role: MembershipRole;
  }
): Promise<{ readonly userId: string }> {
  assertSafeSchema(schema);
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    await client.query(
      `INSERT INTO "${schema}".organizations (organization_id, name) VALUES ($1, $2)
         ON CONFLICT (organization_id) DO NOTHING`,
      [input.organizationId, input.organizationName]
    );
    const user = await client.query<{ user_id: string }>(
      `INSERT INTO "${schema}".users (email, display_name) VALUES ($1, $2)
         ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING user_id`,
      [input.email, input.displayName]
    );
    const userId = user.rows[0]?.user_id;
    if (userId === undefined) {
      throw new Error("seedOrganizationMembership did not produce a user row");
    }
    await client.query(
      `INSERT INTO "${schema}".memberships (organization_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (organization_id, user_id) DO NOTHING`,
      [input.organizationId, userId, input.role]
    );
    return { userId };
  } finally {
    await client.end().catch(() => undefined);
  }
}

// ---- AF-23: role creation ----

export interface CreateRoleInput {
  readonly organizationId: string;
  readonly title: string;
  readonly createdByUserId: string;
}

interface RoleRow {
  readonly role_id: string;
  readonly organization_id: string;
  readonly title: string;
  readonly status: RoleStatus;
  readonly created_by_user_id: string;
  readonly created_at: Date;
}

export async function createRole(
  databaseUrl: string,
  schema: string,
  input: CreateRoleInput
): Promise<Role> {
  assertSafeSchema(schema);
  const client = await acquireConnection(databaseUrl);
  try {
    const result = await client.query<RoleRow>(
      `INSERT INTO "${schema}".roles (organization_id, title, created_by_user_id)
       VALUES ($1, $2, $3)
       RETURNING role_id, organization_id, title, status, created_by_user_id, created_at`,
      [input.organizationId, input.title, input.createdByUserId]
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("role insert returned no row");
    }
    return {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      roleId: row.role_id,
      organizationId: row.organization_id,
      title: row.title,
      status: row.status,
      createdByUserId: row.created_by_user_id,
      createdAt: row.created_at.toISOString()
    };
  } finally {
    client.release();
  }
}

// ---- AF-24: recruiter roles list ----

export async function listRolesForOrganization(
  databaseUrl: string,
  schema: string,
  organizationId: string
): Promise<readonly Role[]> {
  assertSafeSchema(schema);
  const client = await acquireConnection(databaseUrl);
  try {
    const result = await client.query<RoleRow>(
      `SELECT role_id, organization_id, title, status, created_by_user_id, created_at
         FROM "${schema}".roles
        WHERE organization_id = $1
        ORDER BY created_at DESC`,
      [organizationId]
    );
    return result.rows.map((row) => ({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      roleId: row.role_id,
      organizationId: row.organization_id,
      title: row.title,
      status: row.status,
      createdByUserId: row.created_by_user_id,
      createdAt: row.created_at.toISOString()
    }));
  } finally {
    client.release();
  }
}

/** A single role, for routes that need to resolve roleId -> organizationId
 * before they can authorize the caller against it (e.g. AF-25's rubric
 * route: the role, not the rubric, is what's scoped to an organization). */
export async function getRoleById(
  databaseUrl: string,
  schema: string,
  roleId: string
): Promise<Role | undefined> {
  assertSafeSchema(schema);
  const client = await acquireConnection(databaseUrl);
  try {
    const result = await client.query<RoleRow>(
      `SELECT role_id, organization_id, title, status, created_by_user_id, created_at
         FROM "${schema}".roles
        WHERE role_id = $1`,
      [roleId]
    );
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    return {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      roleId: row.role_id,
      organizationId: row.organization_id,
      title: row.title,
      status: row.status,
      createdByUserId: row.created_by_user_id,
      createdAt: row.created_at.toISOString()
    };
  } finally {
    client.release();
  }
}

export interface ReserveInferenceBudgetInput extends RecordInferenceUsageInput {
  /** Cap on (input + output) tokens for this organization/model/period. */
  readonly maxTotalTokens: number;
}

export type ReserveInferenceBudgetOutcome =
  | { readonly outcome: "reserved"; readonly reservationId: string; readonly totalTokensAfter: number }
  | { readonly outcome: "cap_exceeded"; readonly totalTokensBefore: number; readonly maxTotalTokens: number };

/**
 * Atomic check-and-reserve. Reading the total with getInferenceUsage and
 * then incrementing with recordInferenceUsage cannot be made safe by the
 * caller: each opens its own connection, so they cannot share a
 * transaction, and concurrent requests near the cap all read the same
 * pre-increment total, all pass the check, and the burst spends
 * arbitrarily far past the budget.
 *
 * Doing both in one statement closes that window. The INSERT ... ON
 * CONFLICT DO UPDATE takes a row lock on conflict, so concurrent callers
 * serialize on it, and the WHERE clause re-evaluates the cap against the
 * row's committed value at that moment -- not against a total read
 * earlier. When the guard fails the UPDATE affects no row, RETURNING is
 * empty, and we report cap_exceeded instead of over-spending.
 *
 * What this writes is an ESTIMATE, in the same columns that otherwise hold
 * provider-reported usage. Every reserved call must be followed by
 * `settleInferenceReservation` with the real numbers, which applies the
 * difference. Calling `recordInferenceUsage` instead double-counts the call.
 */
export async function reserveInferenceBudget(
  databaseUrl: string,
  schema: string,
  input: ReserveInferenceBudgetInput
): Promise<ReserveInferenceBudgetOutcome> {
  assertSafeSchema(schema);
  assertNonNegativeUsage(input);
  // Validated here rather than left to the `$7::bigint` cast. An unchecked
  // NaN or fractional value fails inside Postgres with a cast error that
  // names neither the field nor the caller, and a negative cap would make
  // every reservation fail as cap_exceeded rather than being rejected as
  // the nonsense it is.
  if (!Number.isSafeInteger(input.maxTotalTokens) || input.maxTotalTokens < 0) {
    throw new Error(
      `reserveInferenceBudget requires a non-negative safe integer maxTotalTokens, got: ${input.maxTotalTokens}`
    );
  }
  const requested = input.inputTokens + input.outputTokens;
  // A zero-token reservation is refused rather than granted. Both guards below
  // are `<=`, so a caller sitting exactly at its cap satisfies
  // `total + 0 <= cap` and is told `reserved`, forever: with no pre-call
  // estimate it can keep reserving nothing and keep calling the provider after
  // the budget should have blocked everything. That also contradicted the
  // domain, where `checkInferenceBudget` treats zero usage against a zero cap
  // as `capped`. Reserving nothing is not a meaningful request, so it is an
  // error at the boundary rather than a silently granted no-op.
  if (requested <= 0) {
    throw new Error(
      "reserveInferenceBudget requires a positive token estimate; " +
        `reserving zero cannot be checked against a cap, got inputTokens=${input.inputTokens} outputTokens=${input.outputTokens}`
    );
  }
  const client = await acquireConnection(databaseUrl);
  try {
    const reserved = await client.query<{ reservation_id: string; total_tokens: string }>(
      `WITH updated_ledger AS (
         INSERT INTO "${schema}".inference_usage_ledger
           (organization_id, model, period_start, input_tokens, output_tokens)
         SELECT $1, $2, $3, $4, $5
          WHERE $6::bigint <= $7::bigint
         ON CONFLICT (organization_id, model, period_start) DO UPDATE SET
           input_tokens = "${schema}".inference_usage_ledger.input_tokens + EXCLUDED.input_tokens,
           output_tokens = "${schema}".inference_usage_ledger.output_tokens + EXCLUDED.output_tokens,
           updated_at = clock_timestamp()
          WHERE "${schema}".inference_usage_ledger.input_tokens
              + "${schema}".inference_usage_ledger.output_tokens
              + $6::bigint <= $7::bigint
         RETURNING (input_tokens + output_tokens)::bigint AS total_tokens
       ), created_reservation AS (
         INSERT INTO "${schema}".inference_usage_reservations
           (organization_id, model, period_start, reserved_input_tokens, reserved_output_tokens)
         SELECT $1, $2, $3, $4, $5 FROM updated_ledger
         RETURNING reservation_id
       )
       SELECT created_reservation.reservation_id, updated_ledger.total_tokens
         FROM updated_ledger CROSS JOIN created_reservation`,
      [
        input.organizationId,
        input.model,
        input.periodStart,
        input.inputTokens,
        input.outputTokens,
        requested,
        input.maxTotalTokens
      ]
    );
    const row = reserved.rows[0];
    if (row !== undefined) {
      return {
        outcome: "reserved",
        reservationId: row.reservation_id,
        totalTokensAfter: bigintColumnToNumber(row.total_tokens, "total_tokens")
      };
    }
    // Read back on the connection already open, rather than calling
    // getInferenceUsage and opening a second one. This is the capped path,
    // which is the hot one exactly when a tenant is hammering the cap.
    // Summed in Postgres, not in JavaScript. Checking each bigint for safe-
    // integer range and then adding the two numbers lets an unsafe total
    // through: 6e15 input and 6e15 output are each individually safe, and
    // their 1.2e16 sum is not, so it would be reported rounded while the
    // per-column checks reported success. Adding first and converting once
    // means `bigintColumnToNumber` sees the value actually being returned and
    // fails loudly on it, which is the contract the rest of this path keeps.
    const current = await client.query<{ total_tokens: string }>(
      `SELECT (input_tokens + output_tokens)::bigint AS total_tokens
         FROM "${schema}".inference_usage_ledger
        WHERE organization_id = $1 AND model = $2 AND period_start = $3`,
      [input.organizationId, input.model, input.periodStart]
    );
    const currentRow = current.rows[0];
    const totalTokensBefore =
      currentRow === undefined ? 0 : bigintColumnToNumber(currentRow.total_tokens, "total_tokens");
    return {
      outcome: "cap_exceeded",
      totalTokensBefore,
      maxTotalTokens: input.maxTotalTokens
    };
  } finally {
    client.release();
  }
}

export interface SettleInferenceReservationInput {
  /** The durable identity returned from `reserveInferenceBudget`. */
  readonly reservationId: string;
  /** What the provider actually reported afterwards. */
  readonly actualInputTokens: number;
  readonly actualOutputTokens: number;
}

/**
 * Replace a reservation with the provider's real numbers.
 *
 * A reservation has to be written before the call, when only an estimate
 * exists, but it lands in the same two columns that afterwards hold
 * provider-reported usage. Without this step the ledger is wrong either way:
 * call `recordInferenceUsage` after the response and the estimate and the
 * actual are both counted (reserve 100, consume 70, record 170); skip it and
 * a column documented as provider-reported usage permanently holds a guess.
 * Either way the cap is reached before the tokens were really spent.
 *
 * So settlement applies the difference rather than adding again. Over-
 * estimates refund, under-estimates top up, and an exact estimate is a no-op.
 * This is the call that pairs with `reserveInferenceBudget`;
 * `recordInferenceUsage` is for the unreserved path and must not also be
 * called for a reserved one.
 *
 * `GREATEST(0, ...)` is not defensive decoration. The columns carry
 * `CHECK (>= 0)`, and a refund larger than the stored total would violate it
 * and abort the statement: reachable whenever a period rolls over or a row is
 * reset between the reservation and the response, which is exactly when a
 * failed settlement would be least welcome.
 */
export async function settleInferenceReservation(
  databaseUrl: string,
  schema: string,
  input: SettleInferenceReservationInput
): Promise<{ readonly outcome: "settled" | "already_settled" }> {
  assertSafeSchema(schema);
  for (const [field, value] of [
    ["actualInputTokens", input.actualInputTokens],
    ["actualOutputTokens", input.actualOutputTokens]
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`settleInferenceReservation requires a non-negative safe integer ${field}, got: ${value}`);
    }
  }

  const client = await acquireConnection(databaseUrl);
  try {
    await client.query("BEGIN");
    try {
      const reservation = await client.query<{
        organization_id: string;
        model: string;
        period_start: string;
        reserved_input_tokens: string;
        reserved_output_tokens: string;
        settled_at: string | null;
      }>(
        `SELECT organization_id, model, period_start, reserved_input_tokens, reserved_output_tokens, settled_at
           FROM "${schema}".inference_usage_reservations
          WHERE reservation_id = $1
          FOR UPDATE`,
        [input.reservationId]
      );
      const row = reservation.rows[0];
      if (row === undefined) {
        throw new Error(`inference usage reservation ${input.reservationId} does not exist`);
      }
      if (row.settled_at !== null) {
        await client.query("COMMIT");
        return { outcome: "already_settled" };
      }
      const inputDelta = input.actualInputTokens - bigintColumnToNumber(row.reserved_input_tokens, "reserved_input_tokens");
      const outputDelta = input.actualOutputTokens - bigintColumnToNumber(row.reserved_output_tokens, "reserved_output_tokens");
      const ledger = await client.query(
        `UPDATE "${schema}".inference_usage_ledger
            SET input_tokens = input_tokens + $4::bigint,
                output_tokens = output_tokens + $5::bigint,
                updated_at = clock_timestamp()
          WHERE organization_id = $1 AND model = $2 AND period_start = $3`,
        [row.organization_id, row.model, row.period_start, inputDelta, outputDelta]
      );
      if (ledger.rowCount !== 1) {
        throw new Error(`inference usage reservation ${input.reservationId} has no matching ledger row`);
      }
      await client.query(
        `UPDATE "${schema}".inference_usage_reservations
            SET settled_at = clock_timestamp(), actual_input_tokens = $2, actual_output_tokens = $3
          WHERE reservation_id = $1`,
        [input.reservationId, input.actualInputTokens, input.actualOutputTokens]
      );
      await client.query("COMMIT");
      return { outcome: "settled" };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
  }
}

// ---- AF-25: rubric draft/edit ----

interface RubricRow {
  readonly rubric_id: string;
  readonly role_id: string;
  readonly version: number;
  readonly status: RubricStatus;
  readonly criteria: readonly RubricCriterion[];
  readonly approved_by_user_id: string | null;
  readonly approved_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

function rowToRubric(row: RubricRow): Rubric {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    rubricId: row.rubric_id,
    roleId: row.role_id,
    version: row.version,
    status: row.status,
    criteria: row.criteria,
    ...(row.approved_by_user_id === null ? {} : { approvedByUserId: row.approved_by_user_id }),
    ...(row.approved_at === null ? {} : { approvedAt: row.approved_at.toISOString() }),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

const RUBRIC_COLUMNS =
  "rubric_id, role_id, version, status, criteria, approved_by_user_id, approved_at, created_at, updated_at";

/** The draft if one exists, else the highest-version published rubric, else undefined. */
export async function getRubricForRole(
  databaseUrl: string,
  schema: string,
  roleId: string
): Promise<Rubric | undefined> {
  assertSafeSchema(schema);
  const client = await acquireConnection(databaseUrl);
  try {
    const result = await client.query<RubricRow>(
      `SELECT ${RUBRIC_COLUMNS}
         FROM "${schema}".rubrics
        WHERE role_id = $1
        ORDER BY (status = 'draft') DESC, version DESC
        LIMIT 1`,
      [roleId]
    );
    return result.rows[0] === undefined ? undefined : rowToRubric(result.rows[0]);
  } finally {
    client.release();
  }
}

export interface EvidenceExtractionQueueProbe {
  readonly schema: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly roleId: string;
  readonly applicationId: string;
  readonly sourceIntakeId: string;
  readonly rubricId: string;
}

/** A fully valid synthetic application/document/rubric chain for worker tests. */
export async function provisionEvidenceExtractionQueueProbeSchema(
  databaseUrl: string
): Promise<EvidenceExtractionQueueProbe> {
  const suffix = randomBytes(4).toString("hex");
  const schema = `extraction_queue_probe_${suffix}`;
  const organizationId = randomUUID();
  const admin = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    for (const migration of [
      "0002_organizations_users_memberships.sql",
      "0006_evidence_extraction_runs.sql",
      "0007_inference_usage_ledger.sql",
      "0008_inference_kill_switch.sql",
      "0009_inference_kill_switch_nonblank_reason.sql",
      "0009_roles.sql",
      "0010_kill_switch_reason_non_whitespace.sql",
      "0011_rubrics.sql",
      "0012_immutable_published_rubrics.sql",
      "0013_file_intakes.sql",
      "0014_file_intake_validation.sql",
      "0015_canonical_text_extractions.sql",
      "0016_applications_and_import_finalization.sql",
      "0017_evidence_outcomes.sql",
      "0018_evidence_corrections.sql",
      "0019_correction_attribution.sql",
      "0026_evidence_extraction_jobs.sql"
    ]) {
      await admin.query(readFileSync(join(MIGRATIONS_DIRECTORY, migration), "utf8"));
    }
    await admin.query(`INSERT INTO organizations (organization_id, name) VALUES ($1, 'AF-102 Synthetic Queue Probe')`, [
      organizationId
    ]);
    const user = await admin.query<{ user_id: string }>(
      `INSERT INTO users (email, display_name) VALUES ($1, 'AF-102 Probe') RETURNING user_id`,
      [`af102_${suffix}@example.test`]
    );
    const userId = user.rows[0]?.user_id;
    if (userId === undefined) throw new Error("queue probe did not create a user");
    await admin.query(`INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'recruiter')`, [
      organizationId,
      userId
    ]);
    const role = await admin.query<{ role_id: string }>(
      `INSERT INTO roles (organization_id, title, created_by_user_id) VALUES ($1, 'Synthetic Engineer', $2)
       RETURNING role_id`,
      [organizationId, userId]
    );
    const roleId = role.rows[0]?.role_id;
    if (roleId === undefined) throw new Error("queue probe did not create a role");
    const criteria = Array.from({ length: 5 }, (_, index) => ({
      criterionId: `criterion_${index + 1}`,
      description: `Synthetic criterion ${index + 1}`,
      evidenceGuidance: `Find explicit evidence for criterion ${index + 1}`
    }));
    const rubric = await admin.query<{ rubric_id: string }>(
      `INSERT INTO rubrics
         (role_id, version, status, criteria, approved_by_user_id, approved_at)
       VALUES ($1, 1, 'published', $2::jsonb, $3, clock_timestamp())
       RETURNING rubric_id`,
      [roleId, JSON.stringify(criteria), userId]
    );
    const rubricId = rubric.rows[0]?.rubric_id;
    const csvIntake = await admin.query<{ intake_id: string }>(
      `INSERT INTO file_intakes
         (organization_id, role_id, storage_key, declared_filename, declared_mime_type, status,
          created_by_user_id, sniffed_mime_type, size_bytes, sha256_hash)
       VALUES ($1, $2, $3, 'applications.csv', 'text/csv', 'imported', $4, 'text/csv', 128, $5)
       RETURNING intake_id`,
      [organizationId, roleId, `probe/${suffix}/applications.csv`, userId, "a".repeat(64)]
    );
    const csvIntakeId = csvIntake.rows[0]?.intake_id;
    if (csvIntakeId === undefined || rubricId === undefined) {
      throw new Error("queue probe did not create rubric and CSV intake");
    }
    const application = await admin.query<{ application_id: string }>(
      `INSERT INTO applications
         (organization_id, role_id, intake_id, source_row_number, candidate_full_name, candidate_email)
       VALUES ($1, $2, $3, 1, 'Synthetic Candidate', 'candidate@example.test')
       RETURNING application_id`,
      [organizationId, roleId, csvIntakeId]
    );
    const applicationId = application.rows[0]?.application_id;
    const source = await admin.query<{ intake_id: string }>(
      `INSERT INTO file_intakes
         (organization_id, role_id, storage_key, declared_filename, declared_mime_type, status,
          created_by_user_id, sniffed_mime_type, size_bytes, sha256_hash)
       VALUES ($1, $2, $3, 'synthetic.pdf', 'application/pdf', 'validated', $4,
               'application/pdf', 256, $5)
       RETURNING intake_id`,
      [organizationId, roleId, `probe/${suffix}/synthetic.pdf`, userId, "b".repeat(64)]
    );
    const sourceIntakeId = source.rows[0]?.intake_id;
    if (applicationId === undefined || sourceIntakeId === undefined) {
      throw new Error("queue probe did not create application and source intake");
    }
    const text = "Built and operated PostgreSQL services with TypeScript and reliable queue workers.";
    await admin.query(
      `INSERT INTO canonical_text_extractions (intake_id, pages, total_pages, quality)
       VALUES ($1, $2::jsonb, 1, 'full')`,
      [sourceIntakeId, JSON.stringify([{ pageNumber: 1, text, characterCount: text.length }])]
    );
    return { schema, organizationId, userId, roleId, applicationId, sourceIntakeId, rubricId };
  } finally {
    await admin.end().catch(() => undefined);
  }
}

/** The immutable published rubric version used by hosted extraction. */
export async function getLatestPublishedRubricForRole(
  databaseUrl: string,
  schema: string,
  roleId: string
): Promise<Rubric | undefined> {
  assertSafeSchema(schema);
  const client = await acquireConnection(databaseUrl);
  try {
    const result = await client.query<RubricRow>(
      `SELECT ${RUBRIC_COLUMNS}
         FROM "${schema}".rubrics
        WHERE role_id = $1 AND status = 'published'
        ORDER BY version DESC
        LIMIT 1`,
      [roleId]
    );
    return result.rows[0] === undefined ? undefined : rowToRubric(result.rows[0]);
  } finally {
    client.release();
  }
}

export type UpsertDraftRubricOutcome =
  | { readonly outcome: "saved"; readonly rubric: Rubric }
  | { readonly outcome: "no_such_role" };

/**
 * Creates the role's first draft, or overwrites the existing one --
 * never both in the same call, and never touches a published version.
 * The role_id foreign key plus the one-draft-per-role partial unique
 * index (0011_rubrics.sql) are what make this safe under concurrent
 * calls: a race to create the first draft fails one caller with a
 * unique-violation rather than silently producing two drafts.
 */
export async function upsertDraftRubric(
  databaseUrl: string,
  schema: string,
  roleId: string,
  criteria: readonly RubricCriterion[]
): Promise<UpsertDraftRubricOutcome> {
  assertSafeSchema(schema);
  const client = await acquireConnection(databaseUrl);
  try {
    const criteriaJson = JSON.stringify(criteria);
    const updated = await client.query<RubricRow>(
      `UPDATE "${schema}".rubrics
          SET criteria = $2::jsonb, updated_at = CURRENT_TIMESTAMP
        WHERE role_id = $1 AND status = 'draft'
        RETURNING ${RUBRIC_COLUMNS}`,
      [roleId, criteriaJson]
    );
    const updatedRow = updated.rows[0];
    if (updatedRow !== undefined) {
      return { outcome: "saved", rubric: rowToRubric(updatedRow) };
    }

    const roleExists = await client.query(`SELECT 1 FROM "${schema}".roles WHERE role_id = $1`, [roleId]);
    if (roleExists.rows[0] === undefined) {
      return { outcome: "no_such_role" };
    }

    const inserted = await client.query<RubricRow>(
      `INSERT INTO "${schema}".rubrics (role_id, version, criteria)
       VALUES ($1, COALESCE((SELECT MAX(version) FROM "${schema}".rubrics WHERE role_id = $1), 0) + 1, $2::jsonb)
       RETURNING ${RUBRIC_COLUMNS}`,
      [roleId, criteriaJson]
    );
    const insertedRow = inserted.rows[0];
    if (insertedRow === undefined) {
      throw new Error("rubric insert returned no row");
    }
    return { outcome: "saved", rubric: rowToRubric(insertedRow) };
  } finally {
    client.release();
  }
}

// ---- AF-27: named approval and immutable rubric publishing ----

export type PublishRubricOutcome =
  | { readonly outcome: "published"; readonly rubric: Rubric }
  | { readonly outcome: "no_draft" };

/**
 * The UPDATE's own WHERE status = 'draft' is what makes "approve the
 * current draft" atomic and race-free -- two concurrent publish calls
 * can't both succeed, and once the first one wins, migration
 * 0012_immutable_published_rubrics.sql's trigger makes the resulting row
 * permanently unreachable to any future UPDATE, this function included.
 * (That migration was authored as `0011` on the original branch; `0011`
 * was already taken by the rubrics table itself on the reconstruction
 * baseline, so it was renumbered and this reference follows it.)
 */
export async function publishRubric(
  databaseUrl: string,
  schema: string,
  rubricId: string,
  approvedByUserId: string
): Promise<PublishRubricOutcome> {
  assertSafeSchema(schema);
  const client = await acquireConnection(databaseUrl);
  try {
    const result = await client.query<RubricRow>(
      `UPDATE "${schema}".rubrics
          SET status = 'published', approved_by_user_id = $2, approved_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
        WHERE rubric_id = $1 AND status = 'draft'
        RETURNING ${RUBRIC_COLUMNS}`,
      [rubricId, approvedByUserId]
    );
    const row = result.rows[0];
    return row === undefined ? { outcome: "no_draft" } : { outcome: "published", rubric: rowToRubric(row) };
  } finally {
    client.release();
  }
}

// ---- AF-28: secure direct file upload ----

export interface CreateFileIntakeInput {
  readonly organizationId: string;
  readonly roleId: string;
  readonly storageKey: string;
  readonly declaredFilename: string;
  readonly declaredMimeType: string;
  readonly createdByUserId: string;
}

interface FileIntakeRow {
  readonly intake_id: string;
  readonly organization_id: string;
  readonly role_id: string;
  readonly storage_key: string;
  readonly declared_filename: string;
  readonly declared_mime_type: string;
  readonly status: FileIntakeStatus;
  readonly created_by_user_id: string;
  readonly created_at: Date;
  readonly sniffed_mime_type: string | null;
  readonly size_bytes: string | null;
  readonly sha256_hash: string | null;
  readonly rejection_reason: string | null;
}

function rowToFileIntake(row: FileIntakeRow): FileIntake {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    intakeId: row.intake_id,
    organizationId: row.organization_id,
    roleId: row.role_id,
    storageKey: row.storage_key,
    declaredFilename: row.declared_filename,
    declaredMimeType: row.declared_mime_type,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at.toISOString(),
    ...(row.sniffed_mime_type === null ? {} : { sniffedMimeType: row.sniffed_mime_type }),
    ...(row.size_bytes === null ? {} : { sizeBytes: Number(row.size_bytes) }),
    ...(row.sha256_hash === null ? {} : { sha256Hash: row.sha256_hash }),
    ...(row.rejection_reason === null ? {} : { rejectionReason: row.rejection_reason })
  };
}

const FILE_INTAKE_COLUMNS =
  "intake_id, organization_id, role_id, storage_key, declared_filename, declared_mime_type, status, created_by_user_id, created_at, sniffed_mime_type, size_bytes, sha256_hash, rejection_reason";

export async function createFileIntake(
  databaseUrl: string,
  schema: string,
  input: CreateFileIntakeInput
): Promise<FileIntake> {
  assertSafeSchema(schema);
  const client = await acquireConnection(databaseUrl);
  try {
    const result = await client.query<FileIntakeRow>(
      `INSERT INTO "${schema}".file_intakes
         (organization_id, role_id, storage_key, declared_filename, declared_mime_type, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${FILE_INTAKE_COLUMNS}`,
      [
        input.organizationId,
        input.roleId,
        input.storageKey,
        input.declaredFilename,
        input.declaredMimeType,
        input.createdByUserId
      ]
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("file intake insert returned no row");
    }
    return rowToFileIntake(row);
  } finally {
    client.release();
  }
}

export async function getFileIntakeById(
  databaseUrl: string,
  schema: string,
  intakeId: string
): Promise<FileIntake | undefined> {
  assertSafeSchema(schema);
  const client = await acquireConnection(databaseUrl);
  try {
    const result = await client.query<FileIntakeRow>(
      `SELECT ${FILE_INTAKE_COLUMNS} FROM "${schema}".file_intakes WHERE intake_id = $1`,
      [intakeId]
    );
    return result.rows[0] === undefined ? undefined : rowToFileIntake(result.rows[0]);
  } finally {
    client.release();
  }
}

export type MarkFileIntakeUploadedOutcome =
  | { readonly outcome: "uploaded"; readonly intake: FileIntake }
  | { readonly outcome: "not_pending" };

/** WHERE status = 'pending' makes this a one-shot transition: calling it
 * twice (a retried client request, say) leaves the row exactly as the
 * first call left it, reported honestly as not_pending rather than
 * silently "succeeding" a second time. */
export async function markFileIntakeUploaded(
  databaseUrl: string,
  schema: string,
  intakeId: string
): Promise<MarkFileIntakeUploadedOutcome> {
  assertSafeSchema(schema);
  const client = await acquireConnection(databaseUrl);
  try {
    const result = await client.query<FileIntakeRow>(
      `UPDATE "${schema}".file_intakes
          SET status = 'uploaded'
        WHERE intake_id = $1 AND status = 'pending'
        RETURNING ${FILE_INTAKE_COLUMNS}`,
      [intakeId]
    );
    const row = result.rows[0];
    return row === undefined ? { outcome: "not_pending" } : { outcome: "uploaded", intake: rowToFileIntake(row) };
  } finally {
    client.release();
  }
}

export interface RecordFileValidationInput {
  readonly sniffedMimeType: string | undefined;
  readonly sizeBytes: number;
  /** Absent when the object was refused before it could be read, such as an
   * oversized upload the streaming cap rejected: there are no bytes to hash.
   * Such an intake is quarantined, so no later step looks for one. */
  readonly sha256Hash?: string | undefined;
  readonly validation: { readonly outcome: "validated" } | { readonly outcome: "quarantined"; readonly reason: string };
}

export type RecordFileValidationOutcome =
  | { readonly outcome: "recorded"; readonly intake: FileIntake }
  | { readonly outcome: "not_uploaded" };

/** WHERE status = 'uploaded' is the same one-shot pattern as
 * markFileIntakeUploaded -- validation can only run once against a
 * freshly-uploaded object, never re-run against something already
 * validated/quarantined/rejected (which would let a second, more
 * lenient pass override a real quarantine finding). */
/**
 * Quarantines an intake whose stored bytes no longer match the validated
 * digest.
 *
 * Review #83: without this an overwrite left the intake `validated` forever,
 * so every preview, extract and finalize call returned the same opaque 500
 * and nothing recorded why. Moving it to `quarantined` makes the state match
 * reality and stops the row being reprocessed.
 *
 * Deliberately does not clear the recorded hash: that digest is the evidence
 * of what was approved, and losing it would destroy the only means of showing
 * later that a substitution happened.
 */
export async function invalidateChangedIntake(
  databaseUrl: string,
  schema: string,
  intakeId: string,
  detail: { readonly expectedSha256: string; readonly actualSha256: string }
): Promise<void> {
  assertSafeSchema(schema);
  const client = await acquireConnection(databaseUrl);
  try {
    await client.query(
      `UPDATE "${schema}".file_intakes
          SET status = 'quarantined', rejection_reason = $2
        WHERE intake_id = $1 AND status <> 'quarantined'`,
      [
        intakeId,
        `Stored object no longer matches the validated content hash (validated ${detail.expectedSha256}, ` +
          `found ${detail.actualSha256}); the upload was replaced after validation.`
      ]
    );
  } finally {
    client.release();
  }
}

/**
 * Quarantines an intake whose post-validation read exceeded the same byte
 * limit validation itself enforces.
 *
 * Review #83, REV-014: this case was left `validated` on the theory that an
 * oversized read says nothing about whether the stored bytes are the
 * approved ones. That theory doesn't hold: the approved bytes already passed
 * this exact limit during validation, so bytes that now exceed it cannot be
 * those bytes -- the object was replaced (or the limit tightened) after
 * validation, same as a hash mismatch. Leaving it `validated` stranded the
 * intake forever, since every reader keeps rejecting it with no path back to
 * quarantined/re-upload.
 *
 * Deliberately does not clear the recorded hash, for the same reason
 * invalidateChangedIntake doesn't: it is the evidence of what was approved.
 */
export async function invalidateOversizedIntake(
  databaseUrl: string,
  schema: string,
  intakeId: string,
  detail: { readonly limitBytes: number }
): Promise<void> {
  assertSafeSchema(schema);
  const client = await acquireConnection(databaseUrl);
  try {
    await client.query(
      `UPDATE "${schema}".file_intakes
          SET status = 'quarantined', rejection_reason = $2
        WHERE intake_id = $1 AND status <> 'quarantined'`,
      [
        intakeId,
        `Stored object now exceeds the ${detail.limitBytes}-byte validated read limit; the upload was replaced ` +
          `after validation.`
      ]
    );
  } finally {
    client.release();
  }
}

export async function recordFileValidationResult(
  databaseUrl: string,
  schema: string,
  intakeId: string,
  input: RecordFileValidationInput
): Promise<RecordFileValidationOutcome> {
  assertSafeSchema(schema);
  const client = await acquireConnection(databaseUrl);
  try {
    const newStatus: FileIntakeStatus = input.validation.outcome === "validated" ? "validated" : "quarantined";
    const rejectionReason = input.validation.outcome === "validated" ? null : input.validation.reason;
    const result = await client.query<FileIntakeRow>(
      `UPDATE "${schema}".file_intakes
          SET status = $2, sniffed_mime_type = $3, size_bytes = $4, sha256_hash = $5, rejection_reason = $6
        WHERE intake_id = $1 AND status = 'uploaded'
        RETURNING ${FILE_INTAKE_COLUMNS}`,
      [intakeId, newStatus, input.sniffedMimeType ?? null, input.sizeBytes, input.sha256Hash ?? null, rejectionReason]
    );
    const row = result.rows[0];
    return row === undefined ? { outcome: "not_uploaded" } : { outcome: "recorded", intake: rowToFileIntake(row) };
  } finally {
    client.release();
  }
}

// ---- AF-30: PDF/DOCX canonical text parser ----

export interface CreateCanonicalTextExtractionInput {
  readonly intakeId: string;
  readonly pages: readonly CanonicalTextPage[];
  readonly quality: CanonicalTextQuality;
}

interface CanonicalTextExtractionRow {
  readonly extraction_id: string;
  readonly intake_id: string;
  readonly pages: readonly CanonicalTextPage[];
  readonly total_pages: number;
  readonly quality: CanonicalTextQuality;
  readonly created_at: Date;
}

function rowToCanonicalTextExtraction(row: CanonicalTextExtractionRow): CanonicalTextExtraction {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    extractionId: row.extraction_id,
    intakeId: row.intake_id,
    pages: row.pages,
    totalPages: row.total_pages,
    quality: row.quality,
    createdAt: row.created_at.toISOString()
  };
}

const CANONICAL_TEXT_EXTRACTION_COLUMNS = "extraction_id, intake_id, pages, total_pages, quality, created_at";

/** ON CONFLICT (intake_id) DO NOTHING + the follow-up SELECT is the same
 * "idempotent, not a race" shape as AF-16's redemption: re-running
 * extraction against an intake that already has one returns the
 * existing row rather than erroring or producing a second one. */
export async function createCanonicalTextExtraction(
  databaseUrl: string,
  schema: string,
  input: CreateCanonicalTextExtractionInput
): Promise<CanonicalTextExtraction> {
  assertSafeSchema(schema);
  const client = await acquireConnection(databaseUrl);
  try {
    const pagesJson = JSON.stringify(input.pages);
    await client.query(
      `INSERT INTO "${schema}".canonical_text_extractions (intake_id, pages, total_pages, quality)
       VALUES ($1, $2::jsonb, $3, $4)
       ON CONFLICT (intake_id) DO NOTHING`,
      [input.intakeId, pagesJson, input.pages.length, input.quality]
    );
    const result = await client.query<CanonicalTextExtractionRow>(
      `SELECT ${CANONICAL_TEXT_EXTRACTION_COLUMNS} FROM "${schema}".canonical_text_extractions WHERE intake_id = $1`,
      [input.intakeId]
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("canonical text extraction upsert returned no row");
    }
    return rowToCanonicalTextExtraction(row);
  } finally {
    client.release();
  }
}

export async function getCanonicalTextExtractionByIntakeId(
  databaseUrl: string,
  schema: string,
  intakeId: string
): Promise<CanonicalTextExtraction | undefined> {
  assertSafeSchema(schema);
  const client = await acquireConnection(databaseUrl);
  try {
    const result = await client.query<CanonicalTextExtractionRow>(
      `SELECT ${CANONICAL_TEXT_EXTRACTION_COLUMNS} FROM "${schema}".canonical_text_extractions WHERE intake_id = $1`,
      [intakeId]
    );
    return result.rows[0] === undefined ? undefined : rowToCanonicalTextExtraction(result.rows[0]);
  } finally {
    client.release();
  }
}

// ---- AF-32: idempotent import finalization ----
//
// import_finalizations has UNIQUE(intake_id): at most one finalization
// record can ever exist per intake. Locked with FOR UPDATE the moment
// it's read, so two concurrent finalize calls for the same intake
// serialize on this row instead of both racing past the "no existing
// finalization" check and double-importing. A matching key AND mapping
// is a genuine replay (returns the exact rows already recorded, does no
// new work); anything else against an already-finalized intake is a
// real conflict, not a silent overwrite of the first result.

export interface FinalizeCsvImportInput {
  readonly organizationId: string;
  readonly roleId: string;
  readonly intakeId: string;
  readonly idempotencyKey: string;
  readonly mapping: readonly CsvColumnMapping[];
  readonly rows: readonly Readonly<Record<string, string>>[];
}

export type FinalizeCsvImportOutcome =
  | { readonly outcome: "finalized"; readonly summary: ImportFinalizationSummary; readonly rows: readonly ImportRow[] }
  | { readonly outcome: "replayed"; readonly summary: ImportFinalizationSummary; readonly rows: readonly ImportRow[] }
  | { readonly outcome: "conflict" }
  | { readonly outcome: "not_validated" };

interface ImportRowRow {
  readonly import_row_id: string;
  readonly intake_id: string;
  readonly row_number: number;
  readonly outcome: ImportRowOutcome;
  readonly application_id: string | null;
  readonly failure_reason: string | null;
}

function rowToImportRow(row: ImportRowRow): ImportRow {
  return {
    importRowId: row.import_row_id,
    intakeId: row.intake_id,
    rowNumber: row.row_number,
    outcome: row.outcome,
    ...(row.application_id === null ? {} : { applicationId: row.application_id }),
    ...(row.failure_reason === null ? {} : { failureReason: row.failure_reason })
  };
}

const IMPORT_ROW_COLUMNS = "import_row_id, intake_id, row_number, outcome, application_id, failure_reason";

/**
 * Canonicalizes an optional appliedAt for storage. Returns null when absent.
 *
 * Throws if the value is unparseable, which should be unreachable:
 * classifyCsvImportRow fails such a row before it reaches here. The throw is
 * deliberate rather than a silent null, because a null would quietly discard
 * a date the operator supplied, and reaching it would mean validation and
 * persistence had drifted apart.
 */
function normalizedAppliedAt(raw: string | undefined): string | null {
  if (raw === undefined) {
    return null;
  }
  const normalized = normalizeAppliedAt(raw);
  if (normalized.outcome === "invalid") {
    throw new Error(
      `finalizeCsvImport received an appliedAt that classifyCsvImportRow should already have failed: ${JSON.stringify(raw)}`
    );
  }
  return normalized.value;
}

async function insertImportRow(
  client: ClientBase,
  schema: string,
  intakeId: string,
  rowNumber: number,
  classification: ReturnType<typeof classifyCsvImportRow>,
  applicationId: string | undefined
): Promise<ImportRow> {
  const outcome = classification.outcome;
  const failureReason = classification.outcome === "failed" ? classification.reason : null;
  const result = await client.query<ImportRowRow>(
    `INSERT INTO "${schema}".import_rows (intake_id, row_number, outcome, application_id, failure_reason)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${IMPORT_ROW_COLUMNS}`,
    [intakeId, rowNumber, outcome, applicationId ?? null, failureReason]
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("import row insert returned no row");
  }
  return rowToImportRow(row);
}

export async function finalizeCsvImport(
  databaseUrl: string,
  schema: string,
  input: FinalizeCsvImportInput
): Promise<FinalizeCsvImportOutcome> {
  assertSafeSchema(schema);
  const client = await acquireConnection(databaseUrl);
  try {
    await client.query("BEGIN");
    try {
      const existing = await client.query<{ idempotency_key: string; mapping: CsvColumnMapping[] }>(
        `SELECT idempotency_key, mapping FROM "${schema}".import_finalizations WHERE intake_id = $1 FOR UPDATE`,
        [input.intakeId]
      );
      const existingRow = existing.rows[0];
      if (existingRow !== undefined) {
        const sameRequest =
          existingRow.idempotency_key === input.idempotencyKey &&
          canonicalizeCsvColumnMapping(existingRow.mapping) === canonicalizeCsvColumnMapping(input.mapping);
        if (!sameRequest) {
          await client.query("ROLLBACK");
          return { outcome: "conflict" };
        }
        const rows = await client.query<ImportRowRow>(
          `SELECT ${IMPORT_ROW_COLUMNS} FROM "${schema}".import_rows WHERE intake_id = $1 ORDER BY row_number`,
          [input.intakeId]
        );
        await client.query("COMMIT");
        const importRows = rows.rows.map(rowToImportRow);
        return { outcome: "replayed", summary: summarizeImportRows(importRows), rows: importRows };
      }

      const transitioned = await client.query(
        `UPDATE "${schema}".file_intakes SET status = 'imported' WHERE intake_id = $1 AND status = 'validated'`,
        [input.intakeId]
      );
      if ((transitioned.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        return { outcome: "not_validated" };
      }

      const importRows: ImportRow[] = [];
      for (const [index, csvRow] of input.rows.entries()) {
        const rowNumber = index + 1;
        const values = mapCsvRowToApplication(csvRow, input.mapping);
        const classification = classifyCsvImportRow(values);
        let applicationId: string | undefined;
        if (classification.outcome === "processed") {
          const inserted = await client.query<{ application_id: string }>(
            `INSERT INTO "${schema}".applications
               (organization_id, role_id, intake_id, source_row_number, candidate_full_name, candidate_email, external_reference_id, applied_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING application_id`,
            [
              input.organizationId,
              input.roleId,
              input.intakeId,
              rowNumber,
              values.candidateFullName,
              values.candidateEmail,
              values.externalReferenceId ?? null,
              // Normalized rather than passed through. classifyCsvImportRow
              // has already failed the row if this is not a date, so by here
              // it parses; storing the canonical instant keeps the column
              // from holding whatever format the spreadsheet happened to use.
              normalizedAppliedAt(values.appliedAt)
            ]
          );
          applicationId = inserted.rows[0]?.application_id;
          if (applicationId === undefined) {
            throw new Error("application insert returned no row");
          }
        }
        importRows.push(await insertImportRow(client, schema, input.intakeId, rowNumber, classification, applicationId));
      }

      await client.query(
        `INSERT INTO "${schema}".import_finalizations (intake_id, idempotency_key, mapping)
         VALUES ($1, $2, $3::jsonb)`,
        [input.intakeId, input.idempotencyKey, JSON.stringify(input.mapping)]
      );

      await client.query("COMMIT");
      return { outcome: "finalized", summary: summarizeImportRows(importRows), rows: importRows };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
  }
}

export async function getImportRowsForIntake(
  databaseUrl: string,
  schema: string,
  intakeId: string
): Promise<readonly ImportRow[]> {
  assertSafeSchema(schema);
  const client = await acquireConnection(databaseUrl);
  try {
    const result = await client.query<ImportRowRow>(
      `SELECT ${IMPORT_ROW_COLUMNS} FROM "${schema}".import_rows WHERE intake_id = $1 ORDER BY row_number`,
      [intakeId]
    );
    return result.rows.map(rowToImportRow);
  } finally {
    client.release();
  }
}

// ---- AF-22: exercise memberships RLS with a real non-superuser role ----

const MIGRATIONS_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "../migrations");

/**
 * Creates a throwaway schema, applies the real 0002_organizations_users_memberships.sql and 0004_tenant_scoped_rls.sql migrations, and
 * proves a non-superuser role cannot read or write another organization's
 * memberships, including when app.current_org_id is the empty string.
 */
export async function assertMembershipsTenantIsolation(databaseUrl: string): Promise<void> {
  const suffix = randomBytes(4).toString("hex");
  const schema = `rls_probe_${suffix}`;
  const role = `rls_app_${suffix}`;
  const orgA = "11111111-1111-4111-8111-111111111111";
  const orgB = "22222222-2222-4222-8222-222222222222";
  const userA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const userB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const admin = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });

  try {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    await admin.query(readFileSync(join(MIGRATIONS_DIRECTORY, "0002_organizations_users_memberships.sql"), "utf8"));
    await admin.query(readFileSync(join(MIGRATIONS_DIRECTORY, "0004_tenant_scoped_rls.sql"), "utf8"));
    await admin.query(`CREATE ROLE ${role} NOSUPERUSER NOBYPASSRLS`);
    // Being a member of the role is NOT enough to SET ROLE to it. Since
    // PostgreSQL 16 a membership grant carries separate INHERIT, SET and
    // ADMIN options, and the grant a CREATEROLE user receives implicitly
    // on a role it creates is ADMIN only: verified on 17.10, the
    // pg_auth_members row reads admin_option=true, inherit_option=false,
    // set_option=false, and `SET ROLE` fails with "permission denied to
    // set role". This probe therefore only ever worked because it was run
    // as a superuser, which bypasses the check -- the same "works because
    // the control is currently inert" shape AF-43 found in the RLS lookup.
    //
    // An explicit GRANT defaults to SET TRUE, so this makes the probe work
    // for any role with CREATEROLE and CREATE ON SCHEMA rather than
    // requiring superuser. Dropped with the role in the finally block.
    await admin.query(`GRANT ${role} TO CURRENT_USER`);
    await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO ${role}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO ${role}`);
    await admin.query(`INSERT INTO organizations (organization_id, name) VALUES ($1, 'Org A'), ($2, 'Org B')`, [
      orgA,
      orgB
    ]);
    await admin.query(
      `INSERT INTO users (user_id, email, display_name) VALUES ($1, 'a@acme.test', 'A'), ($2, 'b@acme.test', 'B')`,
      [userA, userB]
    );
    // Seeding memberships needs the same tenant scope the policy demands.
    // 0004_tenant_scoped_rls.sql uses FORCE ROW LEVEL SECURITY, so the table OWNER is subject to
    // the policy too -- only a superuser bypasses it. Inserting both rows
    // unscoped therefore fails with "new row violates row-level security
    // policy" for any non-superuser, which is the second reason this probe
    // silently required superuser. Each row is seeded inside its own
    // organization's scope, in a transaction so the setting is local and
    // cannot leak into the assertions below.
    for (const [organizationId, userId] of [
      [orgA, userA],
      [orgB, userB]
    ] as const) {
      await admin.query("BEGIN");
      try {
        await admin.query("SELECT set_config('app.current_org_id', $1, true)", [organizationId]);
        await admin.query(
          `INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'owner')`,
          [organizationId, userId]
        );
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }

    const asProbe = async (orgId: string | undefined, sql: string, params: unknown[] = []) => {
      await admin.query("BEGIN");
      try {
        await admin.query(`SET LOCAL ROLE ${role}`);
        if (orgId !== undefined) {
          await admin.query("SELECT set_config('app.current_org_id', $1, true)", [orgId]);
        }
        const result = await admin.query(sql, params);
        await admin.query("COMMIT");
        return result;
      } catch (error) {
        await admin.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    };

    const unset = await asProbe(undefined, "SELECT organization_id FROM memberships");
    if (unset.rows.length !== 0) {
      throw new Error("memberships RLS must hide every row when app.current_org_id is unset");
    }

    const empty = await asProbe("", "SELECT organization_id FROM memberships");
    if (empty.rows.length !== 0) {
      throw new Error("memberships RLS must hide every row when app.current_org_id is empty");
    }

    const inA = await asProbe(orgA, "SELECT organization_id FROM memberships");
    if (inA.rows.length !== 1 || inA.rows[0]?.organization_id !== orgA) {
      throw new Error("memberships RLS must show only the current organization's rows");
    }

    const inB = await asProbe(orgB, "SELECT organization_id FROM memberships");
    if (inB.rows.length !== 1 || inB.rows[0]?.organization_id !== orgB) {
      throw new Error("memberships RLS must not leak sibling-organization rows");
    }

    let crossTenantWriteRejected = false;
    try {
      await asProbe(orgA, "INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'recruiter')", [
        orgB,
        userA
      ]);
    } catch {
      crossTenantWriteRejected = true;
    }
    if (!crossTenantWriteRejected) {
      throw new Error("memberships RLS WITH CHECK must reject a cross-tenant insert");
    }
  } finally {
    // Separate attempts on purpose: roles are cluster-wide, not
    // schema-scoped, so a failing DROP SCHEMA must not skip DROP ROLE and
    // leave a login role behind on every run against a persistent cluster.
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } catch {
      // Best-effort cleanup; the next probe uses a unique suffix.
    }
    try {
      await admin.query(`DROP ROLE IF EXISTS ${role}`);
    } catch {
      // Best-effort cleanup; the next probe uses a unique suffix.
    }
    await admin.end().catch(() => undefined);
  }
}

/**
 * AF-43 review follow-up: proves the magic-link auth path behaves
 * correctly under a database role that RLS actually applies to -- not
 * only under the bootstrap superuser that bypasses it. Two independent
 * claims, both of which were broken before:
 *
 *  1. A plain login token's membership lookup is unavoidably
 *     cross-organization, so AF-18's per-org policy hides every row from
 *     it. It must fail with a message naming the real cause, never
 *     degrade into "this email has no membership" -- which would reject
 *     every legitimate sign-in while blaming the user's account.
 *  2. An invite redemption *is* possible, because an invite names its
 *     organization: scoping the transaction with app.current_org_id lets
 *     the membership write through the WITH CHECK, and a re-invite that
 *     names a different role actually applies it.
 *
 * Runs against a throwaway schema and a throwaway LOGIN role, both named
 * with a random suffix so concurrent runs cannot collide, and both
 * dropped in `finally`.
 */
export interface MembershipReadUnderRlsObservations {
  /** As the bootstrap superuser, which is what the app runs as today. */
  readonly asSuperuserMembershipCount: number;
  /** As a role RLS actually applies to, before this fix: zero rows, no error. */
  readonly asRestrictedRoleRowCount: number;
  /** After the fix: the failure mode is a thrown, actionable error. */
  readonly asRestrictedRoleThrew: boolean;
  readonly errorMentionsRowLevelSecurity: boolean;
  readonly errorMentionsRemedy: boolean;
}

/**
 * Review #83, REV-002. getMembershipsForUser makes the same
 * cross-organization lookup the login path does, and was the only one of the
 * two without the visibility guard.
 *
 * Why silence is the dangerous part: under a role RLS applies to, the query
 * returns zero rows rather than failing. Every authenticated caller then looks
 * like it holds no memberships, and all 16 API routes answer not_found, which
 * is indistinguishable from a genuine permission denial. The whole product
 * would appear to work and deny everyone, with nothing in the logs.
 *
 * Measured against a real NOSUPERUSER NOBYPASSRLS role, because that is the
 * only way to observe it: as the Postgres image's bootstrap superuser, RLS is
 * bypassed and the defect is invisible.
 */
export async function assertMembershipReadFailsLoudlyUnderRls(
  databaseUrl: string
): Promise<MembershipReadUnderRlsObservations> {
  const suffix = randomBytes(4).toString("hex");
  const schema = `mread_probe_${suffix}`;
  const role = `mread_app_${suffix}`;
  const password = randomBytes(16).toString("hex");
  const organizationId = "11111111-1111-4111-8111-111111111111";
  const email = `mread_${suffix}@acme.test`;

  const probeUrl = new URL(databaseUrl);
  probeUrl.username = role;
  probeUrl.password = password;
  const probeDatabaseUrl = probeUrl.toString();

  const admin = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    for (const migration of ["0002_organizations_users_memberships.sql", "0004_tenant_scoped_rls.sql"]) {
      await admin.query(readFileSync(join(MIGRATIONS_DIRECTORY, migration), "utf8"));
    }
    await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
    await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO ${role}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO ${role}`);
    await admin.query(`INSERT INTO organizations (organization_id, name) VALUES ($1, 'Org A')`, [organizationId]);
    const user = await admin.query<{ user_id: string }>(
      `INSERT INTO users (email, display_name) VALUES ($1, 'Member') RETURNING user_id`,
      [email]
    );
    const userId = user.rows[0]?.user_id;
    if (userId === undefined) {
      throw new Error("probe could not create a user");
    }
    await admin.query(`INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'recruiter')`, [
      organizationId,
      userId
    ]);

    // Control: as the superuser the membership is visible, so a later failure
    // is attributable to RLS rather than to the fixture being wrong.
    const asSuperuser = await getMembershipsForUser(databaseUrl, schema, userId);

    // What the raw query does under the restricted role, with no guard in the
    // way. This is the defect itself, measured rather than described.
    const restricted = new Client({ connectionString: probeDatabaseUrl, connectionTimeoutMillis: 5_000 });
    let rowCount = -1;
    try {
      await restricted.connect();
      const rows = await restricted.query(
        `SELECT membership_id FROM "${schema}".memberships WHERE user_id = $1`,
        [userId]
      );
      rowCount = rows.rowCount ?? -1;
    } finally {
      await restricted.end().catch(() => undefined);
    }

    // And what the guarded function now does with the same role.
    let threw = false;
    let message = "";
    try {
      await getMembershipsForUser(probeDatabaseUrl, schema, userId);
    } catch (error) {
      threw = true;
      message = error instanceof Error ? error.message : String(error);
    }

    return {
      asSuperuserMembershipCount: asSuperuser.length,
      asRestrictedRoleRowCount: rowCount,
      asRestrictedRoleThrew: threw,
      errorMentionsRowLevelSecurity: /row-level security/iu.test(message),
      errorMentionsRemedy: /BYPASSRLS|SECURITY DEFINER/u.test(message)
    };
  } finally {
    await closeDatabasePools().catch(() => undefined);
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await admin.query(`REASSIGN OWNED BY ${role} TO CURRENT_USER`).catch(() => undefined);
    await admin.query(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}

export async function assertMagicLinkRlsSafety(databaseUrl: string): Promise<void> {
  const suffix = randomBytes(4).toString("hex");
  const schema = `mlrls_probe_${suffix}`;
  const role = `mlrls_app_${suffix}`;
  const password = randomBytes(16).toString("hex");
  const organizationId = "11111111-1111-4111-8111-111111111111";
  const memberEmail = `member_${suffix}@acme.test`;
  const invitedEmail = `invited_${suffix}@acme.test`;

  const probeUrl = new URL(databaseUrl);
  probeUrl.username = role;
  probeUrl.password = password;
  const probeDatabaseUrl = probeUrl.toString();

  const admin = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });

  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

  try {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    await admin.query(readFileSync(join(MIGRATIONS_DIRECTORY, "0002_organizations_users_memberships.sql"), "utf8"));
    await admin.query(readFileSync(join(MIGRATIONS_DIRECTORY, "0003_magic_link_tokens.sql"), "utf8"));
    await admin.query(readFileSync(join(MIGRATIONS_DIRECTORY, "0004_tenant_scoped_rls.sql"), "utf8"));
    await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
    await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO ${role}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO ${role}`);
    await admin.query(`INSERT INTO organizations (organization_id, name) VALUES ($1, 'Org A')`, [organizationId]);
    await admin.query(
      `INSERT INTO users (email, display_name) VALUES ($1, 'Member') RETURNING user_id`,
      [memberEmail]
    );
    await admin.query(
      `INSERT INTO memberships (organization_id, user_id, role)
       SELECT $1, user_id, 'recruiter' FROM users WHERE email = $2`,
      [organizationId, memberEmail]
    );

    // Control: as the superuser, RLS is bypassed, so the existing login
    // path still works exactly as it does today. Without this, claim 1
    // below could pass for the wrong reason (a lookup that is simply
    // broken for everyone).
    await createMagicLinkToken(databaseUrl, schema, {
      tokenHash: `superuser-login-${suffix}`,
      email: memberEmail,
      expiresAt
    });

    // Claim 1: the same call under a role RLS applies to must name RLS
    // as the cause, not report the member as having no membership.
    let loginError: unknown;
    try {
      await createMagicLinkToken(probeDatabaseUrl, schema, {
        tokenHash: `rls-login-${suffix}`,
        email: memberEmail,
        expiresAt
      });
    } catch (error) {
      loginError = error;
    }
    const loginMessage = loginError instanceof Error ? loginError.message : String(loginError);
    if (loginError === undefined) {
      throw new Error("expected the login membership lookup to fail loudly under active row-level security");
    }
    if (!loginMessage.includes("row-level security is active")) {
      throw new Error(
        `login magic link under RLS must explain the real cause, got: ${loginMessage}`
      );
    }

    // Claim 2: an invite names its organization, so redemption works
    // under the same role -- and the named role is actually applied.
    await createMagicLinkToken(probeDatabaseUrl, schema, {
      tokenHash: `rls-invite-${suffix}`,
      email: invitedEmail,
      invite: { organizationId, role: "recruiter" },
      expiresAt
    });
    const firstRedemption = await redeemMagicLinkToken(probeDatabaseUrl, schema, `rls-invite-${suffix}`);
    if (!firstRedemption.justRedeemed) {
      throw new Error("invite redemption must succeed under active row-level security");
    }
    const afterInvite = await admin.query<{ role: string }>(
      `SELECT m.role FROM memberships m INNER JOIN users u ON u.user_id = m.user_id WHERE u.email = $1`,
      [invitedEmail]
    );
    if (afterInvite.rows[0]?.role !== "recruiter") {
      throw new Error(
        `invite redemption must provision the membership under RLS, got: ${JSON.stringify(afterInvite.rows)}`
      );
    }

    // A promotion re-invite: DO NOTHING would report success here while
    // silently leaving the old role in place.
    await createMagicLinkToken(probeDatabaseUrl, schema, {
      tokenHash: `rls-reinvite-${suffix}`,
      email: invitedEmail,
      invite: { organizationId, role: "admin" },
      expiresAt
    });
    await redeemMagicLinkToken(probeDatabaseUrl, schema, `rls-reinvite-${suffix}`);
    const afterPromotion = await admin.query<{ role: string }>(
      `SELECT m.role FROM memberships m INNER JOIN users u ON u.user_id = m.user_id WHERE u.email = $1`,
      [invitedEmail]
    );
    if (afterPromotion.rows[0]?.role !== "admin") {
      throw new Error(
        `a re-invite naming a new role must apply it, got: ${JSON.stringify(afterPromotion.rows)}`
      );
    }

    // A re-invite that would strand the organization with no owner is
    // refused, loudly, and leaves the existing membership untouched.
    await admin.query(`UPDATE memberships SET role = 'owner' WHERE organization_id = $1`, [organizationId]);
    await admin.query(
      `DELETE FROM memberships
        WHERE organization_id = $1
          AND user_id <> (SELECT user_id FROM users WHERE email = $2)`,
      [organizationId, invitedEmail]
    );
    await createMagicLinkToken(probeDatabaseUrl, schema, {
      tokenHash: `rls-demote-${suffix}`,
      email: invitedEmail,
      invite: { organizationId, role: "recruiter" },
      expiresAt
    });
    let demotionError: unknown;
    try {
      await redeemMagicLinkToken(probeDatabaseUrl, schema, `rls-demote-${suffix}`);
    } catch (error) {
      demotionError = error;
    }
    if (demotionError === undefined) {
      throw new Error("demoting the last owner of an organization must be refused, not applied silently");
    }
    const afterRefusal = await admin.query<{ role: string }>(
      `SELECT m.role FROM memberships m INNER JOIN users u ON u.user_id = m.user_id WHERE u.email = $1`,
      [invitedEmail]
    );
    if (afterRefusal.rows[0]?.role !== "owner") {
      throw new Error(
        `a refused demotion must roll back and leave the membership intact, got: ${JSON.stringify(afterRefusal.rows)}`
      );
    }

    // app.current_org_id must not survive the transaction that sets it.
    //
    // Scope of this check, stated exactly: it verifies the *mechanism*
    // provisionInvitedMembership relies on -- that is_local => true is
    // discarded at COMMIT and is_local => false is not -- on a connection
    // this probe holds open across that COMMIT. It does not observe
    // provisionInvitedMembership's own connection, because
    // redeemMagicLinkToken opens and ends that one itself, so nothing
    // outside can read its settings after the fact. Flipping is_local in
    // provisionInvitedMembership therefore does NOT fail this assertion;
    // that argument rests on reading the call, which is one line away.
    //
    // Worth being blunt about why that residual gap is acceptable today:
    // every entry point in this module constructs its own Client and
    // ends it in a finally, so there is no pool for a stale setting to
    // leak into. is_local => true is the right thing to write anyway --
    // it is correct the day a pool is introduced, and this check is what
    // proves that keyword still means what the comment claims.
    //
    // An earlier version of this assertion ran on `admin`, which never
    // called set_config at all. current_setting is per-connection, so it
    // passed no matter what, and measured nothing. The is_local => false
    // leg below is the control that keeps this one honest: if a
    // session-scoped setting did not survive COMMIT either, the
    // assertion above would again be measuring nothing.
    const scoped = new Client({ connectionString: probeDatabaseUrl, connectionTimeoutMillis: 5_000 });
    try {
      await scoped.connect();
      const readOrgSetting = async (): Promise<string> => {
        const row = await scoped.query<{ value: string }>(
          `SELECT coalesce(nullif(current_setting('app.current_org_id', true), ''), '') AS value`
        );
        return row.rows[0]?.value ?? "";
      };

      await scoped.query("BEGIN");
      await scoped.query(`SELECT set_config('app.current_org_id', $1, true)`, [organizationId]);
      if ((await readOrgSetting()) !== organizationId) {
        throw new Error("set_config must take effect inside its own transaction");
      }
      await scoped.query("COMMIT");
      const afterCommit = await readOrgSetting();
      if (afterCommit !== "") {
        throw new Error(
          `app.current_org_id must be transaction-local; it survived COMMIT on the same connection as ${afterCommit}`
        );
      }

      await scoped.query("BEGIN");
      await scoped.query(`SELECT set_config('app.current_org_id', $1, false)`, [organizationId]);
      await scoped.query("COMMIT");
      if ((await readOrgSetting()) !== organizationId) {
        throw new Error(
          "control failed: a session-scoped set_config should survive COMMIT, so the transaction-local assertion above proves nothing"
        );
      }
    } finally {
      await scoped.end().catch(() => undefined);
    }
  } finally {
    // Separate attempts on purpose: roles are cluster-wide, not
    // schema-scoped, so a failing DROP SCHEMA must not skip DROP ROLE and
    // leave a login role behind on every run against a persistent cluster.
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } catch {
      // Best-effort cleanup; the next probe uses a unique suffix.
    }
    try {
      await admin.query(`DROP ROLE IF EXISTS ${role}`);
    } catch {
      // Best-effort cleanup; the next probe uses a unique suffix.
    }
    await admin.end().catch(() => undefined);
  }
}

// ---- AF-40 review (#23): the organization reference must not cascade ----

/**
 * Proves that deleting an organization fails for the RIGHT reason.
 *
 * evidence_extraction_runs is append-only, so ON DELETE CASCADE on
 * organization_id could never work: the cascaded DELETE hits the
 * reject-mutation trigger and the error reads "evidence_extraction_runs is
 * append-only", naming the trigger instead of the organization reference
 * that actually blocks the delete. Operators debugging a failed offboarding
 * are then looking at the wrong constraint.
 *
 * 0006_audit_events_delete_and_membership_fixes.sql already fixed exactly
 * this on audit_events. Asserted here so the next append-only table that
 * copies this pattern is caught by a test rather than by a reviewer.
 */
export async function assertExtractionRunOrganizationDelete(
  databaseUrl: string
): Promise<{ readonly message: string }> {
  const suffix = randomBytes(4).toString("hex");
  const schema = `run_fk_probe_${suffix}`;
  const org = "11111111-1111-4111-8111-111111111111";
  const admin = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    for (const file of [
      "0002_organizations_users_memberships.sql",
      "0006_evidence_extraction_runs.sql"
    ]) {
      await admin.query(readFileSync(join(MIGRATIONS_DIRECTORY, file), "utf8"));
    }
    await admin.query(`INSERT INTO organizations (organization_id, name) VALUES ($1,'A')`, [org]);
    await admin.query(
      `INSERT INTO evidence_extraction_runs
         (organization_id, entity_type, entity_id, provider, model, prompt_version,
          extraction_schema_version, extraction_schema_name, rubric_version)
       VALUES ($1,'application','app-1','openai','gpt-5.6','v1','1.0.0','evidence','v1')`,
      [org]
    );
    try {
      await admin.query(`DELETE FROM organizations WHERE organization_id = $1`, [org]);
    } catch (error) {
      return { message: error instanceof Error ? error.message : String(error) };
    }
    throw new Error(
      "assertExtractionRunOrganizationDelete: deleting the organization SUCCEEDED, but an extraction run still references it"
    );
  } finally {
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } catch {
      // Best-effort cleanup; the next probe uses a unique suffix.
    }
    await admin.end().catch(() => undefined);
  }
}

// ---- AF-41 review (#24): budget totals must not lose precision ----

export interface InferenceBudgetPrecisionObservations {
  /** Reading a bigint past MAX_SAFE_INTEGER must throw, not round. */
  readonly oversizedReadRejection: string;
  /** The value Number() would have silently returned instead. */
  readonly silentlyRoundedValue: number;
  readonly storedValue: string;
  /** cap_exceeded reports the real committed total. */
  readonly capExceededTotalBefore: number;
}

export interface InferenceBudgetAtomicityObservations {
  /** How many of the concurrent reservations were granted. */
  readonly reserved: number;
  /** Committed total after the burst. Must never exceed the cap. */
  readonly totalAfter: number;
  readonly cap: number;
  /**
   * What the read-then-write pattern this replaced produces under the
   * same burst. Recorded rather than described so the test can show the
   * overspend instead of asserting the fix in the abstract.
   */
  readonly naiveTotalAfter: number;
}

/**
 * Drives genuinely concurrent reservations against one cap.
 *
 * The whole point of reserveInferenceBudget is that it holds under
 * concurrency, and that cannot be shown sequentially: a loop passes just
 * as happily against the broken read-then-write version. So this fires
 * the burst in parallel, each call on its own connection, exactly as
 * separate requests would arrive, and reports both what the atomic path
 * committed and what the naive path commits for comparison.
 */
export async function assertInferenceBudgetAtomicity(
  databaseUrl: string
): Promise<InferenceBudgetAtomicityObservations> {
  const suffix = randomBytes(4).toString("hex");
  const schema = `budget_race_${suffix}`;
  const org = "33333333-3333-4333-8333-333333333333";
  const cap = 1_000;
  const each = 100;
  const burst = 30;
  const admin = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    for (const file of [
      "0002_organizations_users_memberships.sql",
      "0007_inference_usage_ledger.sql"
    ]) {
      await admin.query(readFileSync(join(MIGRATIONS_DIRECTORY, file), "utf8"));
    }
    await admin.query(`INSERT INTO organizations (organization_id, name) VALUES ($1,'Race')`, [org]);

    const atomicBase = { organizationId: org, model: "atomic", periodStart: "2026-09-01" };
    const outcomes = await Promise.all(
      Array.from({ length: burst }, () =>
        reserveInferenceBudget(databaseUrl, schema, {
          ...atomicBase,
          inputTokens: each,
          outputTokens: 0,
          maxTotalTokens: cap
        })
      )
    );
    const after = await getInferenceUsage(databaseUrl, schema, atomicBase);

    // The same burst through read-check-write, on its own ledger row.
    const naiveBase = { organizationId: org, model: "naive", periodStart: "2026-09-01" };
    await Promise.all(
      Array.from({ length: burst }, async () => {
        const current = await getInferenceUsage(databaseUrl, schema, naiveBase);
        if (current.inputTokens + current.outputTokens + each <= cap) {
          await recordInferenceUsage(databaseUrl, schema, {
            ...naiveBase,
            inputTokens: each,
            outputTokens: 0
          });
        }
      })
    );
    const naiveAfter = await getInferenceUsage(databaseUrl, schema, naiveBase);

    return {
      reserved: outcomes.filter((outcome) => outcome.outcome === "reserved").length,
      totalAfter: after.inputTokens + after.outputTokens,
      cap,
      naiveTotalAfter: naiveAfter.inputTokens + naiveAfter.outputTokens
    };
  } finally {
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } catch {
      // Best-effort cleanup; the next probe uses a unique suffix.
    }
    await admin.end().catch(() => undefined);
  }
}

export interface InferenceReservationSettlementObservations {
  /** Ledger totals after an over-estimate is settled with the real numbers. */
  readonly overEstimate: { readonly inputTokens: number; readonly outputTokens: number };
  /** Ledger totals after an under-estimate is settled. */
  readonly underEstimate: { readonly inputTokens: number; readonly outputTokens: number };
  /** Retrying a committed settlement must not apply its delta a second time. */
  readonly duplicateSettlement: "already_settled";
  /** What the ledger would have said had usage been recorded on top of the reservation. */
  readonly doubleCountedTotal: number;
}

/**
 * Exercise reserve-then-settle against a real ledger, in a disposable schema.
 *
 * The bug this pins is not visible in one call. A reservation writes an
 * estimate into the same columns that afterwards hold provider-reported
 * usage, so it only goes wrong on the second write: reserve 100, consume 70,
 * and recording usage afterwards leaves 170 in a ledger the cap is read from.
 * `doubleCountedTotal` records that, so the test can show the failure being
 * prevented rather than describing it.
 */
export async function assertInferenceReservationSettlement(
  databaseUrl: string
): Promise<InferenceReservationSettlementObservations> {
  const suffix = randomBytes(4).toString("hex");
  const schema = `settle_probe_${suffix}`;
  const org = "11111111-1111-4111-8111-111111111111";
  const admin = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    for (const file of ["0002_organizations_users_memberships.sql", "0007_inference_usage_ledger.sql"]) {
      await admin.query(readFileSync(join(MIGRATIONS_DIRECTORY, file), "utf8"));
    }
    await admin.query(`INSERT INTO organizations (organization_id, name) VALUES ($1,'A')`, [org]);

    const period = "2026-09-01";
    const read = async (model: string): Promise<{ inputTokens: number; outputTokens: number }> =>
      getInferenceUsage(databaseUrl, schema, { organizationId: org, model, periodStart: period });

    // Over-estimate: reserve 60/40, actually spend 45/25.
    const overReservation = await reserveInferenceBudget(databaseUrl, schema, {
      organizationId: org, model: "over", periodStart: period,
      inputTokens: 60, outputTokens: 40, maxTotalTokens: 1000
    });
    if (overReservation.outcome !== "reserved") {
      throw new Error("assertInferenceReservationSettlement: expected the over-estimate reservation to fit");
    }
    await settleInferenceReservation(databaseUrl, schema, {
      reservationId: overReservation.reservationId,
      actualInputTokens: 45, actualOutputTokens: 25
    });
    const overEstimate = await read("over");
    const duplicateSettlement = await settleInferenceReservation(databaseUrl, schema, {
      reservationId: overReservation.reservationId,
      actualInputTokens: 45, actualOutputTokens: 25
    });
    if (duplicateSettlement.outcome !== "already_settled") {
      throw new Error("assertInferenceReservationSettlement: a duplicate settlement adjusted the ledger again");
    }

    // What the old shape produced: the estimate, plus the real usage again.
    // Deliberately never settled, so this model's row keeps the double count
    // the settlement path exists to prevent.
    const doubleCountReservation = await reserveInferenceBudget(databaseUrl, schema, {
      organizationId: org, model: "double", periodStart: period,
      inputTokens: 60, outputTokens: 40, maxTotalTokens: 1000
    });
    if (doubleCountReservation.outcome !== "reserved") {
      throw new Error("assertInferenceReservationSettlement: expected the double-count reservation to fit");
    }
    await recordInferenceUsage(databaseUrl, schema, {
      organizationId: org, model: "double", periodStart: period,
      inputTokens: 45, outputTokens: 25
    });
    const doubled = await read("double");

    // Under-estimate: reserve 10/10, actually spend 30/15. Its own handle: an
    // earlier revision discarded this result and settled the "double"
    // reservation above instead, which left the "under" row holding its raw
    // estimate and quietly settled the row that is supposed to stay unsettled.
    const underReservation = await reserveInferenceBudget(databaseUrl, schema, {
      organizationId: org, model: "under", periodStart: period,
      inputTokens: 10, outputTokens: 10, maxTotalTokens: 1000
    });
    if (underReservation.outcome !== "reserved") {
      throw new Error("assertInferenceReservationSettlement: expected the under-estimate reservation to fit");
    }
    await settleInferenceReservation(databaseUrl, schema, {
      reservationId: underReservation.reservationId,
      actualInputTokens: 30, actualOutputTokens: 15
    });
    const underEstimate = await read("under");

    return {
      overEstimate,
      underEstimate,
      duplicateSettlement: duplicateSettlement.outcome,
      doubleCountedTotal: doubled.inputTokens + doubled.outputTokens
    };
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}

export interface KillSwitchTransitionObservations {
  /** Whether engaging with no reason at all is refused by the table itself. */
  readonly nullReasonRejected: boolean;
  /** What the pre-review constraint did with the same row. */
  readonly nullReasonAcceptedByOldConstraint: boolean;
  /** Reasons in the append-only log, oldest first. */
  readonly loggedReasons: readonly (string | null)[];
  /** The reason left on the singleton after a later transition overwrote it. */
  readonly singletonReasonAfterDisengage: string | null;
}

/**
 * Exercise the kill-switch constraint and its transition log on a real
 * Postgres, in a disposable schema.
 *
 * Both halves of this need a live server to mean anything. `reason ~ '...'`
 * against a NULL reason evaluates to NULL rather than false, and Postgres
 * accepts a CHECK that is true OR NULL, so the hole only exists in the
 * database's three-valued logic and cannot be reproduced in TypeScript. The
 * old constraint is rebuilt here and shown accepting the row it should have
 * refused, so the test can prove the fix rather than assert it.
 */
export async function assertKillSwitchTransitionLog(
  databaseUrl: string
): Promise<KillSwitchTransitionObservations> {
  const suffix = randomBytes(4).toString("hex");
  const schema = `kill_switch_probe_${suffix}`;
  const org = "11111111-1111-4111-8111-111111111111";
  const actor = "22222222-2222-4222-8222-222222222222";
  const admin = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    for (const file of [
      "0002_organizations_users_memberships.sql",
      "0005_immutable_audit_events.sql",
      "0008_inference_kill_switch.sql",
      "0009_inference_kill_switch_nonblank_reason.sql",
      "0010_kill_switch_reason_non_whitespace.sql"
    ]) {
      await admin.query(readFileSync(join(MIGRATIONS_DIRECTORY, file), "utf8"));
    }
    await admin.query(`INSERT INTO organizations (organization_id, name) VALUES ($1,'A')`, [org]);
    await admin.query(`INSERT INTO users (user_id, email, display_name) VALUES ($1,'a@example.com','Probe Actor')`, [actor]);

    const engageWithNullReason = async (): Promise<boolean> => {
      try {
        await admin.query(
          `UPDATE inference_kill_switch
              SET engaged = true, reason = NULL, engaged_by_user_id = $1 WHERE id = true`,
          [actor]
        );
        return true;
      } catch {
        return false;
      }
    };

    const acceptedNow = await engageWithNullReason();
    await admin.query(`UPDATE inference_kill_switch SET engaged = false, reason = NULL, engaged_by_user_id = NULL WHERE id = true`);

    // Rebuild the pre-review constraint and show it accepting the same row.
    await admin.query(`ALTER TABLE inference_kill_switch DROP CONSTRAINT inference_kill_switch_check`);
    await admin.query(
      `ALTER TABLE inference_kill_switch ADD CONSTRAINT inference_kill_switch_check
       CHECK ((engaged AND reason ~ '[^[:space:]]' AND engaged_by_user_id IS NOT NULL) OR NOT engaged)`
    );
    const acceptedBefore = await engageWithNullReason();
    await admin.query(`UPDATE inference_kill_switch SET engaged = false, reason = NULL, engaged_by_user_id = NULL WHERE id = true`);

    // The log keeps each transition's reason where the next cannot reach it.
    await admin.query(
      `INSERT INTO inference_kill_switch_transitions (engaged, reason, actor_user_id, request_id)
       VALUES (true, 'runaway extraction loop', $1, 'req_00000000-0000-4000-8000-000000000001')`,
      [actor]
    );
    await admin.query(
      `INSERT INTO inference_kill_switch_transitions (engaged, reason, actor_user_id, request_id)
       VALUES (false, NULL, $1, 'req_00000000-0000-4000-8000-000000000002')`,
      [actor]
    );
    await admin.query(
      `UPDATE inference_kill_switch SET engaged = false, reason = NULL, engaged_by_user_id = NULL WHERE id = true`
    );

    const logged = await admin.query<{ reason: string | null }>(
      `SELECT reason FROM inference_kill_switch_transitions ORDER BY occurred_at`
    );
    const singleton = await admin.query<{ reason: string | null }>(
      `SELECT reason FROM inference_kill_switch WHERE id = true`
    );

    return {
      nullReasonRejected: !acceptedNow,
      nullReasonAcceptedByOldConstraint: acceptedBefore,
      loggedReasons: logged.rows.map((r) => r.reason),
      singletonReasonAfterDisengage: singleton.rows[0]?.reason ?? null
    };
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}

export async function assertInferenceBudgetPrecision(
  databaseUrl: string
): Promise<InferenceBudgetPrecisionObservations> {
  const suffix = randomBytes(4).toString("hex");
  const schema = `budget_probe_${suffix}`;
  const org = "11111111-1111-4111-8111-111111111111";
  const oversized = "9007199254740993"; // MAX_SAFE_INTEGER + 2
  const admin = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    for (const file of [
      "0002_organizations_users_memberships.sql",
      "0007_inference_usage_ledger.sql"
    ]) {
      await admin.query(readFileSync(join(MIGRATIONS_DIRECTORY, file), "utf8"));
    }
    await admin.query(`INSERT INTO organizations (organization_id, name) VALUES ($1,'A')`, [org]);
    await admin.query(
      `INSERT INTO inference_usage_ledger (organization_id, model, period_start, input_tokens, output_tokens)
       VALUES ($1,'gpt-5.6','2026-09-01',$2::bigint,0)`,
      [org, oversized]
    );

    let oversizedReadRejection = "";
    try {
      await getInferenceUsage(databaseUrl, schema, {
        organizationId: org,
        model: "gpt-5.6",
        periodStart: "2026-09-01"
      });
      throw new Error("assertInferenceBudgetPrecision: an oversized bigint was read without complaint");
    } catch (error) {
      oversizedReadRejection = error instanceof Error ? error.message : String(error);
    }

    // A second tenant with an ordinary total, to read back the cap_exceeded path.
    await admin.query(
      `UPDATE inference_usage_ledger SET input_tokens = 900, output_tokens = 100 WHERE organization_id = $1`,
      [org]
    );
    const capped = await reserveInferenceBudget(databaseUrl, schema, {
      organizationId: org,
      model: "gpt-5.6",
      periodStart: "2026-09-01",
      inputTokens: 500,
      outputTokens: 0,
      maxTotalTokens: 1_200
    });

    return {
      oversizedReadRejection,
      silentlyRoundedValue: Number(oversized),
      storedValue: oversized,
      capExceededTotalBefore: capped.outcome === "cap_exceeded" ? capped.totalTokensBefore : -1
    };
  } finally {
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } catch {
      // Best-effort cleanup; the next probe uses a unique suffix.
    }
    await admin.end().catch(() => undefined);
  }
}

// ---- AF-25: rubric draft persistence and versioning ----

export interface RubricPersistenceObservations {
  readonly firstSaveVersion: number;
  readonly editedSaveVersion: number;
  readonly editedCriterionIds: readonly string[];
  readonly draftRowsAfterEdit: number;
  readonly versionAfterPublished: number;
  readonly readBackIsDraft: boolean;
  readonly unknownRoleOutcome: string;
}

/**
 * Exercises upsertDraftRubric/getRubricForRole against real Postgres in a
 * throwaway schema, so the documented versioning rule is proven rather
 * than assumed. The rule (see upsertDraftRubric's own comment) is: edit
 * the existing draft IN PLACE, keeping its version, and only allocate
 * MAX(version) + 1 when inserting where no draft exists.
 *
 * Lives here rather than in the test because the pg Client is this
 * package's dependency and the migrations it applies are its own files;
 * this mirrors assertMembershipsTenantIsolation above.
 */
export interface PublishedRubricImmutabilityObservations {
  /** The draft -> published transition itself must be allowed. */
  readonly publishSucceeded: boolean;
  /** A second publish of the same row must not find a draft to publish. */
  readonly republishOutcome: string;
  /** Raised by 0012_immutable_published_rubrics.sql's trigger on UPDATE of a published row. */
  readonly updateRejection: string;
  /** And on DELETE, which a BEFORE UPDATE-only trigger would have missed. */
  readonly deleteRejection: string;
  /** A draft belonging to a later version stays mutable. */
  readonly draftStillMutable: boolean;
}

/**
 * AF-27 shipped the published-rubric immutability trigger with no test at
 * all, which is the failure mode the stacked-PR chain kept producing: a
 * feature-to-feature PR never ran CI, so an integrity control could ship
 * unexercised. Immutability is a claim about what the database refuses, so
 * it has to be proven against a real database rather than inferred from the
 * DDL.
 *
 * Both UPDATE and DELETE are checked deliberately. The trigger is declared
 * `BEFORE UPDATE OR DELETE`, and a version covering only UPDATE would still
 * pass a test that checked one of them.
 */
export async function assertPublishedRubricImmutability(
  databaseUrl: string
): Promise<PublishedRubricImmutabilityObservations> {
  const suffix = randomBytes(4).toString("hex");
  const schema = `publish_probe_${suffix}`;
  const organizationId = "11111111-1111-4111-8111-111111111111";
  const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const admin = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  const criterion = (id: string): RubricCriterion => ({
    criterionId: id,
    description: `description for ${id}`,
    evidenceGuidance: `guidance for ${id}`
  });
  const five = ["a", "b", "c", "d", "e"].map(criterion);

  const rejectionOf = async (sql: string, params: readonly unknown[]): Promise<string> => {
    try {
      await admin.query(sql, [...params]);
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  try {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    for (const file of [
      "0002_organizations_users_memberships.sql",
      "0009_roles.sql",
      "0011_rubrics.sql",
      "0012_immutable_published_rubrics.sql"
    ]) {
      await admin.query(`SET search_path TO "${schema}"`);
      await admin.query(readFileSync(join(MIGRATIONS_DIRECTORY, file), "utf8"));
    }
    await admin.query(
      `INSERT INTO "${schema}".organizations (organization_id, name) VALUES ($1, 'Publish Probe Org')`,
      [organizationId]
    );
    await admin.query(
      `INSERT INTO "${schema}".users (user_id, email, display_name) VALUES ($1, 'probe@acme.test', 'Probe')`,
      [userId]
    );
    const role = await createRole(databaseUrl, schema, {
      organizationId,
      title: "Backend Engineer",
      createdByUserId: userId
    });

    const draft = await upsertDraftRubric(databaseUrl, schema, role.roleId, five);
    if (draft.outcome !== "saved") {
      throw new Error("assertPublishedRubricImmutability: expected the draft to save");
    }
    const published = await publishRubric(databaseUrl, schema, draft.rubric.rubricId, userId);
    const publishSucceeded = published.outcome === "published";

    // The row is now published. Everything below must be refused by the
    // database, not merely by application code.
    const republish = await publishRubric(databaseUrl, schema, draft.rubric.rubricId, userId);
    const updateRejection = await rejectionOf(
      `UPDATE "${schema}".rubrics SET criteria = '[]'::jsonb WHERE rubric_id = $1`,
      [draft.rubric.rubricId]
    );
    const deleteRejection = await rejectionOf(`DELETE FROM "${schema}".rubrics WHERE rubric_id = $1`, [
      draft.rubric.rubricId
    ]);

    // Publishing must not freeze the table: a fresh draft is still editable.
    const nextDraft = await upsertDraftRubric(databaseUrl, schema, role.roleId, five);
    const draftStillMutable =
      nextDraft.outcome === "saved" &&
      (await upsertDraftRubric(databaseUrl, schema, role.roleId, five)).outcome === "saved";

    return {
      publishSucceeded,
      republishOutcome: republish.outcome,
      updateRejection,
      deleteRejection,
      draftStillMutable
    };
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}

export async function assertRubricDraftPersistence(
  databaseUrl: string
): Promise<RubricPersistenceObservations> {
  const suffix = randomBytes(4).toString("hex");
  const schema = `rubric_probe_${suffix}`;
  const organizationId = "11111111-1111-4111-8111-111111111111";
  const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const admin = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  const criterion = (id: string): RubricCriterion => ({
    criterionId: id,
    description: `description for ${id}`,
    evidenceGuidance: `guidance for ${id}`
  });
  const five = ["a", "b", "c", "d", "e"].map(criterion);
  const editedFive = ["a", "b", "c", "d", "z"].map(criterion);

  try {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    for (const file of ["0002_organizations_users_memberships.sql", "0009_roles.sql", "0011_rubrics.sql"]) {
      await admin.query(`SET search_path TO "${schema}"`);
      await admin.query(readFileSync(join(MIGRATIONS_DIRECTORY, file), "utf8"));
    }
    await admin.query(`INSERT INTO "${schema}".organizations (organization_id, name) VALUES ($1, 'Rubric Probe Org')`, [
      organizationId
    ]);
    await admin.query(
      `INSERT INTO "${schema}".users (user_id, email, display_name) VALUES ($1, 'probe@acme.test', 'Probe')`,
      [userId]
    );
    const role = await createRole(databaseUrl, schema, {
      organizationId,
      title: "Backend Engineer",
      createdByUserId: userId
    });

    const first = await upsertDraftRubric(databaseUrl, schema, role.roleId, five);
    if (first.outcome !== "saved") {
      throw new Error("assertRubricDraftPersistence: expected the first draft to save");
    }
    if (first.rubric.status !== "draft") {
      throw new Error(`assertRubricDraftPersistence: first save should be a draft, got ${first.rubric.status}`);
    }
    if (first.rubric.criteria.map((entry) => entry.criterionId).join(",") !== "a,b,c,d,e") {
      throw new Error("assertRubricDraftPersistence: criteria did not round-trip through jsonb in order");
    }

    // Editing replaces the whole list and must NOT allocate a new version:
    // a draft is edited in place, which is what makes "the draft" a single
    // unambiguous row for AF-26's editor to point at.
    const edited = await upsertDraftRubric(databaseUrl, schema, role.roleId, editedFive);
    if (edited.outcome !== "saved") {
      throw new Error("assertRubricDraftPersistence: expected the edit to save");
    }
    const draftRows = await admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "${schema}".rubrics WHERE role_id = $1 AND status = 'draft'`,
      [role.roleId]
    );

    // Publishing is AF-27's transition, inserted directly here only so the
    // next draft has a higher version to allocate past.
    await admin.query(
      `UPDATE "${schema}".rubrics
          SET status = 'published', approved_by_user_id = $2, approved_at = CURRENT_TIMESTAMP
        WHERE role_id = $1 AND status = 'draft'`,
      [role.roleId, userId]
    );
    const afterPublished = await upsertDraftRubric(databaseUrl, schema, role.roleId, five);
    if (afterPublished.outcome !== "saved") {
      throw new Error("assertRubricDraftPersistence: expected a new draft after publishing");
    }

    // getRubricForRole prefers the draft over the higher-versioned published
    // row, which is the ordering its own doc comment promises.
    const readBack = await getRubricForRole(databaseUrl, schema, role.roleId);
    if (readBack === undefined) {
      throw new Error("assertRubricDraftPersistence: expected to read a rubric back");
    }

    const unknownRole = await upsertDraftRubric(
      databaseUrl,
      schema,
      "99999999-9999-4999-8999-999999999999",
      five
    );

    return {
      firstSaveVersion: first.rubric.version,
      editedSaveVersion: edited.rubric.version,
      editedCriterionIds: edited.rubric.criteria.map((entry) => entry.criterionId),
      draftRowsAfterEdit: Number(draftRows.rows[0]?.count ?? "-1"),
      versionAfterPublished: afterPublished.rubric.version,
      readBackIsDraft: readBack.status === "draft",
      unknownRoleOutcome: unknownRole.outcome
    };
  } finally {
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } catch {
      // Best-effort cleanup; the next probe uses a unique suffix.
    }
    await admin.end().catch(() => undefined);
  }
}

export async function assertFileIntakeTenantIntegrity(databaseUrl: string): Promise<void> {
  const suffix = randomBytes(4).toString("hex");
  const schema = `fi_probe_${suffix}`;
  const orgA = "11111111-1111-4111-8111-111111111111";
  const orgB = "22222222-2222-4222-8222-222222222222";
  const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const roleA = "33333333-3333-4333-8333-333333333333";
  const admin = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });

  try {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    for (const file of [
      "0002_organizations_users_memberships.sql",
      "0009_roles.sql",
      "0013_file_intakes.sql"
    ]) {
      await admin.query(readFileSync(join(MIGRATIONS_DIRECTORY, file), "utf8"));
    }
    await admin.query(`INSERT INTO organizations (organization_id, name) VALUES ($1,'A'), ($2,'B')`, [orgA, orgB]);
    await admin.query(`INSERT INTO users (user_id, email, display_name) VALUES ($1,$2,'U')`, [
      userId,
      `fi_${suffix}@acme.test`
    ]);
    await admin.query(
      `INSERT INTO roles (role_id, organization_id, title, created_by_user_id) VALUES ($1,$2,'A role',$3)`,
      [roleA, orgA, userId]
    );

    const insert = async (organizationId: string, key: string): Promise<void> => {
      await admin.query(
        `INSERT INTO file_intakes
           (organization_id, role_id, storage_key, declared_filename, declared_mime_type, status, created_by_user_id)
         VALUES ($1,$2,$3,'cv.pdf','application/pdf','validated',$4)`,
        [organizationId, roleA, key, userId]
      );
    };

    // The legitimate pairing must still work -- a constraint that rejects
    // everything would pass the negative case for the wrong reason.
    await insert(orgA, `ok-${suffix}`);

    let rejected = false;
    let message = "";
    try {
      await insert(orgB, `bad-${suffix}`);
    } catch (error) {
      rejected = true;
      message = error instanceof Error ? error.message : String(error);
    }
    if (!rejected) {
      throw new Error(
        "a file intake in organization B must not be able to reference organization A's role; " +
          "the (role_id, organization_id) pair is unconstrained"
      );
    }
    if (!/foreign key|violates/i.test(message)) {
      throw new Error(`expected a foreign-key violation naming the real obstacle, got: ${message}`);
    }
  } finally {
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } catch {
      // Best-effort cleanup; the next probe uses a unique suffix.
    }
    await admin.end().catch(() => undefined);
  }
}

interface ApplicationRow {
  readonly application_id: string;
  readonly organization_id: string;
  readonly role_id: string;
  readonly intake_id: string;
  readonly source_row_number: number;
  readonly candidate_full_name: string;
  readonly candidate_email: string;
  readonly external_reference_id: string | null;
  readonly applied_at: Date | null;
  readonly created_at: Date;
}

function rowToApplication(row: ApplicationRow): Application {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    applicationId: row.application_id,
    organizationId: row.organization_id,
    roleId: row.role_id,
    intakeId: row.intake_id,
    sourceRowNumber: row.source_row_number,
    candidateFullName: row.candidate_full_name,
    candidateEmail: row.candidate_email,
    ...(row.external_reference_id === null ? {} : { externalReferenceId: row.external_reference_id }),
    ...(row.applied_at === null ? {} : { appliedAt: row.applied_at.toISOString() }),
    createdAt: row.created_at.toISOString()
  };
}

/**
 * Scoped by BOTH role_id and organization_id, deliberately.
 *
 * role_id alone would be sufficient today, since a role belongs to
 * exactly one organization and the route resolves the role before
 * authorizing against its organization. But that makes tenant isolation
 * depend on a caller getting a two-step lookup right every time, which
 * is precisely the shape of an IDOR: pass a sibling tenant's roleId and
 * the query itself has nothing to object to. Requiring the caller to
 * state which organization it believes it is acting for means a
 * mismatch returns zero rows instead of another tenant's candidates.
 * The organization_id column is already on the table (AF-32), so this
 * costs nothing.
 */
export async function listApplicationsForRole(
  databaseUrl: string,
  schema: string,
  organizationId: string,
  roleId: string
): Promise<readonly Application[]> {
  assertSafeSchema(schema);
  const client = await acquireConnection(databaseUrl);
  try {
    const result = await client.query<ApplicationRow>(
      `SELECT application_id, organization_id, role_id, intake_id, source_row_number,
              candidate_full_name, candidate_email, external_reference_id, applied_at, created_at
         FROM "${schema}".applications
        WHERE organization_id = $1 AND role_id = $2
        ORDER BY created_at, intake_id, source_row_number, application_id`,
      [organizationId, roleId]
    );
    return result.rows.map(rowToApplication);
  } finally {
    client.release();
  }
}

/**
 * One query for the whole page of applications rather than one per
 * application: a role with a thousand imported candidates would
 * otherwise open a thousand connections to render a single screen.
 *
 * Returns only the fields the queue reads. entity_id is text (AF-40's
 * table is generic over entity types), so the uuid list is cast rather
 * than compared across types -- comparing text to uuid would error, and
 * casting the *column* instead would discard the index.
 */
export async function listEvidenceExtractionRunsForEntities(
  databaseUrl: string,
  schema: string,
  organizationId: string,
  entityType: string,
  entityIds: readonly string[]
): Promise<readonly EvidenceExtractionRunRef[]> {
  assertSafeSchema(schema);
  if (entityIds.length === 0) {
    return [];
  }
  const client = await acquireConnection(databaseUrl);
  try {
    const result = await client.query<{ entity_type: string; entity_id: string; created_at: Date }>(
      `SELECT entity_type, entity_id, created_at
         FROM "${schema}".evidence_extraction_runs
        WHERE organization_id = $1 AND entity_type = $2 AND entity_id = ANY($3::text[])`,
      [organizationId, entityType, [...entityIds]]
    );
    return result.rows.map((row) => ({
      entityType: row.entity_type,
      entityId: row.entity_id,
      createdAt: row.created_at.toISOString()
    }));
  } finally {
    client.release();
  }
}

/**
 * AF-45: proves the review queue is genuinely tenant-scoped against a
 * real database, not just in the shape of its TypeScript.
 *
 * The claim that matters is the IDOR one. `listApplicationsForRole`
 * takes both organizationId and roleId even though roleId alone
 * identifies a role, and this is what makes that redundancy pay: it
 * asserts that org A's identifier paired with org B's roleId returns
 * nothing. Without the organization_id predicate that pairing would
 * return B's candidates in full, and the only thing standing between a
 * caller and another tenant's applicants would be the route remembering
 * to resolve the role first -- an invariant no test can see.
 */
export async function assertApplicationQueueTenantIsolation(databaseUrl: string): Promise<void> {
  const suffix = randomBytes(4).toString("hex");
  const schema = `appq_probe_${suffix}`;
  const orgA = "11111111-1111-4111-8111-111111111111";
  const orgB = "22222222-2222-4222-8222-222222222222";
  const admin = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });

  try {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    for (const migration of [
      "0002_organizations_users_memberships.sql",
      "0006_evidence_extraction_runs.sql",
      "0009_roles.sql",
      "0013_file_intakes.sql",
      "0016_applications_and_import_finalization.sql"
    ]) {
      await admin.query(readFileSync(join(MIGRATIONS_DIRECTORY, migration), "utf8"));
    }

    await admin.query(`INSERT INTO organizations (organization_id, name) VALUES ($1, 'Org A'), ($2, 'Org B')`, [
      orgA,
      orgB
    ]);
    const user = await admin.query<{ user_id: string }>(
      `INSERT INTO users (email, display_name) VALUES ($1, 'Probe') RETURNING user_id`,
      [`appq_${suffix}@acme.test`]
    );
    const userId = user.rows[0]?.user_id;
    if (userId === undefined) {
      throw new Error("probe could not create a user");
    }

    const roleIds: Record<string, string> = {};
    const intakeIds: Record<string, string> = {};
    for (const [label, organizationId] of [
      ["a", orgA],
      ["b", orgB]
    ] as const) {
      const role = await admin.query<{ role_id: string }>(
        `INSERT INTO roles (organization_id, title, created_by_user_id) VALUES ($1, $2, $3) RETURNING role_id`,
        [organizationId, `Role ${label}`, userId]
      );
      const roleId = role.rows[0]?.role_id;
      if (roleId === undefined) {
        throw new Error("probe could not create a role");
      }
      roleIds[label] = roleId;
      const intake = await admin.query<{ intake_id: string }>(
        `INSERT INTO file_intakes (organization_id, role_id, storage_key, declared_filename, declared_mime_type, created_by_user_id)
         VALUES ($1, $2, $3, 'applicants.csv', 'text/csv', $4) RETURNING intake_id`,
        [organizationId, roleId, `probe/${suffix}/${label}.csv`, userId]
      );
      const intakeId = intake.rows[0]?.intake_id;
      if (intakeId === undefined) {
        throw new Error("probe could not create a file intake");
      }
      intakeIds[label] = intakeId;
      await admin.query(
        `INSERT INTO applications
           (organization_id, role_id, intake_id, source_row_number, candidate_full_name, candidate_email)
         VALUES ($1, $2, $3, 1, $4, $5), ($1, $2, $3, 2, $6, $7)`,
        [
          organizationId,
          roleId,
          intakeId,
          `${label.toUpperCase()} First`,
          `${label}-first@acme.test`,
          `${label.toUpperCase()} Second`,
          `${label}-second@acme.test`
        ]
      );
    }

    const roleIdA = roleIds["a"];
    const roleIdB = roleIds["b"];
    if (roleIdA === undefined || roleIdB === undefined) {
      throw new Error("probe did not create both roles");
    }

    const ownTenant = await listApplicationsForRole(databaseUrl, schema, orgA, roleIdA);
    if (ownTenant.length !== 2) {
      throw new Error(`a role's own organization must see its applications, got ${ownTenant.length}`);
    }
    if (ownTenant.some((application) => application.organizationId !== orgA)) {
      throw new Error("listApplicationsForRole returned a row belonging to another organization");
    }

    // The IDOR probe: a real roleId from a sibling tenant, paired with
    // the caller's own organizationId.
    const crossTenant = await listApplicationsForRole(databaseUrl, schema, orgA, roleIdB);
    if (crossTenant.length !== 0) {
      throw new Error(
        `org A paired with org B's roleId must return nothing, got ${crossTenant.length} of B's applications`
      );
    }
    // And the mirror: B's organization with A's role.
    const mirrored = await listApplicationsForRole(databaseUrl, schema, orgB, roleIdA);
    if (mirrored.length !== 0) {
      throw new Error(`org B paired with org A's roleId must return nothing, got ${mirrored.length}`);
    }

    // Ordering is asserted from SQL too, not only in the pure builder:
    // the ORDER BY and buildApplicationReviewQueue's sort have to agree,
    // or the queue silently reshuffles when the database changes plan.
    const rowNumbers = ownTenant.map((application) => application.sourceRowNumber);
    if (rowNumbers.join(",") !== "1,2") {
      throw new Error(`applications must come back in import order, got ${rowNumbers.join(",")}`);
    }

    const applicationIdA = ownTenant[0]?.applicationId;
    if (applicationIdA === undefined) {
      throw new Error("probe expected at least one application for org A");
    }
    await admin.query(
      `INSERT INTO evidence_extraction_runs
         (organization_id, entity_type, entity_id, provider, model, prompt_version,
          extraction_schema_version, extraction_schema_name, rubric_version)
       VALUES ($1, 'application', $2, 'openai', 'test-model', '1.0.0', '1.0.0', 'evidence_response', '1')`,
      [orgA, applicationIdA]
    );
    // Same entity id, another organization: an extraction run must not
    // cross tenants any more than an application does.
    await admin.query(
      `INSERT INTO evidence_extraction_runs
         (organization_id, entity_type, entity_id, provider, model, prompt_version,
          extraction_schema_version, extraction_schema_name, rubric_version)
       VALUES ($1, 'application', $2, 'openai', 'test-model', '1.0.0', '1.0.0', 'evidence_response', '1')`,
      [orgB, applicationIdA]
    );

    const runs = await listEvidenceExtractionRunsForEntities(databaseUrl, schema, orgA, "application", [
      applicationIdA
    ]);
    if (runs.length !== 1) {
      throw new Error(`extraction runs must be organization-scoped, got ${runs.length} for one org's application`);
    }

    const otherType = await listEvidenceExtractionRunsForEntities(databaseUrl, schema, orgA, "file_intake", [
      applicationIdA
    ]);
    if (otherType.length !== 0) {
      throw new Error("extraction runs must be filtered by entity type in SQL, not only in the builder");
    }

    // The empty-list short circuit, tested for what it actually buys.
    // Asserting "[] in, [] out" against a working database proves
    // nothing -- `entity_id = ANY('{}')` matches nothing either way, so
    // that assertion passes with the short circuit deleted. What the
    // guard really prevents is opening a connection to render a role
    // that has no applications at all, so this points it at a host that
    // cannot resolve: it returns [] if the guard is there and throws if
    // it is not.
    const unreachable = "postgresql://probe@af45-must-not-connect.invalid:5432/none";
    const noIds = await listEvidenceExtractionRunsForEntities(unreachable, schema, orgA, "application", []);
    if (noIds.length !== 0) {
      throw new Error("an empty entity list must return nothing");
    }
  } finally {
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } catch {
      // Best-effort cleanup; the next probe uses a unique suffix.
    }
    await admin.end().catch(() => undefined);
  }
}

/**
 * AF-46: proves the SQL ordering and compareApplicationsBySourceOrder
 * agree, against the one fixture where a weaker ORDER BY silently
 * differs.
 *
 * AF-32's finalize inserts every application for one CSV in a single
 * transaction, and `DEFAULT CURRENT_TIMESTAMP` is transaction-start
 * time, so every row of an import shares one created_at. This probe
 * writes two imports with a *deliberately identical* created_at, which
 * is what makes the tiebreak observable: without intake_id ahead of
 * source_row_number the two imports interleave as A1, B1, A2, B2, and
 * with a random application_id tiebreak the interleaving is not even
 * stable between runs. Both are the "queue order is not the original
 * order" failure this ticket exists to prevent.
 */
export async function assertApplicantOrderingPreserved(databaseUrl: string): Promise<void> {
  const suffix = randomBytes(4).toString("hex");
  const schema = `apporder_probe_${suffix}`;
  const organizationId = "11111111-1111-4111-8111-111111111111";
  const sharedCreatedAt = "2026-08-29T12:00:00.000Z";
  const admin = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });

  try {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    for (const migration of [
      "0002_organizations_users_memberships.sql",
      "0006_evidence_extraction_runs.sql",
      "0009_roles.sql",
      "0013_file_intakes.sql",
      "0016_applications_and_import_finalization.sql"
    ]) {
      await admin.query(readFileSync(join(MIGRATIONS_DIRECTORY, migration), "utf8"));
    }

    await admin.query(`INSERT INTO organizations (organization_id, name) VALUES ($1, 'Org A')`, [organizationId]);
    const user = await admin.query<{ user_id: string }>(
      `INSERT INTO users (email, display_name) VALUES ($1, 'Probe') RETURNING user_id`,
      [`apporder_${suffix}@acme.test`]
    );
    const userId = user.rows[0]?.user_id;
    if (userId === undefined) {
      throw new Error("probe could not create a user");
    }
    const role = await admin.query<{ role_id: string }>(
      `INSERT INTO roles (organization_id, title, created_by_user_id) VALUES ($1, 'Role', $2) RETURNING role_id`,
      [organizationId, userId]
    );
    const roleId = role.rows[0]?.role_id;
    if (roleId === undefined) {
      throw new Error("probe could not create a role");
    }

    // Two intakes, three rows each, inserted in a deliberately jumbled
    // sequence so a missing ORDER BY would show up as insertion order.
    const intakeIds: string[] = [];
    for (const label of ["first", "second"]) {
      const intake = await admin.query<{ intake_id: string }>(
        `INSERT INTO file_intakes (organization_id, role_id, storage_key, declared_filename, declared_mime_type, created_by_user_id)
         VALUES ($1, $2, $3, 'applicants.csv', 'text/csv', $4) RETURNING intake_id`,
        [organizationId, roleId, `probe/${suffix}/${label}.csv`, userId]
      );
      const intakeId = intake.rows[0]?.intake_id;
      if (intakeId === undefined) {
        throw new Error("probe could not create a file intake");
      }
      intakeIds.push(intakeId);
    }
    const [firstIntakeId, secondIntakeId] = intakeIds as [string, string];

    const writes: Array<[string, number]> = [
      [secondIntakeId, 2],
      [firstIntakeId, 3],
      [secondIntakeId, 1],
      [firstIntakeId, 1],
      [secondIntakeId, 3],
      [firstIntakeId, 2]
    ];
    for (const [intakeId, rowNumber] of writes) {
      await admin.query(
        `INSERT INTO applications
           (organization_id, role_id, intake_id, source_row_number, candidate_full_name, candidate_email, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          organizationId,
          roleId,
          intakeId,
          rowNumber,
          `Candidate ${rowNumber}`,
          `c${rowNumber}-${intakeId.slice(0, 4)}@acme.test`,
          sharedCreatedAt
        ]
      );
    }

    const listed = await listApplicationsForRole(databaseUrl, schema, organizationId, roleId);
    if (listed.length !== 6) {
      throw new Error(`probe expected 6 applications, got ${listed.length}`);
    }

    // 1. Each import is one unbroken run -- never interleaved.
    const intakeSequence = listed.map((application) => application.intakeId);
    const runs = intakeSequence.filter((intakeId, index) => intakeId !== intakeSequence[index - 1]);
    if (runs.length !== new Set(intakeSequence).size) {
      throw new Error(
        `two imports sharing a created_at were interleaved by the database: ${intakeSequence
          .map((intakeId) => intakeId.slice(0, 4))
          .join(",")}`
      );
    }

    // 2. Within each run, the file's own row order, ascending.
    for (const intakeId of new Set(intakeSequence)) {
      const rowNumbers = listed
        .filter((application) => application.intakeId === intakeId)
        .map((application) => application.sourceRowNumber);
      if (rowNumbers.join(",") !== "1,2,3") {
        throw new Error(`rows within one import must keep file order, got ${rowNumbers.join(",")}`);
      }
    }

    // 3. The database and the domain comparator agree exactly. This is
    // the assertion that stops the two drifting: either one alone can be
    // "an order", but the queue is only the original order if they match.
    const sortedInDomain = [...listed].sort(compareApplicationsBySourceOrder).map((a) => a.applicationId);
    if (sortedInDomain.join(",") !== listed.map((a) => a.applicationId).join(",")) {
      throw new Error("SQL ORDER BY and compareApplicationsBySourceOrder disagree about the queue order");
    }

    // 4. Stable across repeated reads, so a recruiter refreshing the page
    // never sees candidates move.
    const again = await listApplicationsForRole(databaseUrl, schema, organizationId, roleId);
    if (again.map((a) => a.applicationId).join(",") !== listed.map((a) => a.applicationId).join(",")) {
      throw new Error("two identical reads returned different queue orders");
    }
  } finally {
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } catch {
      // Best-effort cleanup; the next probe uses a unique suffix.
    }
    await admin.end().catch(() => undefined);
  }
}

/**
 * Per-role pipeline health. Scoped by organization first, not only by
 * role: role_id is a uuid and would be unguessable in practice, but
 * POL-011 is a tenant boundary, not an obscurity argument, so the
 * organization is part of the predicate rather than assumed from it.
 *
 * The LEFT JOIN is what distinguishes "extraction ran and found nothing"
 * (quality = 'empty', a failure) from "extraction has not run yet" (no
 * row at all, still in flight). An INNER JOIN would silently drop the
 * second group and make the rate look better than it is.
 */
export async function getFailedDocumentRate(
  databaseUrl: string,
  schema: string,
  organizationId: string,
  roleId: string
): Promise<FailedDocumentRate> {
  assertSafeSchema(schema);
  const client = await acquireConnection(databaseUrl);
  try {
    const result = await client.query<{
      uploaded: string;
      quarantined: string;
      rejected: string;
      extraction_empty: string;
      extraction_succeeded: string;
    }>(
      `SELECT
         count(*) FILTER (WHERE fi.status <> 'pending') AS uploaded,
         count(*) FILTER (WHERE fi.status = 'quarantined') AS quarantined,
         count(*) FILTER (WHERE fi.status = 'rejected') AS rejected,
         count(*) FILTER (WHERE fi.status = 'validated' AND cte.quality = 'empty') AS extraction_empty,
         count(*) FILTER (WHERE fi.status = 'validated' AND cte.quality IN ('full', 'partial'))
           AS extraction_succeeded
       FROM "${schema}".file_intakes fi
       LEFT JOIN "${schema}".canonical_text_extractions cte ON cte.intake_id = fi.intake_id
       WHERE fi.organization_id = $1 AND fi.role_id = $2`,
      [organizationId, roleId]
    );
    const row = result.rows[0];
    if (row === undefined) {
      // Aggregates always produce exactly one row, so no row means the
      // query did not run as written rather than "this role has no files".
      throw new Error("getFailedDocumentRate: aggregate query returned no row");
    }
    // count(*) is bigint, which node-postgres hands back as a string.
    // Number() on an out-of-range or malformed value would silently
    // produce NaN or a rounded float and poison every derived figure.
    const toCount = (value: string, column: string): number => {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error(`getFailedDocumentRate: ${column} is not a safe non-negative integer, got: ${value}`);
      }
      return parsed;
    };
    return summarizeFailedDocuments(organizationId, roleId, {
      uploaded: toCount(row.uploaded, "uploaded"),
      quarantined: toCount(row.quarantined, "quarantined"),
      rejected: toCount(row.rejected, "rejected"),
      extractionEmpty: toCount(row.extraction_empty, "extraction_empty"),
      extractionSucceeded: toCount(row.extraction_succeeded, "extraction_succeeded")
    });
  } finally {
    client.release();
  }
}

/**
 * AF-58 review probe. The counting rules only mean anything against a
 * real schema: the LEFT JOIN, the `FILTER` predicates and the
 * status/quality CHECK constraints are all database behaviour, and a
 * hand-built fake would just restate the SQL I am trying to test.
 *
 * Three claims, each of which was wrong under an obvious simpler query:
 *   1. A validated intake with NO extraction row is in flight, not a
 *      failure -- an INNER JOIN or a `cte.quality IS DISTINCT FROM 'full'`
 *      predicate would count it as failed.
 *   2. `pending` never counts as an uploaded document at all.
 *   3. The result is scoped to one organization AND one role; a second
 *      role, and a second tenant's identical data, must not leak in.
 */
export async function assertFailedDocumentRateAccuracy(databaseUrl: string): Promise<void> {
  const suffix = randomBytes(4).toString("hex");
  const schema = `fdr_probe_${suffix}`;
  const orgA = "11111111-1111-4111-8111-111111111111";
  const orgB = "22222222-2222-4222-8222-222222222222";
  const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const roleA = "33333333-3333-4333-8333-333333333333";
  const roleOther = "44444444-4444-4444-8444-444444444444";
  const roleB = "55555555-5555-4555-8555-555555555555";
  const admin = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });

  try {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    for (const file of [
      "0002_organizations_users_memberships.sql",
      "0009_roles.sql",
      "0013_file_intakes.sql",
      "0014_file_intake_validation.sql",
      "0015_canonical_text_extractions.sql"
    ]) {
      await admin.query(readFileSync(join(MIGRATIONS_DIRECTORY, file), "utf8"));
    }
    await admin.query(`INSERT INTO organizations (organization_id, name) VALUES ($1,'A'), ($2,'B')`, [orgA, orgB]);
    await admin.query(`INSERT INTO users (user_id, email, display_name) VALUES ($1,$2,'U')`, [
      userId,
      `probe_${suffix}@acme.test`
    ]);
    await admin.query(
      `INSERT INTO roles (role_id, organization_id, title, created_by_user_id)
       VALUES ($1,$2,'A role',$4), ($3,$2,'Other role',$4), ($5,$6,'B role',$4)`,
      [roleA, orgA, roleOther, userId, roleB, orgB]
    );

    let seq = 0;
    const intake = async (organizationId: string, roleId: string, status: string): Promise<string> => {
      seq += 1;
      const result = await admin.query<{ intake_id: string }>(
        `INSERT INTO file_intakes
           (organization_id, role_id, storage_key, declared_filename, declared_mime_type, status, created_by_user_id)
         VALUES ($1,$2,$3,'cv.pdf','application/pdf',$4,$5) RETURNING intake_id`,
        [organizationId, roleId, `key-${suffix}-${seq}`, status, userId]
      );
      return result.rows[0]!.intake_id;
    };
    const extraction = async (intakeId: string, quality: string): Promise<void> => {
      await admin.query(
        `INSERT INTO canonical_text_extractions (intake_id, pages, total_pages, quality)
         VALUES ($1, '[]'::jsonb, 1, $2)`,
        [intakeId, quality]
      );
    };

    // Role A: 1 quarantined, 1 rejected, 1 empty extraction (all failures),
    // 1 full + 1 partial (successes), 1 validated-but-unextracted and
    // 1 uploaded (both in flight), 1 pending (not a document at all).
    await intake(orgA, roleA, "quarantined");
    await intake(orgA, roleA, "rejected");
    await extraction(await intake(orgA, roleA, "validated"), "empty");
    await extraction(await intake(orgA, roleA, "validated"), "full");
    await extraction(await intake(orgA, roleA, "validated"), "partial");
    await intake(orgA, roleA, "validated"); // extraction has not run yet
    await intake(orgA, roleA, "uploaded");
    await intake(orgA, roleA, "pending");
    // Noise that must not be counted: another role, and another tenant.
    await intake(orgA, roleOther, "quarantined");
    await intake(orgB, roleB, "quarantined");
    // Originally this inserted a row in org B pointing at org A's role, to
    // prove the organization_id predicate was load-bearing rather than
    // decorative. AF-28 closed that hole in the meantime: file_intakes now
    // carries a composite FOREIGN KEY (role_id, organization_id) onto roles,
    // so the misattributed row cannot be written at all.
    //
    // The check is kept and strengthened rather than deleted. Asserting the
    // database refuses the insert is a stronger statement than asserting a
    // query filtered it out afterwards, and if that constraint were ever
    // dropped this would fail instead of silently going back to relying on
    // the predicate alone.
    let crossTenantRejection = "";
    try {
      await intake(orgB, roleA, "quarantined");
    } catch (error) {
      crossTenantRejection = error instanceof Error ? error.message : String(error);
    }
    if (!/file_intakes_role_organization_fkey/u.test(crossTenantRejection)) {
      throw new Error(
        `assertFailedDocumentRateAccuracy: a file intake in another organization pointing at this role must be refused by the composite tenant foreign key, got: ${JSON.stringify(crossTenantRejection)}`
      );
    }

    const rate = await getFailedDocumentRate(databaseUrl, schema, orgA, roleA);
    const expected = {
      uploaded: 7,
      quarantined: 1,
      rejected: 1,
      extractionEmpty: 1,
      extractionSucceeded: 2,
      failed: 3,
      resolved: 5,
      inFlight: 2
    };
    for (const [key, want] of Object.entries(expected)) {
      const got = (rate as unknown as Record<string, number>)[key];
      if (got !== want) {
        throw new Error(
          `assertFailedDocumentRateAccuracy: ${key} expected ${want}, got ${got} (full: ${JSON.stringify(rate)})`
        );
      }
    }
    if (rate.failedRate === null || Math.abs(rate.failedRate - 3 / 5) > 1e-12) {
      throw new Error(`expected failedRate 0.6, got ${rate.failedRate}`);
    }

    // A role with documents but none resolved has no rate at all.
    await intake(orgA, roleOther, "uploaded");
    const otherRole = await getFailedDocumentRate(databaseUrl, schema, orgA, roleOther);
    if (otherRole.quarantined !== 1 || otherRole.uploaded !== 2) {
      throw new Error(`role scoping leaked: ${JSON.stringify(otherRole)}`);
    }

    // An organization/role pair that does not exist is empty, not an error.
    const empty = await getFailedDocumentRate(databaseUrl, schema, orgA, roleB);
    if (empty.uploaded !== 0 || empty.failedRate !== null) {
      throw new Error(`cross-tenant role must be empty, got: ${JSON.stringify(empty)}`);
    }
  } finally {
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } catch {
      // Best-effort cleanup; the next probe uses a unique suffix.
    }
    await admin.end().catch(() => undefined);
  }
}

export interface RecordEvidenceOutcomeInput {
  readonly organizationId: string;
  readonly applicationId: string;
  readonly outcome: EvidenceOutcome;
  /** The extraction run that produced this, when one did. */
  readonly runId?: string;
}

export interface RecordedEvidenceOutcome {
  readonly outcome: EvidenceOutcome;
  readonly recordedAt: string;
}

/**
 * Insert only. evidence_outcomes is append-only at the database level
 * (0017_evidence_outcomes.sql's trigger), so there is deliberately no update or delete
 * function here either -- same shape as appendAuditEvent and
 * recordEvidenceExtractionRun.
 *
 * kind and criterionId are written as columns *and* live inside the
 * jsonb; the table's CHECK constraints reject any row where the two
 * disagree, so a caller cannot file an outcome under a state it does
 * not actually hold.
 */
export async function recordEvidenceOutcome(
  databaseUrl: string,
  schema: string,
  input: RecordEvidenceOutcomeInput,
  existingClient?: DatabaseQueryable
): Promise<void> {
  assertSafeSchema(schema);
  const insert = async (client: DatabaseQueryable): Promise<void> => {
    await client.query(
      `INSERT INTO "${schema}".evidence_outcomes
         (organization_id, application_id, criterion_id, kind, outcome, run_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        input.organizationId,
        input.applicationId,
        input.outcome.criterionId,
        input.outcome.kind,
        JSON.stringify(input.outcome),
        input.runId ?? null
      ]
    );
  };
  if (existingClient !== undefined) {
    await insert(existingClient);
    return;
  }
  const client = await acquireConnection(databaseUrl);
  try {
    await insert(client);
  } finally {
    client.release();
  }
}

/**
 * The current outcome per criterion: newest row wins.
 *
 * DISTINCT ON rather than fetching every revision and reducing in
 * TypeScript, because a criterion corrected many times would otherwise
 * ship its whole history to the caller to render one card. Scoped by
 * organizationId as well as applicationId for the same reason
 * listApplicationsForRole is (AF-45): an applicationId alone identifies
 * the row, and relying on the route to have resolved tenancy first is
 * exactly the shape of an IDOR.
 */
export async function listCurrentEvidenceOutcomesForApplication(
  databaseUrl: string,
  schema: string,
  organizationId: string,
  applicationId: string
): Promise<readonly RecordedEvidenceOutcome[]> {
  assertSafeSchema(schema);
  const client = await acquireConnection(databaseUrl);
  try {
    const result = await client.query<{ outcome: EvidenceOutcome; recorded_at: Date }>(
      `SELECT DISTINCT ON (criterion_id) outcome, recorded_at
         FROM "${schema}".evidence_outcomes
        WHERE organization_id = $1 AND application_id = $2
        ORDER BY criterion_id, recorded_at DESC, evidence_outcome_id DESC`,
      [organizationId, applicationId]
    );
    return result.rows.map((row) => ({
      outcome: row.outcome,
      recordedAt: row.recorded_at.toISOString()
    }));
  } finally {
    client.release();
  }
}

/**
 * One application, scoped by organization as well as id. Routes need
 * this to confirm an applicationId in the path actually belongs to the
 * role in the path before reading anything else about it -- without it,
 * a valid application id from a sibling tenant would resolve.
 */
export async function getApplicationById(
  databaseUrl: string,
  schema: string,
  organizationId: string,
  applicationId: string
): Promise<Application | undefined> {
  assertSafeSchema(schema);
  const client = await acquireConnection(databaseUrl);
  try {
    const result = await client.query<ApplicationRow>(
      `SELECT application_id, organization_id, role_id, intake_id, source_row_number,
              candidate_full_name, candidate_email, external_reference_id, applied_at, created_at
         FROM "${schema}".applications
        WHERE organization_id = $1 AND application_id = $2`,
      [organizationId, applicationId]
    );
    const row = result.rows[0];
    return row === undefined ? undefined : rowToApplication(row);
  } finally {
    client.release();
  }
}

/**
 * AF-48 prerequisite: proves evidence_outcomes behaves as the review
 * card depends on it to, against a real database.
 *
 * Four claims, each of which the card silently gets wrong if the table
 * does not hold: the newest row per criterion is what a read returns,
 * an outcome cannot be filed under a state or criterion it does not
 * hold, an organization cannot read another's evidence, and nothing can
 * edit or erase a recorded outcome.
 */
export async function assertEvidenceOutcomePersistence(databaseUrl: string): Promise<void> {
  const suffix = randomBytes(4).toString("hex");
  const schema = `evout_probe_${suffix}`;
  const orgA = "11111111-1111-4111-8111-111111111111";
  const orgB = "22222222-2222-4222-8222-222222222222";
  const admin = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });

  // AF-13 made organizationId and candidateId mandatory on every
  // EvidenceOutcome kind, so the probe attributes its fixtures rather than
  // constructing outcomes the persistence layer would reject.
  const candidateId = "33333333-3333-4333-8333-333333333333";
  const outcome = (
    kind: "supported" | "not_found",
    criterionId: string,
    organizationId: string = orgA
  ): EvidenceOutcome =>
    kind === "supported"
      ? {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          kind: "supported",
          organizationId,
          candidateId,
          criterionId,
          citation: {
            document: "resume.pdf",
            pageOrSection: "Experience",
            offset: 10,
            quote: "Built Python services in production."
          }
        }
      : {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          kind: "not_found",
          organizationId,
          candidateId,
          criterionId
        };

  try {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    for (const migration of [
      "0002_organizations_users_memberships.sql",
      "0006_evidence_extraction_runs.sql",
      "0009_roles.sql",
      "0013_file_intakes.sql",
      "0016_applications_and_import_finalization.sql",
      "0017_evidence_outcomes.sql"
    ]) {
      await admin.query(readFileSync(join(MIGRATIONS_DIRECTORY, migration), "utf8"));
    }

    await admin.query(`INSERT INTO organizations (organization_id, name) VALUES ($1, 'A'), ($2, 'B')`, [orgA, orgB]);
    const user = await admin.query<{ user_id: string }>(
      `INSERT INTO users (email, display_name) VALUES ($1, 'Probe') RETURNING user_id`,
      [`evout_${suffix}@acme.test`]
    );
    const userId = user.rows[0]?.user_id;
    if (userId === undefined) {
      throw new Error("probe could not create a user");
    }

    const applicationIds: Record<string, string> = {};
    for (const [label, organizationId] of [
      ["a", orgA],
      ["b", orgB]
    ] as const) {
      const role = await admin.query<{ role_id: string }>(
        `INSERT INTO roles (organization_id, title, created_by_user_id) VALUES ($1, $2, $3) RETURNING role_id`,
        [organizationId, `Role ${label}`, userId]
      );
      const roleId = role.rows[0]?.role_id;
      const intake = await admin.query<{ intake_id: string }>(
        `INSERT INTO file_intakes (organization_id, role_id, storage_key, declared_filename, declared_mime_type, created_by_user_id)
         VALUES ($1, $2, $3, 'a.csv', 'text/csv', $4) RETURNING intake_id`,
        [organizationId, roleId, `probe/${suffix}/${label}.csv`, userId]
      );
      const application = await admin.query<{ application_id: string }>(
        `INSERT INTO applications (organization_id, role_id, intake_id, source_row_number, candidate_full_name, candidate_email)
         VALUES ($1, $2, $3, 1, 'Casey', $4) RETURNING application_id`,
        [organizationId, roleId, intake.rows[0]?.intake_id, `${label}@acme.test`]
      );
      const applicationId = application.rows[0]?.application_id;
      if (applicationId === undefined) {
        throw new Error("probe could not create an application");
      }
      applicationIds[label] = applicationId;
    }
    const appA = applicationIds["a"];
    const appB = applicationIds["b"];
    if (appA === undefined || appB === undefined) {
      throw new Error("probe did not create both applications");
    }

    // 1. Newest row per criterion wins -- the correction rule the card
    //    and AF-49 both depend on.
    await recordEvidenceOutcome(databaseUrl, schema, {
      organizationId: orgA,
      applicationId: appA,
      outcome: outcome("supported", "python")
    });
    await recordEvidenceOutcome(databaseUrl, schema, {
      organizationId: orgA,
      applicationId: appA,
      outcome: outcome("not_found", "python")
    });
    await recordEvidenceOutcome(databaseUrl, schema, {
      organizationId: orgA,
      applicationId: appA,
      outcome: outcome("supported", "postgres")
    });

    const current = await listCurrentEvidenceOutcomesForApplication(databaseUrl, schema, orgA, appA);
    if (current.length !== 2) {
      throw new Error(`expected one current outcome per criterion, got ${current.length}`);
    }
    const python = current.find((entry) => entry.outcome.criterionId === "python");
    if (python?.outcome.kind !== "not_found") {
      throw new Error(`the newest outcome must win, got ${python?.outcome.kind}`);
    }

    // 2. Another tenant's evidence is unreachable even with a real id.
    const crossTenant = await listCurrentEvidenceOutcomesForApplication(databaseUrl, schema, orgB, appA);
    if (crossTenant.length !== 0) {
      throw new Error(`org B must not read org A's evidence, got ${crossTenant.length} rows`);
    }

    // 3. A row cannot be filed under a state or criterion it does not hold.
    for (const [column, value] of [
      ["kind", "'contradicted'"],
      ["criterion_id", "'a_different_criterion'"]
    ] as const) {
      let rejected = false;
      try {
        await admin.query(
          `INSERT INTO evidence_outcomes (organization_id, application_id, criterion_id, kind, outcome)
           VALUES ($1, $2, ${column === "criterion_id" ? value : "'python'"}, ${column === "kind" ? value : "'supported'"}, $3::jsonb)`,
          [orgA, appA, JSON.stringify(outcome("supported", "python"))]
        );
      } catch {
        rejected = true;
      }
      if (!rejected) {
        throw new Error(`a row whose ${column} disagrees with its stored outcome must be rejected`);
      }
    }

    // 4. A payload that is not a JSON object, or that omits the key a
    //    lifted column claims to mirror, is rejected. `=` was not enough:
    //    `outcome ->> 'kind'` is NULL when the key is absent and a CHECK
    //    only fails on FALSE, so a payload with no kind at all passed the
    //    constraint meant to catch exactly that.
    for (const payload of ['"just a string"', "[1,2]", '{"no_kind_key":true}', '{"kind":"supported"}']) {
      let rejected = false;
      try {
        await admin.query(
          `INSERT INTO evidence_outcomes (organization_id, application_id, criterion_id, kind, outcome)
           VALUES ($1, $2, 'python', 'supported', $3::jsonb)`,
          [orgA, appA, payload]
        );
      } catch {
        rejected = true;
      }
      if (!rejected) {
        throw new Error(`a payload the lifted columns cannot mirror must be rejected: ${payload}`);
      }
    }

    // 5. Evidence cannot be filed under one tenant against another
    //    tenant's application. Independent foreign keys each hold on
    //    their own while permitting exactly this pairing.
    let misattributionRejected = false;
    try {
      await admin.query(
        `INSERT INTO evidence_outcomes (organization_id, application_id, criterion_id, kind, outcome)
         VALUES ($1, $2, 'python', 'not_found', $3::jsonb)`,
        [orgB, appA, JSON.stringify(outcome("not_found", "python"))]
      );
    } catch {
      misattributionRejected = true;
    }
    if (!misattributionRejected) {
      throw new Error("org B must not be able to record evidence against org A's application");
    }

    // 6. Removing a parent reports the real obstacle. With ON DELETE
    //    CASCADE the cascade issued a DELETE and this table's append-only
    //    trigger rejected it, so the operator saw
    //    "evidence_outcomes is append-only" for a table they never named.
    //    0006_audit_events_delete_and_membership_fixes.sql hit the same thing on audit_events.
    for (const [label, statement, params] of [
      ["application", `DELETE FROM applications WHERE application_id = $1`, [appA]],
      ["organization", `DELETE FROM organizations WHERE organization_id = $1`, [orgA]]
    ] as const) {
      let message = "";
      try {
        await admin.query(statement, [...params]);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      if (message === "") {
        throw new Error(`deleting a ${label} with recorded evidence must be refused`);
      }
      if (message.includes("append-only")) {
        throw new Error(
          `deleting a ${label} must report a foreign-key violation naming the real obstacle, not "${message}"`
        );
      }
    }

    // 7. Append-only: nothing edits or erases a recorded outcome.
    for (const statement of [
      `UPDATE evidence_outcomes SET kind = 'failed'`,
      `DELETE FROM evidence_outcomes`,
      `TRUNCATE evidence_outcomes`
    ]) {
      let rejected = false;
      try {
        await admin.query(statement);
      } catch {
        rejected = true;
      }
      if (!rejected) {
        throw new Error(`evidence_outcomes must reject: ${statement}`);
      }
    }
  } finally {
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } catch {
      // Best-effort cleanup; the next probe uses a unique suffix.
    }
    await admin.end().catch(() => undefined);
  }
}

export interface CorrectEvidenceOutcomeInput {
  readonly organizationId: string;
  readonly applicationId: string;
  readonly criterionId: string;
  /** What the recruiter says the outcome should be. */
  readonly outcome: EvidenceOutcome;
  readonly correctedByUserId: string;
  readonly reason: string;
}

/**
 * A correction is an append that names what it replaced, never an edit.
 *
 * `superseded` rather than an exception, because losing a race is an
 * ordinary outcome a UI has to render ("someone corrected this while you
 * were typing"), not a fault. Same discriminated shape as
 * MagicLinkRedemptionAttempt and ResourceAuthorization.
 *
 * `nothing_to_correct` is its own state for the same reason: a
 * correction with no "before" is not a correction, and silently turning
 * it into an original would lose exactly the distinction AF-49 exists to
 * keep.
 */
export interface RecordedEvidenceRevision {
  readonly evidenceOutcomeId: string;
  readonly outcome: EvidenceOutcome;
  readonly recordedAt: string;
  readonly correctedByUserId?: string | undefined;
  readonly correctionReason?: string | undefined;
  readonly supersedesEvidenceOutcomeId?: string | undefined;
}

export async function correctEvidenceOutcome(
  databaseUrl: string,
  schema: string,
  input: CorrectEvidenceOutcomeInput,
  idempotency?: IdempotencyContext
): Promise<EvidenceCorrectionResult> {
  assertSafeSchema(schema);
  const client = await acquireConnection(databaseUrl);
  try {
    await client.query("BEGIN");
    try {
      // Same fix as recordCandidateDecision (review #83, P1): the claim lives
      // in the correction's own transaction, so a fault cannot leave a
      // committed correction behind an idempotency key that never completed.
      let claimId: string | undefined;
      if (idempotency !== undefined) {
        const claim = await claimOnClient(client, schema, input.organizationId, idempotency);
        if (!("claimId" in claim)) {
          await client.query("COMMIT");
          if (claim.kind === "replay") {
            return { outcome: "replayed", status: claim.status, body: claim.body };
          }
          return claim.kind === "fingerprint_mismatch"
            ? { outcome: "idempotency_mismatch" }
            : { outcome: "idempotency_in_flight" };
        }
        claimId = claim.claimId;
      }

      // Serialize correction and worker completion for the same application.
      // Whichever transaction obtains this lock second observes the first one's
      // append, so a machine result can never become current over a human edit.
      const application = await client.query(
        `SELECT application_id
           FROM "${schema}".applications
          WHERE organization_id = $1 AND application_id = $2
          FOR UPDATE`,
        [input.organizationId, input.applicationId]
      );
      if (application.rows[0] === undefined) {
        await client.query("ROLLBACK");
        return { outcome: "nothing_to_correct" };
      }

      // What is actually load-bearing here, measured rather than
      // asserted:
      //
      //   - The partial unique index on supersedes_evidence_outcome_id
      //     is what makes a forked history impossible.
      //   - `ON CONFLICT ... DO NOTHING` below is what turns losing the
      //     race into the `superseded` result a UI can render instead of
      //     a raw unique-violation exception. Removing it fails the
      //     concurrency probe deterministically (6 runs, 6 failures).
      //   - This FOR UPDATE is defence in depth and nothing more.
      //     Removing it fails no test (4 runs, 4 passes), because
      //     ON CONFLICT already handles the race on its own. It is kept
      //     because serialising the two correctors is cheaper than
      //     letting both build a row and discarding one, not because
      //     correctness depends on it.
      //
      // Locking a row of an append-only table is safe: SELECT ... FOR
      // UPDATE takes a row lock and does not fire the BEFORE UPDATE
      // trigger. Verified against a real database, not assumed.
      const head = await client.query<{ evidence_outcome_id: string }>(
        `SELECT evidence_outcome_id
           FROM "${schema}".evidence_outcomes
          WHERE organization_id = $1 AND application_id = $2 AND criterion_id = $3
          ORDER BY recorded_at DESC, evidence_outcome_id DESC
          LIMIT 1
          FOR UPDATE`,
        [input.organizationId, input.applicationId, input.criterionId]
      );
      const supersededId = head.rows[0]?.evidence_outcome_id;
      if (supersededId === undefined) {
        await client.query("ROLLBACK");
        return { outcome: "nothing_to_correct" };
      }

      const inserted = await client.query<{ evidence_outcome_id: string }>(
        `INSERT INTO "${schema}".evidence_outcomes
           (organization_id, application_id, criterion_id, kind, outcome,
            corrected_by_user_id, correction_reason, supersedes_evidence_outcome_id)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
         ON CONFLICT (supersedes_evidence_outcome_id)
           WHERE supersedes_evidence_outcome_id IS NOT NULL DO NOTHING
         RETURNING evidence_outcome_id`,
        [
          input.organizationId,
          input.applicationId,
          input.criterionId,
          input.outcome.kind,
          JSON.stringify(input.outcome),
          input.correctedByUserId,
          input.reason,
          supersededId
        ]
      );
      const evidenceOutcomeId = inserted.rows[0]?.evidence_outcome_id;
      if (evidenceOutcomeId === undefined) {
        // No correction recorded, so the claim rolls back with it.
        await client.query("ROLLBACK");
        return { outcome: "superseded" };
      }
      if (claimId !== undefined) {
        // Stored in the route's response shape, not the writer's internal
        // one, so a replay is byte-identical to the original 201.
        await completeOnClient(client, schema, claimId, 201, {
          evidenceOutcomeId,
          supersededEvidenceOutcomeId: supersededId
        });
      }
      await client.query("COMMIT");
      return { outcome: "recorded", evidenceOutcomeId, supersededId };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
  }
}

/**
 * Every revision for an application, oldest first -- the "before/after
 * state is preserved for every correction" half of AF-49, readable.
 *
 * Deliberately returns the whole history rather than just the current
 * outcome: listCurrentEvidenceOutcomesForApplication already answers
 * "what does this say now", and a caller that wanted before/after could
 * not reconstruct it from that.
 */
export async function listEvidenceRevisionsForApplication(
  databaseUrl: string,
  schema: string,
  organizationId: string,
  applicationId: string
): Promise<readonly RecordedEvidenceRevision[]> {
  assertSafeSchema(schema);
  const client = await acquireConnection(databaseUrl);
  try {
    const result = await client.query<{
      evidence_outcome_id: string;
      outcome: EvidenceOutcome;
      recorded_at: Date;
      corrected_by_user_id: string | null;
      correction_reason: string | null;
      supersedes_evidence_outcome_id: string | null;
    }>(
      `SELECT evidence_outcome_id, outcome, recorded_at,
              corrected_by_user_id, correction_reason, supersedes_evidence_outcome_id
         FROM "${schema}".evidence_outcomes
        WHERE organization_id = $1 AND application_id = $2
        ORDER BY criterion_id, recorded_at, evidence_outcome_id`,
      [organizationId, applicationId]
    );
    return result.rows.map((row) => ({
      evidenceOutcomeId: row.evidence_outcome_id,
      outcome: row.outcome,
      recordedAt: row.recorded_at.toISOString(),
      ...(row.corrected_by_user_id === null ? {} : { correctedByUserId: row.corrected_by_user_id }),
      ...(row.correction_reason === null ? {} : { correctionReason: row.correction_reason }),
      ...(row.supersedes_evidence_outcome_id === null
        ? {}
        : { supersedesEvidenceOutcomeId: row.supersedes_evidence_outcome_id })
    }));
  } finally {
    client.release();
  }
}

/**
 * AF-49: proves corrections are append-only, attributed, chained, and
 * safe under genuine concurrency -- against a real database.
 *
 * The concurrency case is the one that cannot be argued from the code.
 * Two recruiters correcting the same criterion at the same moment must
 * produce one correction and one honest "someone got there first", never
 * two corrections both claiming the same predecessor. This fires both
 * calls without awaiting the first, so they genuinely overlap.
 */
export async function assertEvidenceCorrectionsAppendOnly(databaseUrl: string): Promise<void> {
  const suffix = randomBytes(4).toString("hex");
  const schema = `evcorr_probe_${suffix}`;
  const organizationId = "11111111-1111-4111-8111-111111111111";
  const admin = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });

  // AF-13 made organizationId and candidateId mandatory on every
  // EvidenceOutcome kind. Attributed here rather than loosening the type, so
  // the probe stores what the persistence layer actually accepts.
  const probeCandidateId = "44444444-4444-4444-8444-444444444444";
  const attribution = { organizationId, candidateId: probeCandidateId } as const;
  const outcomeOf = (kind: "supported" | "not_found" | "unclear", criterionId: string): EvidenceOutcome =>
    kind === "supported"
      ? {
          ...attribution,
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          kind: "supported",
          criterionId,
          citation: { document: "resume.pdf", pageOrSection: "Experience", offset: 4, quote: "Ran Postgres." }
        }
      : kind === "unclear"
        ? {
            ...attribution,
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            kind: "unclear",
            criterionId,
            citation: { document: "resume.pdf", pageOrSection: "Skills", offset: 9, quote: "Databases." }
          }
        : { ...attribution, schemaVersion: CONTRACT_SCHEMA_VERSION, kind: "not_found", criterionId };

  try {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    for (const migration of [
      "0002_organizations_users_memberships.sql",
      "0006_evidence_extraction_runs.sql",
      "0009_roles.sql",
      "0013_file_intakes.sql",
      "0016_applications_and_import_finalization.sql",
      "0017_evidence_outcomes.sql",
      "0018_evidence_corrections.sql"
    ]) {
      await admin.query(readFileSync(join(MIGRATIONS_DIRECTORY, migration), "utf8"));
    }

    await admin.query(`INSERT INTO organizations (organization_id, name) VALUES ($1, 'A')`, [organizationId]);
    const user = await admin.query<{ user_id: string }>(
      `INSERT INTO users (email, display_name) VALUES ($1, 'Recruiter') RETURNING user_id`,
      [`evcorr_${suffix}@acme.test`]
    );
    const userId = user.rows[0]?.user_id;
    if (userId === undefined) {
      throw new Error("probe could not create a user");
    }
    const role = await admin.query<{ role_id: string }>(
      `INSERT INTO roles (organization_id, title, created_by_user_id) VALUES ($1, 'R', $2) RETURNING role_id`,
      [organizationId, userId]
    );
    const intake = await admin.query<{ intake_id: string }>(
      `INSERT INTO file_intakes (organization_id, role_id, storage_key, declared_filename, declared_mime_type, created_by_user_id)
       VALUES ($1, $2, $3, 'a.csv', 'text/csv', $4) RETURNING intake_id`,
      [organizationId, role.rows[0]?.role_id, `probe/${suffix}.csv`, userId]
    );
    const application = await admin.query<{ application_id: string }>(
      `INSERT INTO applications (organization_id, role_id, intake_id, source_row_number, candidate_full_name, candidate_email)
       VALUES ($1, $2, $3, 1, 'Casey', $4) RETURNING application_id`,
      [organizationId, role.rows[0]?.role_id, intake.rows[0]?.intake_id, `casey_${suffix}@acme.test`]
    );
    const applicationId = application.rows[0]?.application_id;
    if (applicationId === undefined) {
      throw new Error("probe could not create an application");
    }

    // 1. Correcting nothing is its own answer, not a silent original.
    const nothing = await correctEvidenceOutcome(databaseUrl, schema, {
      organizationId,
      applicationId,
      criterionId: "postgres",
      outcome: outcomeOf("not_found", "postgres"),
      correctedByUserId: userId,
      reason: "there is nothing here yet"
    });
    if (nothing.outcome !== "nothing_to_correct") {
      throw new Error(`correcting a criterion with no prior outcome must report it, got ${nothing.outcome}`);
    }

    await recordEvidenceOutcome(databaseUrl, schema, {
      organizationId,
      applicationId,
      outcome: outcomeOf("supported", "postgres")
    });

    // 2. A correction records, names its predecessor, and leaves the
    //    original in place.
    const corrected = await correctEvidenceOutcome(databaseUrl, schema, {
      organizationId,
      applicationId,
      criterionId: "postgres",
      outcome: outcomeOf("not_found", "postgres"),
      correctedByUserId: userId,
      reason: "quote belongs to a different candidate"
    });
    if (corrected.outcome !== "recorded") {
      throw new Error(`expected the correction to record, got ${corrected.outcome}`);
    }

    const history = await listEvidenceRevisionsForApplication(databaseUrl, schema, organizationId, applicationId);
    if (history.length !== 2) {
      throw new Error(`the original must survive the correction; history has ${history.length} revisions`);
    }
    const originalRow = history.find((revision) => revision.supersedesEvidenceOutcomeId === undefined);
    if (originalRow?.outcome.kind !== "supported") {
      throw new Error("the original AI output must still read as it did before the correction");
    }
    const correctionRow = history.find((revision) => revision.evidenceOutcomeId === corrected.evidenceOutcomeId);
    if (correctionRow?.supersedesEvidenceOutcomeId !== corrected.supersededId) {
      throw new Error("a correction must record which revision it replaced");
    }
    if (correctionRow.correctionReason === undefined || correctionRow.correctedByUserId === undefined) {
      throw new Error("a correction must be attributed to a person and a reason");
    }

    // 3. The current outcome is the correction, not the original.
    const current = await listCurrentEvidenceOutcomesForApplication(
      databaseUrl,
      schema,
      organizationId,
      applicationId
    );
    if (current.length !== 1 || current[0]?.outcome.kind !== "not_found") {
      throw new Error(`the corrected value must be current, got ${JSON.stringify(current)}`);
    }

    // 4. Genuine concurrency: both corrections launched before either is
    //    awaited, so they overlap on the wire rather than in theory.
    await recordEvidenceOutcome(databaseUrl, schema, {
      organizationId,
      applicationId,
      outcome: outcomeOf("supported", "python")
    });
    const [first, second] = await Promise.all([
      correctEvidenceOutcome(databaseUrl, schema, {
        organizationId,
        applicationId,
        criterionId: "python",
        outcome: outcomeOf("not_found", "python"),
        correctedByUserId: userId,
        reason: "first corrector"
      }),
      correctEvidenceOutcome(databaseUrl, schema, {
        organizationId,
        applicationId,
        criterionId: "python",
        outcome: outcomeOf("unclear", "python"),
        correctedByUserId: userId,
        reason: "second corrector"
      })
    ]);
    // What is asserted here is the invariant, not one particular
    // interleaving. If the two calls genuinely overlap, one records and
    // the other reports `superseded`; if the first commits before the
    // second reads, the second legitimately corrects the correction and
    // both record. Both are correct outcomes, and pinning the exact pair
    // would make this test fail on timing rather than on behaviour --
    // a flake dressed as a regression.
    //
    // What must never happen, under any interleaving, is a forked
    // history: two revisions claiming the same predecessor, leaving
    // "the before state" ambiguous for whichever survives.
    //
    // Stated honestly: this particular assertion cannot fail while the
    // schema is intact, and dropping 0018_evidence_corrections.sql's unique index to prove it
    // does not isolate the behaviour -- the INSERT fails earlier with
    // "there is no unique or exclusion constraint matching the ON
    // CONFLICT specification". It is kept as a statement of the
    // invariant and as a guard against a future refactor that stops
    // routing corrections through ON CONFLICT; the assertion that
    // genuinely discriminates today is the one above it.
    for (const result of [first, second]) {
      if (result.outcome === "nothing_to_correct") {
        throw new Error("a criterion with a recorded outcome must never report nothing_to_correct");
      }
    }
    const pythonRevisions = (
      await listEvidenceRevisionsForApplication(databaseUrl, schema, organizationId, applicationId)
    ).filter((revision) => revision.outcome.criterionId === "python");
    const supersededIds = pythonRevisions
      .map((revision) => revision.supersedesEvidenceOutcomeId)
      .filter((id): id is string => id !== undefined);
    if (new Set(supersededIds).size !== supersededIds.length) {
      throw new Error(
        `concurrent corrections forked the history: ${supersededIds.length} revisions claim ${new Set(supersededIds).size} distinct predecessors`
      );
    }
    // Exactly one head, which is what "the chain is linear" means in
    // the form the review card actually consumes.
    const heads = pythonRevisions.filter(
      (revision) => !supersededIds.includes(revision.evidenceOutcomeId)
    );
    if (heads.length !== 1) {
      throw new Error(`a criterion must have exactly one current revision, got ${heads.length}`);
    }
    if (pythonRevisions.length < 2) {
      throw new Error("the original must survive alongside whatever corrections were recorded");
    }

    // 5. Nothing edits or erases a correction either.
    for (const statement of [
      `UPDATE evidence_outcomes SET correction_reason = 'rewritten'`,
      `DELETE FROM evidence_outcomes`
    ]) {
      let rejected = false;
      try {
        await admin.query(statement);
      } catch {
        rejected = true;
      }
      if (!rejected) {
        throw new Error(`corrections must be as immutable as originals; permitted: ${statement}`);
      }
    }
  } finally {
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } catch {
      // Best-effort cleanup; the next probe uses a unique suffix.
    }
    await admin.end().catch(() => undefined);
  }
}

/**
 * A correction is an append that names what it replaced, never an edit.
 *
 * `superseded` rather than an exception, because losing a race is an
 * ordinary outcome a UI has to render ("someone corrected this while you
 * were typing"), not a fault. Same discriminated shape as
 * MagicLinkRedemptionAttempt and ResourceAuthorization.
 *
 * `nothing_to_correct` is its own state for the same reason: a
 * correction with no "before" is not a correction, and silently turning
 * it into an original would lose exactly the distinction AF-49 exists to
 * keep.
 */
export type EvidenceCorrectionResult =
  | { readonly outcome: "recorded"; readonly evidenceOutcomeId: string; readonly supersededId: string }
  | { readonly outcome: "nothing_to_correct" }
  | { readonly outcome: "superseded" }
  /** See IdempotencyContext: these three come from the claim that now shares
   * this function's transaction rather than from a separate pre-flight. */
  | { readonly outcome: "replayed"; readonly status: number; readonly body: unknown }
  | { readonly outcome: "idempotency_mismatch" }
  | { readonly outcome: "idempotency_in_flight" };

export interface RecordCandidateDecisionInput {
  readonly organizationId: string;
  readonly applicationId: string;
  readonly decision: CandidateDecisionKind;
  readonly rationale: string;
  /**
   * Always required, never defaulted. There is no signature of this
   * function that records a decision without a named person, which is
   * the code-level half of what 0020_candidate_decisions.sql's NOT NULL enforces.
   */
  readonly decidedByUserId: string;
}

// ---- Review #83: durable idempotency for append-only human actions ----

export interface IdempotentRequestObservations {
  readonly firstClaim: string;
  readonly retryClaim: string;
  readonly retryStatus: number;
  readonly retryBody: unknown;
  readonly mismatchClaim: string;
  readonly inFlightClaim: string;
  readonly recordCount: number;
  readonly otherTenantClaim: string;
  readonly claimAfterRelease: string;
  /** The same key string on a DIFFERENT endpoint must not collide. */
  readonly sameKeyOtherEndpoint: string;
}

/**
 * Exercises the whole idempotency lifecycle against a real database, in its
 * own schema so repeated runs never collide.
 *
 * Real Postgres matters here: the mechanism IS the unique index plus
 * `ON CONFLICT DO NOTHING`. A fake would be asserting the test's own model of
 * a constraint rather than the constraint that ships.
 */
export async function assertIdempotentRequestSemantics(
  databaseUrl: string
): Promise<IdempotentRequestObservations> {
  const suffix = randomBytes(4).toString("hex");
  const schema = `idem_probe_${suffix}`;
  const orgA = "11111111-1111-4111-8111-111111111111";
  const orgB = "22222222-2222-4222-8222-222222222222";
  const endpoint = "candidate_decisions.record";
  const key = `key-${suffix}`;
  const payload = { applicationId: "a1", decision: "advance" };
  const admin = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });

  try {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    for (const migration of ["0002_organizations_users_memberships.sql", "0022_idempotent_requests.sql"]) {
      await admin.query(readFileSync(join(MIGRATIONS_DIRECTORY, migration), "utf8"));
    }
    await admin.query(`INSERT INTO organizations (organization_id, name) VALUES ($1,'A'), ($2,'B')`, [orgA, orgB]);

    const claim = (organizationId: string, body: unknown): Promise<IdempotentRequestClaim> =>
      claimIdempotentRequest(databaseUrl, schema, { organizationId, endpoint, idempotencyKey: key, payload: body });

    const first = await claim(orgA, payload);
    // Same key and payload while the first is still unfinished.
    const inFlight = await claim(orgA, payload);

    if (first.outcome !== "claimed") {
      throw new Error(`probe expected the first call to claim, got ${first.outcome}`);
    }
    await completeIdempotentRequest(databaseUrl, schema, first.requestId, 201, { decisionId: "d1" });

    const retry = await claim(orgA, payload);
    const mismatch = await claim(orgA, { ...payload, decision: "decline" });
    const otherTenant = await claim(orgB, payload);

    const count = await admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "${schema}".idempotent_requests
        WHERE organization_id = $1 AND endpoint = $2 AND idempotency_key = $3`,
      [orgA, endpoint, key]
    );

    // Release-then-reclaim, on a separate key so it cannot disturb the above.
    const releaseKey = `release-${suffix}`;
    const toRelease = await claimIdempotentRequest(databaseUrl, schema, {
      organizationId: orgA,
      endpoint,
      idempotencyKey: releaseKey,
      payload
    });
    if (toRelease.outcome !== "claimed") {
      throw new Error("probe expected to claim the release key");
    }
    await releaseIdempotentRequest(databaseUrl, schema, toRelease.requestId);
    const afterRelease = await claimIdempotentRequest(databaseUrl, schema, {
      organizationId: orgA,
      endpoint,
      idempotencyKey: releaseKey,
      payload
    });

    // A client generating one key per user action may legitimately send the
    // same value to two endpoints. Keying on the endpoint is what stops one
    // replaying the other's response.
    const otherEndpoint = await claimIdempotentRequest(databaseUrl, schema, {
      organizationId: orgA,
      endpoint: "evidence_corrections.record",
      idempotencyKey: key,
      payload
    });

    return {
      firstClaim: first.outcome,
      retryClaim: retry.outcome,
      retryStatus: retry.outcome === "replay" ? retry.status : -1,
      retryBody: retry.outcome === "replay" ? retry.body : undefined,
      mismatchClaim: mismatch.outcome,
      inFlightClaim: inFlight.outcome,
      recordCount: Number(count.rows[0]?.count ?? "-1"),
      otherTenantClaim: otherTenant.outcome,
      claimAfterRelease: afterRelease.outcome,
      sameKeyOtherEndpoint: otherEndpoint.outcome
    };
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}

export type IdempotentRequestClaim =
  /** This caller owns the operation; run it, then call completeIdempotentRequest. */
  | { readonly outcome: "claimed"; readonly requestId: string }
  /** A completed request with this key and the same payload; replay verbatim. */
  | { readonly outcome: "replay"; readonly status: number; readonly body: unknown }
  /** Same key, different payload. A client bug, refused rather than replayed. */
  | { readonly outcome: "fingerprint_mismatch" }
  /** Same key and payload, still running. A concurrent duplicate. */
  | { readonly outcome: "in_flight" };

/**
 * Claims an idempotency key, or reports what already happened under it.
 *
 * The INSERT is the lock. `ON CONFLICT DO NOTHING` plus the unique index
 * means exactly one concurrent caller can claim a key, so this cannot be
 * raced into recording the operation twice -- checking first and inserting
 * afterwards could be.
 */
export async function claimIdempotentRequest(
  databaseUrl: string,
  schema: string,
  input: {
    readonly organizationId: string;
    readonly endpoint: string;
    readonly idempotencyKey: string;
    readonly payload: unknown;
  }
): Promise<IdempotentRequestClaim> {
  assertSafeSchema(schema);
  const fingerprint = createHash("sha256").update(JSON.stringify(input.payload ?? null)).digest("hex");
  const client = await acquireConnection(databaseUrl);
  try {
    const claimed = await client.query<{ idempotent_request_id: string }>(
      `INSERT INTO "${schema}".idempotent_requests
         (organization_id, endpoint, idempotency_key, request_fingerprint)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (organization_id, endpoint, idempotency_key) DO NOTHING
       RETURNING idempotent_request_id`,
      [input.organizationId, input.endpoint, input.idempotencyKey, fingerprint]
    );
    const claimedId = claimed.rows[0]?.idempotent_request_id;
    if (claimedId !== undefined) {
      return { outcome: "claimed", requestId: claimedId };
    }

    const existing = await client.query<{
      request_fingerprint: string;
      response_status: number | null;
      response_body: unknown;
    }>(
      `SELECT request_fingerprint, response_status, response_body
         FROM "${schema}".idempotent_requests
        WHERE organization_id = $1 AND endpoint = $2 AND idempotency_key = $3`,
      [input.organizationId, input.endpoint, input.idempotencyKey]
    );
    const row = existing.rows[0];
    if (row === undefined) {
      // Only reachable if the row was deleted between the two statements,
      // which nothing does. Reported rather than retried silently.
      throw new Error("idempotency record vanished between claim and read");
    }
    if (row.request_fingerprint !== fingerprint) {
      return { outcome: "fingerprint_mismatch" };
    }
    if (row.response_status === null) {
      return { outcome: "in_flight" };
    }
    return { outcome: "replay", status: row.response_status, body: row.response_body };
  } finally {
    client.release();
  }
}

/** Records the response so a later retry replays it rather than re-running. */
export async function completeIdempotentRequest(
  databaseUrl: string,
  schema: string,
  requestId: string,
  status: number,
  body: unknown
): Promise<void> {
  assertSafeSchema(schema);
  const client = await acquireConnection(databaseUrl);
  try {
    await client.query(
      `UPDATE "${schema}".idempotent_requests
          SET response_status = $2, response_body = $3::jsonb, completed_at = clock_timestamp()
        WHERE idempotent_request_id = $1`,
      [requestId, status, JSON.stringify(body ?? null)]
    );
  } finally {
    client.release();
  }
}

/** Releases a claim whose operation failed, so the client can retry the same
 * key rather than being permanently locked out by a transient error. */
export async function releaseIdempotentRequest(
  databaseUrl: string,
  schema: string,
  requestId: string
): Promise<void> {
  assertSafeSchema(schema);
  const client = await acquireConnection(databaseUrl);
  try {
    await client.query(
      `DELETE FROM "${schema}".idempotent_requests WHERE idempotent_request_id = $1 AND response_status IS NULL`,
      [requestId]
    );
  } finally {
    client.release();
  }
}

export type CandidateDecisionResult =
  | { readonly outcome: "recorded"; readonly decisionId: string; readonly supersededId?: string }
  /** The same key and payload already completed; the stored response is
   * returned verbatim rather than a second decision being recorded. */
  | { readonly outcome: "replayed"; readonly status: number; readonly body: unknown }
  | { readonly outcome: "idempotency_mismatch" }
  | { readonly outcome: "idempotency_in_flight" }
  | { readonly outcome: "superseded" }
  /** The application does not exist for this organization, so there is
   * nothing to decide on and no parent row to serialize against. Distinct
   * from "superseded", which means a concurrent writer won a real race. */
  | { readonly outcome: "no_such_application" };

/**
 * Appends a decision, superseding the current one if there is one.
 *
 * Unlike a correction, there is no `nothing_to_decide` state: the first
 * decision about a candidate is a legitimate decision, it simply
 * supersedes nothing.
 *
 * `superseded` is returned rather than thrown when another reviewer
 * decided first -- the caller was looking at a status that has since
 * changed, so re-reading and re-deciding is the right next step, and a
 * UI has to be able to say so.
 */
/**
 * Idempotency context carried INTO an action's own transaction.
 *
 * Review #83, P1: claiming the key, performing the action and storing the
 * response were three calls on three connections. A fault after the action
 * committed but before the response was stored left the key at
 * `response_status = NULL` forever -- every same-key retry got `in_flight`,
 * while retrying with a fresh key recorded a second human decision. The
 * protocol was not atomic with the thing it protects.
 *
 * Passing it in makes the claim, the action and the completion one
 * transaction on one connection. A fault anywhere rolls back all three, so a
 * retry re-claims cleanly instead of wedging, and no action is ever committed
 * without its completed idempotency record.
 */
export interface IdempotencyContext {
  readonly endpoint: string;
  readonly key: string;
  readonly payload: unknown;
}

export type IdempotentReplay =
  | { readonly kind: "replay"; readonly status: number; readonly body: unknown }
  | { readonly kind: "fingerprint_mismatch" }
  | { readonly kind: "in_flight" };

/** Claims the key on the caller's transaction, or reports what already
 * happened under it. `FOR UPDATE` on the existing row serializes two
 * concurrent retries so they cannot both read a NULL response. */
async function claimOnClient(
  client: ClientBase,
  schema: string,
  organizationId: string,
  idempotency: IdempotencyContext
): Promise<{ readonly claimId: string } | IdempotentReplay> {
  const fingerprint = createHash("sha256").update(JSON.stringify(idempotency.payload ?? null)).digest("hex");
  const claimed = await client.query<{ idempotent_request_id: string }>(
    `INSERT INTO "${schema}".idempotent_requests
       (organization_id, endpoint, idempotency_key, request_fingerprint)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (organization_id, endpoint, idempotency_key) DO NOTHING
     RETURNING idempotent_request_id`,
    [organizationId, idempotency.endpoint, idempotency.key, fingerprint]
  );
  const claimId = claimed.rows[0]?.idempotent_request_id;
  if (claimId !== undefined) {
    return { claimId };
  }
  const existing = await client.query<{
    request_fingerprint: string;
    response_status: number | null;
    response_body: unknown;
  }>(
    `SELECT request_fingerprint, response_status, response_body
       FROM "${schema}".idempotent_requests
      WHERE organization_id = $1 AND endpoint = $2 AND idempotency_key = $3
      FOR UPDATE`,
    [organizationId, idempotency.endpoint, idempotency.key]
  );
  const row = existing.rows[0];
  if (row === undefined) {
    throw new Error("idempotency record vanished between claim and read");
  }
  if (row.request_fingerprint !== fingerprint) {
    return { kind: "fingerprint_mismatch" };
  }
  if (row.response_status === null) {
    return { kind: "in_flight" };
  }
  return { kind: "replay", status: row.response_status, body: row.response_body };
}

async function completeOnClient(
  client: ClientBase,
  schema: string,
  claimId: string,
  status: number,
  body: unknown
): Promise<void> {
  await client.query(
    `UPDATE "${schema}".idempotent_requests
        SET response_status = $2, response_body = $3::jsonb, completed_at = clock_timestamp()
      WHERE idempotent_request_id = $1`,
    [claimId, status, JSON.stringify(body ?? null)]
  );
}

export async function recordCandidateDecision(
  databaseUrl: string,
  schema: string,
  input: RecordCandidateDecisionInput,
  idempotency?: IdempotencyContext
): Promise<CandidateDecisionResult> {
  assertSafeSchema(schema);
  const client = await acquireConnection(databaseUrl);
  try {
    await client.query("BEGIN");
    try {
      // Claimed inside THIS transaction, not a separate one (review #83, P1).
      // The claim, the insert below and the completion before COMMIT either
      // all land or none do, so there is no window where a decision exists
      // with an incomplete idempotency record.
      let claimId: string | undefined;
      if (idempotency !== undefined) {
        const claim = await claimOnClient(client, schema, input.organizationId, idempotency);
        if (!("claimId" in claim)) {
          await client.query("COMMIT");
          if (claim.kind === "replay") {
            return { outcome: "replayed", status: claim.status, body: claim.body };
          }
          return claim.kind === "fingerprint_mismatch"
            ? { outcome: "idempotency_mismatch" }
            : { outcome: "idempotency_in_flight" };
        }
        claimId = claim.claimId;
      }

      // Serialize on the PARENT application row, before reading the head.
      //
      // Review #83, P1: locking the head cannot serialize a candidate's first
      // decision, because there is no head row yet and `FOR UPDATE` cannot
      // lock a row that does not exist. Two first-time transactions both read
      // no head, both inserted a NULL predecessor, and 0020_candidate_decisions.sql's partial unique
      // index excludes NULLs by its own predicate, so both committed. The
      // result was two roots and two current states, with a later read
      // arbitrarily picking one by timestamp.
      //
      // The application row always exists (candidate_decisions has a foreign
      // key to it), so this lock always has something to take, which is
      // precisely what the head lock could not guarantee. Scoped by
      // organization_id as well so a guessed application_id from another
      // tenant cannot be used to take a lock here.
      const application = await client.query<{ application_id: string }>(
        `SELECT application_id
           FROM "${schema}".applications
          WHERE organization_id = $1 AND application_id = $2
          FOR UPDATE`,
        [input.organizationId, input.applicationId]
      );
      if (application.rows[0] === undefined) {
        // Same reasoning: no action performed, so no claim should persist.
        await client.query("ROLLBACK");
        return { outcome: "no_such_application" };
      }

      const head = await client.query<{ decision_id: string }>(
        `SELECT d.decision_id
           FROM "${schema}".candidate_decisions d
          WHERE d.organization_id = $1
            AND d.application_id = $2
            AND NOT EXISTS (
              SELECT 1 FROM "${schema}".candidate_decisions s
               WHERE s.supersedes_decision_id = d.decision_id
            )
          ORDER BY d.decided_at DESC, d.decision_id DESC
          LIMIT 1`,
        [input.organizationId, input.applicationId]
      );
      const supersededId = head.rows[0]?.decision_id;

      const inserted = await client.query<{ decision_id: string }>(
        `INSERT INTO "${schema}".candidate_decisions
           (organization_id, application_id, decision, rationale, decided_by_user_id, supersedes_decision_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (supersedes_decision_id)
           WHERE supersedes_decision_id IS NOT NULL DO NOTHING
         RETURNING decision_id`,
        [
          input.organizationId,
          input.applicationId,
          input.decision,
          input.rationale,
          input.decidedByUserId,
          supersededId ?? null
        ]
      );
      const decisionId = inserted.rows[0]?.decision_id;
      if (decisionId === undefined) {
        // Nothing was recorded, so the claim must not survive either: the
        // ROLLBACK discards it and the client may retry the same key.
        await client.query("ROLLBACK");
        return { outcome: "superseded" };
      }

      const result: CandidateDecisionResult =
        supersededId === undefined
          ? { outcome: "recorded", decisionId }
          : { outcome: "recorded", decisionId, supersededId };
      if (claimId !== undefined) {
        // In the same transaction as the insert above. This is the line whose
        // absence from the transaction was the defect.
        await completeOnClient(client, schema, claimId, 201, {
          decisionId,
          ...(supersededId === undefined ? {} : { supersededDecisionId: supersededId })
        });
      }
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
  }
}

/** Every decision about one candidate, oldest first. */
export async function listCandidateDecisionsForApplication(
  databaseUrl: string,
  schema: string,
  organizationId: string,
  applicationId: string
): Promise<readonly CandidateDecision[]> {
  assertSafeSchema(schema);
  const client = await acquireConnection(databaseUrl);
  try {
    const result = await client.query<{
      decision_id: string;
      organization_id: string;
      application_id: string;
      decision: CandidateDecisionKind;
      rationale: string;
      decided_by_user_id: string;
      supersedes_decision_id: string | null;
      decided_at: Date;
    }>(
      `SELECT decision_id, organization_id, application_id, decision, rationale,
              decided_by_user_id, supersedes_decision_id, decided_at
         FROM "${schema}".candidate_decisions
        WHERE organization_id = $1 AND application_id = $2
        ORDER BY decided_at, decision_id`,
      [organizationId, applicationId]
    );
    return result.rows.map((row) => ({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      decisionId: row.decision_id,
      organizationId: row.organization_id,
      applicationId: row.application_id,
      decision: row.decision,
      rationale: row.rationale,
      decidedByUserId: row.decided_by_user_id,
      ...(row.supersedes_decision_id === null ? {} : { supersedesDecisionId: row.supersedes_decision_id }),
      decidedAt: row.decided_at.toISOString()
    }));
  } finally {
    client.release();
  }
}

// ---- AF-102: durable evidence-extraction jobs ----

interface EvidenceExtractionJobRow {
  readonly job_id: string;
  readonly organization_id: string;
  readonly role_id: string;
  readonly application_id: string;
  readonly source_intake_id: string;
  readonly rubric_id: string;
  readonly workflow_version: string;
  readonly enqueue_generation: string;
  readonly state: EvidenceExtractionJob["state"];
  readonly enqueued_at: Date;
  readonly available_at: Date;
  readonly started_at: Date | null;
  readonly completed_at: Date | null;
  readonly failed_at: Date | null;
  readonly attempt_count: number;
  readonly max_attempts: number;
  readonly lease_owner: string | null;
  readonly lease_expires_at: Date | null;
  readonly failure_code: string | null;
  readonly updated_at: Date;
}

const EVIDENCE_EXTRACTION_JOB_COLUMNS =
  "job_id, organization_id, role_id, application_id, source_intake_id, rubric_id, workflow_version, " +
  "enqueue_generation, state, enqueued_at, available_at, started_at, completed_at, failed_at, attempt_count, max_attempts, " +
  "lease_owner, lease_expires_at, failure_code, updated_at";

function rowToEvidenceExtractionJob(row: EvidenceExtractionJobRow): EvidenceExtractionJob {
  return {
    jobId: row.job_id,
    organizationId: row.organization_id,
    roleId: row.role_id,
    applicationId: row.application_id,
    sourceIntakeId: row.source_intake_id,
    rubricId: row.rubric_id,
    workflowVersion: row.workflow_version,
    state: row.state,
    enqueuedAt: row.enqueued_at.toISOString(),
    availableAt: row.available_at.toISOString(),
    ...(row.started_at === null ? {} : { startedAt: row.started_at.toISOString() }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at.toISOString() }),
    ...(row.failed_at === null ? {} : { failedAt: row.failed_at.toISOString() }),
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    ...(row.lease_owner === null ? {} : { leaseOwner: row.lease_owner }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at.toISOString() }),
    ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
    updatedAt: row.updated_at.toISOString()
  };
}

function assertWorkerId(workerId: string): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(workerId)) {
    throw new Error("workerId must contain only safe machine-identity characters");
  }
}

function assertClaimAttempt(attemptCount: number): void {
  if (!Number.isInteger(attemptCount) || attemptCount < 1) {
    throw new Error("attemptCount must identify a positive claimed attempt");
  }
}

function assertFailureCode(failureCode: string): void {
  if (!/^[a-z][a-z0-9_]{0,63}$/u.test(failureCode)) {
    throw new Error("failureCode must be a bounded machine-readable code");
  }
}

export interface EnqueueEvidenceExtractionJobInput {
  readonly organizationId: string;
  readonly roleId: string;
  readonly applicationId: string;
  readonly sourceIntakeId: string;
  readonly rubricId: string;
  readonly workflowVersion: string;
  readonly maxAttempts: number;
  readonly now?: Date;
}

export type EnqueueEvidenceExtractionJobOutcome =
  | { readonly outcome: "enqueued" | "requeued" | "replayed"; readonly job: EvidenceExtractionJob }
  | { readonly outcome: "not_eligible" }
  | { readonly outcome: "source_conflict" };

/**
 * One production enqueue boundary. The eligibility query proves, in the same
 * transaction, that application, canonical document and published rubric all
 * belong to the same tenant and role, then binds the first accepted source.
 */
export async function enqueueEvidenceExtractionJob(
  databaseUrl: string,
  schema: string,
  input: EnqueueEvidenceExtractionJobInput
): Promise<EnqueueEvidenceExtractionJobOutcome> {
  assertSafeSchema(schema);
  if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) {
    throw new Error("maxAttempts must be a positive integer");
  }
  // Production enqueue timestamps come from PostgreSQL so queue-age and job
  // ordering are not affected by web/DB host clock skew. Tests may inject a
  // deterministic timestamp through the existing seam.
  const requestedEnqueueAt = input.now ?? null;
  const client = await acquireConnection(databaseUrl);
  try {
    await client.query("BEGIN");
    try {
      // Existing lifecycle writers lock job -> application. Follow the same
      // order when this logical job already exists so enqueue cannot deadlock
      // a completion while resetting or replaying it.
      const preexisting = await client.query<EvidenceExtractionJobRow>(
        `SELECT ${EVIDENCE_EXTRACTION_JOB_COLUMNS}
           FROM "${schema}".evidence_extraction_jobs
          WHERE organization_id = $1 AND application_id = $2 AND source_intake_id = $3
            AND rubric_id = $4 AND workflow_version = $5
          FOR UPDATE`,
        [input.organizationId, input.applicationId, input.sourceIntakeId, input.rubricId, input.workflowVersion]
      );
      const eligibility = await client.query<{ evidence_source_intake_id: string | null }>(
        `SELECT a.evidence_source_intake_id
           FROM "${schema}".applications a
           JOIN "${schema}".file_intakes f
             ON f.intake_id = $4 AND f.organization_id = a.organization_id AND f.role_id = a.role_id
           JOIN "${schema}".canonical_text_extractions c ON c.intake_id = f.intake_id
           JOIN "${schema}".rubrics r
             ON r.rubric_id = $5 AND r.role_id = a.role_id AND r.status = 'published'
          WHERE a.application_id = $3 AND a.organization_id = $1 AND a.role_id = $2
            AND f.status = 'validated'
            AND f.sniffed_mime_type IN ('application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
          FOR UPDATE OF a`,
        [input.organizationId, input.roleId, input.applicationId, input.sourceIntakeId, input.rubricId]
      );
      const eligible = eligibility.rows[0];
      if (eligible === undefined) {
        await client.query("ROLLBACK");
        return { outcome: "not_eligible" };
      }
      if (
        eligible.evidence_source_intake_id !== null &&
        eligible.evidence_source_intake_id !== input.sourceIntakeId
      ) {
        await client.query("ROLLBACK");
        return { outcome: "source_conflict" };
      }
      if (eligible.evidence_source_intake_id === null) {
        await client.query(
          `UPDATE "${schema}".applications
              SET evidence_source_intake_id = $2
            WHERE application_id = $1`,
          [input.applicationId, input.sourceIntakeId]
        );
      }

      // If no row existed before the application lock, check again after it:
      // a concurrent first enqueue may have committed while we waited.
      const existingRow = preexisting.rows[0] ?? (
        await client.query<EvidenceExtractionJobRow>(
          `SELECT ${EVIDENCE_EXTRACTION_JOB_COLUMNS}
             FROM "${schema}".evidence_extraction_jobs
            WHERE organization_id = $1 AND application_id = $2 AND source_intake_id = $3
              AND rubric_id = $4 AND workflow_version = $5
            FOR UPDATE`,
          [
            input.organizationId,
            input.applicationId,
            input.sourceIntakeId,
            input.rubricId,
            input.workflowVersion
          ]
        )
      ).rows[0];
      if (existingRow !== undefined) {
        if (existingRow.state === "failed") {
          const requeued = await client.query<EvidenceExtractionJobRow>(
            `WITH next_enqueue AS (
               SELECT COALESCE(MAX(enqueue_generation), 0) + 1 AS next_generation,
                      COALESCE($2::timestamptz, clock_timestamp()) AS next_enqueued_at
                 FROM "${schema}".evidence_extraction_jobs
                WHERE organization_id = $4 AND application_id = $5
             )
             UPDATE "${schema}".evidence_extraction_jobs AS job
                SET state = 'ready',
                    enqueue_generation = next_enqueue.next_generation,
                    enqueued_at = next_enqueue.next_enqueued_at,
                    available_at = next_enqueue.next_enqueued_at,
                    started_at = NULL, completed_at = NULL, failed_at = NULL,
                    attempt_count = 0, max_attempts = $3,
                    lease_owner = NULL, lease_expires_at = NULL,
                    failure_code = NULL, updated_at = next_enqueue.next_enqueued_at
               FROM next_enqueue
              WHERE job.job_id = $1
            RETURNING ${EVIDENCE_EXTRACTION_JOB_COLUMNS}`,
            [
              existingRow.job_id,
              requestedEnqueueAt,
              input.maxAttempts,
              input.organizationId,
              input.applicationId
            ]
          );
          const row = requeued.rows[0];
          if (row === undefined) throw new Error("failed evidence-extraction job could not be requeued");
          await client.query("COMMIT");
          return { outcome: "requeued", job: rowToEvidenceExtractionJob(row) };
        }
        await client.query("COMMIT");
        return { outcome: "replayed", job: rowToEvidenceExtractionJob(existingRow) };
      }

      const inserted = await client.query<EvidenceExtractionJobRow>(
        `WITH next_enqueue AS (
           SELECT COALESCE(MAX(enqueue_generation), 0) + 1 AS enqueue_generation,
                  COALESCE($8::timestamptz, clock_timestamp()) AS enqueued_at
             FROM "${schema}".evidence_extraction_jobs
            WHERE organization_id = $1 AND application_id = $3
         )
         INSERT INTO "${schema}".evidence_extraction_jobs
           (organization_id, role_id, application_id, source_intake_id, rubric_id,
            workflow_version, max_attempts, enqueue_generation,
            enqueued_at, available_at, updated_at)
         SELECT $1, $2, $3, $4, $5, $6, $7, next_enqueue.enqueue_generation,
                next_enqueue.enqueued_at, next_enqueue.enqueued_at, next_enqueue.enqueued_at
           FROM next_enqueue
         RETURNING ${EVIDENCE_EXTRACTION_JOB_COLUMNS}`,
        [
          input.organizationId,
          input.roleId,
          input.applicationId,
          input.sourceIntakeId,
          input.rubricId,
          input.workflowVersion,
          input.maxAttempts,
          requestedEnqueueAt
        ]
      );
      const created = inserted.rows[0];
      if (created === undefined) throw new Error("evidence-extraction job insert returned no row");
      await client.query("COMMIT");
      return { outcome: "enqueued", job: rowToEvidenceExtractionJob(created) };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
  }
}

export async function getEvidenceExtractionJob(
  databaseUrl: string,
  schema: string,
  organizationId: string,
  jobId: string
): Promise<EvidenceExtractionJob | undefined> {
  assertSafeSchema(schema);
  const client = await acquireConnection(databaseUrl);
  try {
    const result = await client.query<EvidenceExtractionJobRow>(
      `SELECT ${EVIDENCE_EXTRACTION_JOB_COLUMNS}
         FROM "${schema}".evidence_extraction_jobs
        WHERE organization_id = $1 AND job_id = $2`,
      [organizationId, jobId]
    );
    const row = result.rows[0];
    return row === undefined ? undefined : rowToEvidenceExtractionJob(row);
  } finally {
    client.release();
  }
}

async function lockEvidenceApplication(
  client: ClientBase,
  schema: string,
  job: EvidenceExtractionJobRow
): Promise<void> {
  const application = await client.query(
    `SELECT application_id
       FROM "${schema}".applications
      WHERE organization_id = $1 AND application_id = $2
      FOR UPDATE`,
    [job.organization_id, job.application_id]
  );
  if (application.rows[0] === undefined) {
    throw new Error("evidence-extraction job has no tenant-scoped application");
  }
}

/**
 * A worker result may become current only when no newer logical job has been
 * enqueued for the application. enqueue_generation is allocated while holding
 * the application row lock, so machine precedence is explicit and independent
 * of completion order or host clocks. Application locking is also shared with
 * the correction writer, so a correction racing completion is either observed
 * and preserved, or is appended after the machine result and remains current.
 */
async function recordCurrentMachineOutcomes(
  databaseUrl: string,
  client: ClientBase,
  schema: string,
  job: EvidenceExtractionJobRow,
  outcomes: readonly EvidenceOutcome[],
  runId?: string
): Promise<void> {
  await lockEvidenceApplication(client, schema, job);
  const newerJob = await client.query(
    `SELECT 1
       FROM "${schema}".evidence_extraction_jobs
      WHERE organization_id = $1 AND application_id = $2
        AND enqueue_generation > $3
      LIMIT 1`,
    [job.organization_id, job.application_id, job.enqueue_generation]
  );
  if (newerJob.rows[0] !== undefined) {
    return;
  }
  for (const outcome of outcomes) {
    if (
      outcome.organizationId !== job.organization_id ||
      outcome.candidateId !== job.application_id
    ) {
      throw new Error("machine evidence outcome attribution does not match its job");
    }
    const head = await client.query<{ corrected_by_user_id: string | null }>(
      `SELECT corrected_by_user_id
         FROM "${schema}".evidence_outcomes
        WHERE organization_id = $1 AND application_id = $2 AND criterion_id = $3
        ORDER BY recorded_at DESC, evidence_outcome_id DESC
        LIMIT 1
        FOR UPDATE`,
      [job.organization_id, job.application_id, outcome.criterionId]
    );
    const current = head.rows[0];
    if (
      current?.corrected_by_user_id !== null &&
      current?.corrected_by_user_id !== undefined
    ) {
      continue;
    }
    await recordEvidenceOutcome(databaseUrl, schema, {
      organizationId: job.organization_id,
      applicationId: job.application_id,
      outcome,
      ...(runId === undefined ? {} : { runId })
    }, client);
  }
}

async function recordTerminalEvidenceFailure(
  databaseUrl: string,
  client: ClientBase,
  schema: string,
  job: EvidenceExtractionJobRow,
  failureCode: string,
  runId?: string
): Promise<void> {
  const rubric = await client.query<{ criteria: readonly RubricCriterion[] }>(
    `SELECT criteria FROM "${schema}".rubrics WHERE rubric_id = $1`,
    [job.rubric_id]
  );
  const criteria = rubric.rows[0]?.criteria;
  if (criteria === undefined) {
    throw new Error("evidence-extraction job has no rubric criteria");
  }
  await recordCurrentMachineOutcomes(
    databaseUrl,
    client,
    schema,
    job,
    buildEvidenceExtractionFailureOutcomes(
      { organizationId: job.organization_id, applicationId: job.application_id },
      criteria.map((criterion) => criterion.criterionId),
      failureCode
    ),
    runId
  );
}

export interface ClaimEvidenceExtractionJobInput {
  readonly workerId: string;
  readonly leaseDurationMs: number;
  readonly now?: Date;
}

export interface ClaimEvidenceExtractionJobOutcome {
  readonly job: EvidenceExtractionJob | undefined;
  /**
   * Jobs made durably terminal by this claim transaction because their last
   * lease expired. The caller may publish one failure signal per transition
   * after this function returns; no signal is owed when the transaction rolls
   * back.
   */
  readonly exhaustedLeaseFailures: number;
}

async function resolveQueueClock(
  client: ClientBase,
  requestedNow: Date | undefined
): Promise<Date | string> {
  if (requestedNow !== undefined) {
    return requestedNow;
  }
  // Keep PostgreSQL's sub-millisecond precision. Parsing this as a JavaScript
  // Date truncates microseconds and can make an immediate completion appear
  // earlier than started_at under load.
  const result = await client.query<{ current_time: string }>(
    "SELECT clock_timestamp()::text AS current_time"
  );
  const currentTime = result.rows[0]?.current_time;
  if (currentTime === undefined) {
    throw new Error("database clock query returned no row");
  }
  return currentTime;
}

export async function claimEvidenceExtractionJob(
  databaseUrl: string,
  schema: string,
  input: ClaimEvidenceExtractionJobInput
): Promise<ClaimEvidenceExtractionJobOutcome> {
  assertSafeSchema(schema);
  assertWorkerId(input.workerId);
  if (!Number.isInteger(input.leaseDurationMs) || input.leaseDurationMs < 1) {
    throw new Error("leaseDurationMs must be a positive integer");
  }
  const client = await acquireConnection(databaseUrl);
  try {
    await client.query("BEGIN");
    try {
      // Enqueue availability is stamped by PostgreSQL in production. Use the
      // same clock for an immediate claim so host skew cannot make a freshly
      // enqueued job appear to be from the future.
      const now = await resolveQueueClock(client, input.now);
      const exhausted = await client.query<EvidenceExtractionJobRow>(
        `UPDATE "${schema}".evidence_extraction_jobs
            SET state = 'failed', failed_at = $1, lease_owner = NULL, lease_expires_at = NULL,
                failure_code = 'lease_expired_exhausted', updated_at = $1
          WHERE state = 'running' AND lease_expires_at <= $1 AND attempt_count >= max_attempts
        RETURNING ${EVIDENCE_EXTRACTION_JOB_COLUMNS}`,
        [now]
      );
      for (const failedJob of [...exhausted.rows].sort((a, b) =>
        a.application_id.localeCompare(b.application_id) || a.job_id.localeCompare(b.job_id)
      )) {
        await recordTerminalEvidenceFailure(
          databaseUrl,
          client,
          schema,
          failedJob,
          "lease_expired_exhausted"
        );
      }
      const result = await client.query<EvidenceExtractionJobRow>(
        `WITH candidate AS (
           SELECT job_id
             FROM "${schema}".evidence_extraction_jobs
            WHERE (
              (state = 'ready' AND available_at <= $1)
              OR (state = 'running' AND lease_expires_at <= $1)
            )
              AND attempt_count < max_attempts
            ORDER BY enqueued_at, job_id
            FOR UPDATE SKIP LOCKED
            LIMIT 1
         )
         UPDATE "${schema}".evidence_extraction_jobs j
            SET state = 'running',
                started_at = COALESCE(j.started_at, $1),
                attempt_count = j.attempt_count + 1,
                lease_owner = $2,
                lease_expires_at = $1 + ($3::bigint * interval '1 millisecond'),
                updated_at = $1
           FROM candidate
          WHERE j.job_id = candidate.job_id
         RETURNING j.${EVIDENCE_EXTRACTION_JOB_COLUMNS.split(", ").join(", j.")}`,
        [now, input.workerId, input.leaseDurationMs]
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      return {
        job: row === undefined ? undefined : rowToEvidenceExtractionJob(row),
        exhaustedLeaseFailures: exhausted.rows.length
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
  }
}

export interface EvidenceExtractionJobContext {
  readonly job: EvidenceExtractionJob;
  readonly pages: readonly CanonicalTextPage[];
  readonly quality: CanonicalTextQuality;
  readonly rubricVersion: number;
  readonly criteria: readonly RubricCriterion[];
}

export async function getEvidenceExtractionJobContext(
  databaseUrl: string,
  schema: string,
  organizationId: string,
  jobId: string
): Promise<EvidenceExtractionJobContext | undefined> {
  assertSafeSchema(schema);
  const client = await acquireConnection(databaseUrl);
  try {
    const result = await client.query<EvidenceExtractionJobRow & {
      pages: readonly CanonicalTextPage[];
      quality: CanonicalTextQuality;
      rubric_version: number;
      criteria: readonly RubricCriterion[];
    }>(
      `SELECT j.${EVIDENCE_EXTRACTION_JOB_COLUMNS.split(", ").join(", j.")},
              c.pages, c.quality, r.version AS rubric_version, r.criteria
         FROM "${schema}".evidence_extraction_jobs j
         JOIN "${schema}".canonical_text_extractions c ON c.intake_id = j.source_intake_id
         JOIN "${schema}".rubrics r ON r.rubric_id = j.rubric_id AND r.status = 'published'
        WHERE j.organization_id = $1 AND j.job_id = $2`,
      [organizationId, jobId]
    );
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : {
          job: rowToEvidenceExtractionJob(row),
          pages: row.pages,
          quality: row.quality,
          rubricVersion: row.rubric_version,
          criteria: row.criteria
        };
  } finally {
    client.release();
  }
}

export async function renewEvidenceExtractionJobLease(
  databaseUrl: string,
  schema: string,
  input: {
    readonly organizationId: string;
    readonly jobId: string;
    readonly workerId: string;
    readonly attemptCount: number;
    readonly leaseDurationMs: number;
    readonly now?: Date;
  }
): Promise<boolean> {
  assertSafeSchema(schema);
  assertWorkerId(input.workerId);
  assertClaimAttempt(input.attemptCount);
  const client = await acquireConnection(databaseUrl);
  try {
    const now = await resolveQueueClock(client, input.now);
    const result = await client.query(
      `UPDATE "${schema}".evidence_extraction_jobs
          SET lease_expires_at = $5 + ($6::bigint * interval '1 millisecond'), updated_at = $5
        WHERE organization_id = $1 AND job_id = $2 AND state = 'running' AND lease_owner = $3
          AND attempt_count = $4 AND lease_expires_at > $5`,
      [input.organizationId, input.jobId, input.workerId, input.attemptCount, now, input.leaseDurationMs]
    );
    return result.rowCount === 1;
  } finally {
    client.release();
  }
}

export interface EvidenceExtractionRunMetadata {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly extractionSchemaVersion: string;
  readonly extractionSchemaName: string;
  readonly rubricVersion: string;
}

async function lockOwnedJob(
  client: ClientBase,
  schema: string,
  organizationId: string,
  jobId: string,
  workerId: string,
  attemptCount: number,
  now: Date | string
): Promise<EvidenceExtractionJobRow | undefined> {
  const result = await client.query<EvidenceExtractionJobRow>(
    `SELECT ${EVIDENCE_EXTRACTION_JOB_COLUMNS}
       FROM "${schema}".evidence_extraction_jobs
      WHERE organization_id = $1 AND job_id = $2 AND state = 'running' AND lease_owner = $3
        AND attempt_count = $4 AND lease_expires_at > $5
      FOR UPDATE`,
    [organizationId, jobId, workerId, attemptCount, now]
  );
  return result.rows[0];
}

export async function completeEvidenceExtractionJob(
  databaseUrl: string,
  schema: string,
  input: {
    readonly organizationId: string;
    readonly jobId: string;
    readonly workerId: string;
    readonly attemptCount: number;
    readonly outcomes: readonly EvidenceOutcome[];
    readonly run?: EvidenceExtractionRunMetadata;
    readonly now?: Date;
  }
): Promise<"completed" | "lease_lost"> {
  assertSafeSchema(schema);
  assertWorkerId(input.workerId);
  assertClaimAttempt(input.attemptCount);
  const client = await acquireConnection(databaseUrl);
  try {
    await client.query("BEGIN");
    try {
      const now = await resolveQueueClock(client, input.now);
      const job = await lockOwnedJob(
        client,
        schema,
        input.organizationId,
        input.jobId,
        input.workerId,
        input.attemptCount,
        now
      );
      if (job === undefined) {
        await client.query("ROLLBACK");
        return "lease_lost";
      }
      const runId = input.run === undefined
        ? undefined
        : await recordEvidenceExtractionRun(databaseUrl, schema, {
            organizationId: input.organizationId,
            entityType: "application",
            entityId: job.application_id,
            provider: input.run.provider,
            model: input.run.model,
            promptVersion: input.run.promptVersion,
            extractionSchemaVersion: input.run.extractionSchemaVersion,
            extractionSchemaName: input.run.extractionSchemaName,
            rubricVersion: input.run.rubricVersion
          }, client);
      await recordCurrentMachineOutcomes(databaseUrl, client, schema, job, input.outcomes, runId);
      await client.query(
        `UPDATE "${schema}".evidence_extraction_jobs
            SET state = 'completed', completed_at = $2, failed_at = NULL,
                lease_owner = NULL, lease_expires_at = NULL, failure_code = NULL, updated_at = $2
          WHERE job_id = $1`,
        [input.jobId, now]
      );
      await client.query("COMMIT");
      return "completed";
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
  }
}

export async function retryOrFailEvidenceExtractionJob(
  databaseUrl: string,
  schema: string,
  input: {
    readonly organizationId: string;
    readonly jobId: string;
    readonly workerId: string;
    readonly attemptCount: number;
    readonly failureCode: string;
    readonly retryable: boolean;
    readonly availableAt: Date;
    readonly run?: EvidenceExtractionRunMetadata;
    readonly now?: Date;
  }
): Promise<"retrying" | "failed" | "lease_lost"> {
  assertSafeSchema(schema);
  assertWorkerId(input.workerId);
  assertClaimAttempt(input.attemptCount);
  assertFailureCode(input.failureCode);
  const client = await acquireConnection(databaseUrl);
  try {
    await client.query("BEGIN");
    try {
      const now = await resolveQueueClock(client, input.now);
      const job = await lockOwnedJob(
        client,
        schema,
        input.organizationId,
        input.jobId,
        input.workerId,
        input.attemptCount,
        now
      );
      if (job === undefined) {
        await client.query("ROLLBACK");
        return "lease_lost";
      }
      const runId = input.run === undefined
        ? undefined
        : await recordEvidenceExtractionRun(databaseUrl, schema, {
          organizationId: input.organizationId,
          entityType: "application",
          entityId: job.application_id,
          provider: input.run.provider,
          model: input.run.model,
          promptVersion: input.run.promptVersion,
          extractionSchemaVersion: input.run.extractionSchemaVersion,
          extractionSchemaName: input.run.extractionSchemaName,
          rubricVersion: input.run.rubricVersion
        }, client);
      const retry = input.retryable && job.attempt_count < job.max_attempts;
      if (!retry) {
        await recordTerminalEvidenceFailure(
          databaseUrl,
          client,
          schema,
          job,
          input.failureCode,
          runId
        );
      }
      await client.query(
        `UPDATE "${schema}".evidence_extraction_jobs
            SET state = $2::text,
                available_at = CASE WHEN $2::text = 'ready' THEN $3::timestamptz ELSE available_at END,
                failed_at = CASE WHEN $2::text = 'failed' THEN $4::timestamptz ELSE NULL::timestamptz END,
                lease_owner = NULL, lease_expires_at = NULL,
                failure_code = $5, updated_at = $4
          WHERE job_id = $1`,
        [input.jobId, retry ? "ready" : "failed", input.availableAt, now, input.failureCode]
      );
      await client.query("COMMIT");
      return retry ? "retrying" : "failed";
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
  }
}

/** Operator controls (kill switch/budget cap) defer without consuming retries. */
export async function deferEvidenceExtractionJob(
  databaseUrl: string,
  schema: string,
  input: {
    readonly organizationId: string;
    readonly jobId: string;
    readonly workerId: string;
    readonly attemptCount: number;
    readonly failureCode: string;
    readonly availableAt: Date;
    readonly now?: Date;
  }
): Promise<boolean> {
  assertSafeSchema(schema);
  assertWorkerId(input.workerId);
  assertClaimAttempt(input.attemptCount);
  assertFailureCode(input.failureCode);
  const client = await acquireConnection(databaseUrl);
  try {
    const now = await resolveQueueClock(client, input.now);
    const result = await client.query(
      `UPDATE "${schema}".evidence_extraction_jobs
          SET state = 'ready', available_at = $6, attempt_count = GREATEST(0, attempt_count - 1),
              lease_owner = NULL, lease_expires_at = NULL, failure_code = $5, updated_at = $7
        WHERE organization_id = $1 AND job_id = $2 AND state = 'running' AND lease_owner = $3
          AND attempt_count = $4 AND lease_expires_at > $7`,
      [
        input.organizationId,
        input.jobId,
        input.workerId,
        input.attemptCount,
        input.failureCode,
        input.availableAt,
        now
      ]
    );
    return result.rowCount === 1;
  } finally {
    client.release();
  }
}

export async function recordWorkerHeartbeat(
  databaseUrl: string,
  schema: string,
  workerId: string,
  now: Date = new Date()
): Promise<void> {
  assertSafeSchema(schema);
  assertWorkerId(workerId);
  const client = await acquireConnection(databaseUrl);
  try {
    await client.query(
      `INSERT INTO "${schema}".worker_heartbeats (worker_id, last_seen_at)
       VALUES ($1, $2)
       ON CONFLICT (worker_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at`,
      [workerId, now]
    );
  } finally {
    client.release();
  }
}

export async function getEvidenceExtractionQueueMonitoringSnapshot(
  databaseUrl: string,
  schema: string,
  now: Date = new Date()
): Promise<EvidenceExtractionQueueMonitoringSnapshot> {
  assertSafeSchema(schema);
  const client = await acquireConnection(databaseUrl);
  try {
    const result = await client.query<{
      oldest_ready_at: Date | null;
      ready_jobs: string;
      running_jobs: string;
      failed_jobs: string;
      completed_jobs: string;
      total_attempts: string;
      last_heartbeat_at: Date | null;
    }>(
      `SELECT
         MIN(enqueued_at) FILTER (
           WHERE (state = 'ready' AND available_at <= $1)
              OR (state = 'running' AND lease_expires_at <= $1)
         ) AS oldest_ready_at,
         COUNT(*) FILTER (
           WHERE (state = 'ready' AND available_at <= $1)
              OR (state = 'running' AND lease_expires_at <= $1)
         )::text AS ready_jobs,
         COUNT(*) FILTER (WHERE state = 'running' AND lease_expires_at > $1)::text AS running_jobs,
         COUNT(*) FILTER (WHERE state = 'failed')::text AS failed_jobs,
         COUNT(*) FILTER (WHERE state = 'completed')::text AS completed_jobs,
         COALESCE(SUM(attempt_count), 0)::text AS total_attempts,
         (SELECT MAX(last_seen_at) FROM "${schema}".worker_heartbeats) AS last_heartbeat_at
       FROM "${schema}".evidence_extraction_jobs`,
      [now]
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("queue monitoring query returned no row");
    }
    const oldestReadyAgeMs = row.oldest_ready_at === null
      ? null
      : Math.max(0, now.getTime() - row.oldest_ready_at.getTime());
    const heartbeatAgeMs = row.last_heartbeat_at === null
      ? null
      : Math.max(0, now.getTime() - row.last_heartbeat_at.getTime());
    return {
      observedAt: now.toISOString(),
      oldestReadyAgeMs,
      readyJobs: Number(row.ready_jobs),
      runningJobs: Number(row.running_jobs),
      failedJobs: Number(row.failed_jobs),
      completedJobs: Number(row.completed_jobs),
      totalAttempts: Number(row.total_attempts),
      lastHeartbeatAt: row.last_heartbeat_at?.toISOString() ?? null,
      heartbeatAgeMs
    };
  } finally {
    client.release();
  }
}

/**
 * AF-51: proves the decision log is the only place a candidate's status
 * can change, and that every row in it names a person and a reason.
 */
export interface ConcurrentFirstDecisionObservations {
  /** How many of the two racing first decisions were accepted as "recorded". */
  readonly recorded: number;
  /** How many were told a concurrent writer won. */
  readonly superseded: number;
  /** Rows whose supersedes_decision_id is NULL. Must be exactly 1. */
  readonly rootCount: number;
  /** Rows nothing supersedes. Must be exactly 1. */
  readonly headCount: number;
  /** Total rows written by the race. */
  readonly totalDecisions: number;
}

/**
 * Review #83, P1. The existing integrity probe starts after a first decision
 * exists, so it exercises the head lock and cannot reach this case at all.
 *
 * With no decisions yet there is no head row, and `FOR UPDATE` cannot lock a
 * row that does not exist. Two first-time transactions both read no head,
 * both insert a NULL predecessor, and 0020_candidate_decisions.sql's partial unique index excludes
 * NULLs by its own predicate, so both commit: two roots, two current states,
 * and a later read that picks one by timestamp while the other sits
 * unchained.
 *
 * Genuine concurrency matters here. A sequential pair cannot reproduce it,
 * because the second call sees the first one's committed head and supersedes
 * it correctly, which is exactly why the defect survived review. These two
 * calls are fired without awaiting the first.
 */
export async function assertConcurrentFirstDecisionHasOneRoot(
  databaseUrl: string
): Promise<ConcurrentFirstDecisionObservations> {
  const suffix = randomBytes(4).toString("hex");
  const schema = `first_decision_probe_${suffix}`;
  const organizationId = "11111111-1111-4111-8111-111111111111";
  const admin = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });

  try {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    // Same list the integrity probe loads, plus 0021_single_decision_root.sql. Trimming it is not
    // safe: 0020_candidate_decisions.sql's composite foreign key onto applications needs the unique
    // constraint a later migration adds, and omitting it fails at CREATE
    // TABLE with "no unique constraint matching given keys".
    for (const migration of [
      "0002_organizations_users_memberships.sql",
      "0006_evidence_extraction_runs.sql",
      "0009_roles.sql",
      "0013_file_intakes.sql",
      "0016_applications_and_import_finalization.sql",
      "0017_evidence_outcomes.sql",
      "0018_evidence_corrections.sql",
      "0019_correction_attribution.sql",
      "0020_candidate_decisions.sql",
      "0021_single_decision_root.sql"
    ]) {
      await admin.query(readFileSync(join(MIGRATIONS_DIRECTORY, migration), "utf8"));
    }
    await admin.query(`INSERT INTO organizations (organization_id, name) VALUES ($1, 'A')`, [organizationId]);
    const user = await admin.query<{ user_id: string }>(
      `INSERT INTO users (email, display_name) VALUES ($1, 'Decider') RETURNING user_id`,
      [`first_${suffix}@acme.test`]
    );
    const userId = user.rows[0]?.user_id;
    if (userId === undefined) {
      throw new Error("probe could not create a user");
    }
    await admin.query(`INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'recruiter')`, [
      organizationId,
      userId
    ]);
    const role = await admin.query<{ role_id: string }>(
      `INSERT INTO roles (organization_id, title, created_by_user_id) VALUES ($1, 'R', $2) RETURNING role_id`,
      [organizationId, userId]
    );
    const intake = await admin.query<{ intake_id: string }>(
      `INSERT INTO file_intakes (organization_id, role_id, storage_key, declared_filename, declared_mime_type, created_by_user_id)
       VALUES ($1, $2, $3, 'a.csv', 'text/csv', $4) RETURNING intake_id`,
      [organizationId, role.rows[0]?.role_id, `first/${suffix}.csv`, userId]
    );
    const application = await admin.query<{ application_id: string }>(
      `INSERT INTO applications (organization_id, role_id, intake_id, source_row_number, candidate_full_name, candidate_email)
       VALUES ($1, $2, $3, 1, 'Casey', $4) RETURNING application_id`,
      [organizationId, role.rows[0]?.role_id, intake.rows[0]?.intake_id, `casey_${suffix}@acme.test`]
    );
    const applicationId = application.rows[0]?.application_id;
    if (applicationId === undefined) {
      throw new Error("probe could not create an application");
    }

    // Both fired before either is awaited, on separate connections, so they
    // genuinely overlap rather than running back to back.
    const attempt = (decision: "advance" | "hold"): Promise<CandidateDecisionResult> =>
      recordCandidateDecision(databaseUrl, schema, {
        organizationId,
        applicationId,
        decision,
        rationale: `first decision via ${decision}`,
        decidedByUserId: userId
      });
    const [first, second] = await Promise.all([attempt("advance"), attempt("hold")]);

    const roots = await admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "${schema}".candidate_decisions
        WHERE application_id = $1 AND supersedes_decision_id IS NULL`,
      [applicationId]
    );
    const heads = await admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "${schema}".candidate_decisions d
        WHERE d.application_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM "${schema}".candidate_decisions s WHERE s.supersedes_decision_id = d.decision_id
          )`,
      [applicationId]
    );
    const total = await admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "${schema}".candidate_decisions WHERE application_id = $1`,
      [applicationId]
    );
    const outcomes = [first.outcome, second.outcome];

    return {
      recorded: outcomes.filter((outcome) => outcome === "recorded").length,
      superseded: outcomes.filter((outcome) => outcome === "superseded").length,
      rootCount: Number(roots.rows[0]?.count ?? "-1"),
      headCount: Number(heads.rows[0]?.count ?? "-1"),
      totalDecisions: Number(total.rows[0]?.count ?? "-1")
    };
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}

export interface IdempotencyAtomicityObservations {
  /** After a fault inside the writer's transaction. */
  readonly faultedThrew: boolean;
  readonly decisionsAfterFault: number;
  readonly claimRowsAfterFault: number;
  /** Retrying the SAME key once the fault is gone. */
  readonly retryAfterFaultOutcome: string;
  readonly decisionsAfterRetry: number;
  readonly claimStatusAfterRetry: number | null;
  /** Retrying once more, as a client would after losing the 201 in transit. */
  readonly replayOutcome: string;
  readonly replayStatus: number;
  readonly replayBodyMatches: boolean;
  readonly decisionsAfterReplay: number;
  /**
   * What a deferred constraint trigger, firing at COMMIT time, saw in
   * idempotent_requests for this key. 201 means the completion was already
   * inside the transaction; null means it was still to come afterwards.
   */
  readonly completionStatusAtCommit: number | null;
  /**
   * The same commit-time observation for correctEvidenceOutcome. Both routes
   * were named in the finding, and a fix proven on only one of them is the
   * pattern this whole round exists to stop repeating.
   */
  readonly correctionCompletionStatusAtCommit: number | null;
  readonly correctionReplayOutcome: string;
  readonly correctionRevisions: number;
  /** The old three-call shape, reproduced deliberately as a negative control. */
  readonly legacyDecisionsAfterFault: number;
  readonly legacySameKeyRetry: string;
  readonly legacyDecisionsAfterNewKeyRetry: number;
}

/**
 * Review #83, P1: the fault-in-the-window regression.
 *
 * The window was between "the decision committed" and "the idempotency
 * response was stored", when those were two transactions on two connections.
 * A process or database fault there left the key at response_status = NULL
 * permanently: every same-key retry answered in_flight, and a client that
 * gave up and retried with a fresh key recorded a SECOND human decision.
 *
 * The fault is injected with an AFTER INSERT trigger on candidate_decisions,
 * which raises inside the writer's own transaction at exactly the point the
 * old shape had already committed. That is the closest deterministic stand-in
 * for the process dying there: same position in the sequence, same partial
 * work in flight, and unlike killing the backend it lands in the same place
 * on every run.
 *
 * What it proves, in order:
 *   1. A fault in the window leaves NOTHING behind. No decision, and no
 *      claim, because the claim is now in the same transaction as the insert.
 *   2. A retry of the SAME key therefore records cleanly rather than being
 *      told the key is still in progress by a request that no longer exists.
 *   3. A further retry replays the stored 201 verbatim instead of recording
 *      a second decision.
 *   4. The legacy three-call shape, run against the same database, still
 *      wedges and still duplicates. That is the negative control: it is what
 *      this function measures the absence of, so a revert to the old shape
 *      fails here rather than passing quietly.
 */
export async function assertIdempotencyIsAtomicWithTheAction(
  databaseUrl: string
): Promise<IdempotencyAtomicityObservations> {
  const suffix = randomBytes(4).toString("hex");
  const schema = `idem_atomic_probe_${suffix}`;
  const organizationId = "11111111-1111-4111-8111-111111111111";
  const endpoint = "candidate_decisions.record";
  const admin = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });

  try {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    for (const migration of [
      "0002_organizations_users_memberships.sql",
      "0006_evidence_extraction_runs.sql",
      "0009_roles.sql",
      "0013_file_intakes.sql",
      "0016_applications_and_import_finalization.sql",
      "0017_evidence_outcomes.sql",
      "0018_evidence_corrections.sql",
      "0019_correction_attribution.sql",
      "0020_candidate_decisions.sql",
      "0021_single_decision_root.sql",
      "0022_idempotent_requests.sql"
    ]) {
      await admin.query(readFileSync(join(MIGRATIONS_DIRECTORY, migration), "utf8"));
    }
    await admin.query(`INSERT INTO organizations (organization_id, name) VALUES ($1, 'A')`, [organizationId]);
    const user = await admin.query<{ user_id: string }>(
      `INSERT INTO users (email, display_name) VALUES ($1, 'Decider') RETURNING user_id`,
      [`atomic_${suffix}@acme.test`]
    );
    const userId = user.rows[0]?.user_id;
    if (userId === undefined) {
      throw new Error("probe could not create a user");
    }
    await admin.query(`INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'recruiter')`, [
      organizationId,
      userId
    ]);
    const role = await admin.query<{ role_id: string }>(
      `INSERT INTO roles (organization_id, title, created_by_user_id) VALUES ($1, 'R', $2) RETURNING role_id`,
      [organizationId, userId]
    );
    const roleId = role.rows[0]?.role_id;
    const intake = await admin.query<{ intake_id: string }>(
      `INSERT INTO file_intakes (organization_id, role_id, storage_key, declared_filename, declared_mime_type, created_by_user_id)
       VALUES ($1, $2, $3, 'a.csv', 'text/csv', $4) RETURNING intake_id`,
      [organizationId, roleId, `atomic/${suffix}.csv`, userId]
    );
    const intakeId = intake.rows[0]?.intake_id;

    const createApplication = async (rowNumber: number, name: string): Promise<string> => {
      const created = await admin.query<{ application_id: string }>(
        `INSERT INTO applications (organization_id, role_id, intake_id, source_row_number, candidate_full_name, candidate_email)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING application_id`,
        [organizationId, roleId, intakeId, rowNumber, name, `${name.toLowerCase()}_${suffix}@acme.test`]
      );
      const applicationId = created.rows[0]?.application_id;
      if (applicationId === undefined) {
        throw new Error("probe could not create an application");
      }
      return applicationId;
    };

    const countDecisions = async (applicationId: string): Promise<number> => {
      const counted = await admin.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "${schema}".candidate_decisions WHERE application_id = $1`,
        [applicationId]
      );
      return Number(counted.rows[0]?.count ?? "-1");
    };

    // ---- 1 and 2: fault in the window, then retry the same key ----
    const applicationId = await createApplication(1, "Casey");
    const key = `atomic-${suffix}`;
    const payload = { applicationId, decision: "advance" };
    const idempotency: IdempotencyContext = { endpoint, key, payload };
    const decide = (): Promise<CandidateDecisionResult> =>
      recordCandidateDecision(
        databaseUrl,
        schema,
        {
          organizationId,
          applicationId,
          decision: "advance",
          rationale: "atomicity probe",
          decidedByUserId: userId
        },
        idempotency
      );

    await admin.query(
      `CREATE FUNCTION "${schema}".inject_fault() RETURNS trigger LANGUAGE plpgsql AS $fn$
         BEGIN RAISE EXCEPTION 'injected fault inside the idempotency window'; END
       $fn$`
    );
    await admin.query(
      `CREATE TRIGGER inject_fault_after_insert AFTER INSERT ON "${schema}".candidate_decisions
         FOR EACH ROW EXECUTE FUNCTION "${schema}".inject_fault()`
    );

    let faultedThrew = false;
    try {
      await decide();
    } catch {
      faultedThrew = true;
    }
    const decisionsAfterFault = await countDecisions(applicationId);
    const claimsAfterFault = await admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "${schema}".idempotent_requests
        WHERE organization_id = $1 AND endpoint = $2 AND idempotency_key = $3`,
      [organizationId, endpoint, key]
    );

    await admin.query(`DROP TRIGGER inject_fault_after_insert ON "${schema}".candidate_decisions`);

    const retry = await decide();
    const decisionsAfterRetry = await countDecisions(applicationId);
    const claimRow = await admin.query<{ response_status: number | null }>(
      `SELECT response_status FROM "${schema}".idempotent_requests
        WHERE organization_id = $1 AND endpoint = $2 AND idempotency_key = $3`,
      [organizationId, endpoint, key]
    );

    // ---- 3: the client never saw the 201 and sends the same key again ----
    const replay = await decide();
    const decisionsAfterReplay = await countDecisions(applicationId);
    const replayBodyMatches =
      replay.outcome === "replayed" &&
      retry.outcome === "recorded" &&
      JSON.stringify(replay.body) === JSON.stringify({ decisionId: retry.decisionId });

    // ---- 3.5: is the completion INSIDE the transaction, or merely near it? ----
    //
    // The trigger fault above rolls the whole transaction back, so it cannot
    // tell a completion written before COMMIT from one written after: in both
    // shapes nothing survives a fault at the insert. That distinction is the
    // actual fix, so it needs an observation rather than an injected fault.
    //
    // A DEFERRABLE INITIALLY DEFERRED constraint trigger runs at COMMIT, after
    // every statement in the transaction and before the commit completes. It
    // therefore sees exactly the state the transaction is about to make
    // durable. If the completion is in the transaction it reads 201; if the
    // completion happens after COMMIT, as the old shape did, it reads NULL,
    // and that NULL is the window.
    const witnessApplicationId = await createApplication(3, "Avery");
    const witnessKey = `witness-${suffix}`;
    await admin.query(`CREATE TABLE "${schema}".commit_witness (observed_status integer)`);
    await admin.query(
      `CREATE FUNCTION "${schema}".witness_completion() RETURNS trigger LANGUAGE plpgsql AS $fn$
         DECLARE seen integer;
         BEGIN
           SELECT response_status INTO seen FROM "${schema}".idempotent_requests
            WHERE organization_id = NEW.organization_id
              AND endpoint = '${endpoint}'
              AND idempotency_key = '${witnessKey}';
           INSERT INTO "${schema}".commit_witness (observed_status) VALUES (seen);
           RETURN NULL;
         END
       $fn$`
    );
    await admin.query(
      `CREATE CONSTRAINT TRIGGER witness_completion_at_commit
         AFTER INSERT ON "${schema}".candidate_decisions
         DEFERRABLE INITIALLY DEFERRED
         FOR EACH ROW EXECUTE FUNCTION "${schema}".witness_completion()`
    );
    await recordCandidateDecision(
      databaseUrl,
      schema,
      {
        organizationId,
        applicationId: witnessApplicationId,
        decision: "advance",
        rationale: "commit-time witness",
        decidedByUserId: userId
      },
      { endpoint, key: witnessKey, payload: { applicationId: witnessApplicationId, decision: "advance" } }
    );
    await admin.query(`DROP TRIGGER witness_completion_at_commit ON "${schema}".candidate_decisions`);
    const witnessed = await admin.query<{ observed_status: number | null }>(
      `SELECT observed_status FROM "${schema}".commit_witness`
    );

    // ---- 3.6: the same guarantee on the correction writer ----
    const correctionApplicationId = await createApplication(4, "Rowan");
    const criterionId = "postgres";
    const attribution = {
      organizationId,
      candidateId: "44444444-4444-4444-8444-444444444444",
      schemaVersion: CONTRACT_SCHEMA_VERSION
    } as const;
    await recordEvidenceOutcome(databaseUrl, schema, {
      organizationId,
      applicationId: correctionApplicationId,
      outcome: {
        ...attribution,
        kind: "supported",
        criterionId,
        citation: { document: "resume.pdf", pageOrSection: "Experience", offset: 4, quote: "Ran Postgres." }
      }
    });
    const correctionOutcome: EvidenceOutcome = { ...attribution, kind: "not_found", criterionId };
    const correctionKey = `correction-${suffix}`;
    const correctionEndpoint = "evidence_corrections.record";
    await admin.query(`CREATE TABLE "${schema}".correction_commit_witness (observed_status integer)`);
    await admin.query(
      `CREATE FUNCTION "${schema}".witness_correction_completion() RETURNS trigger LANGUAGE plpgsql AS $fn$
         DECLARE seen integer;
         BEGIN
           SELECT response_status INTO seen FROM "${schema}".idempotent_requests
            WHERE organization_id = NEW.organization_id
              AND endpoint = '${correctionEndpoint}'
              AND idempotency_key = '${correctionKey}';
           INSERT INTO "${schema}".correction_commit_witness (observed_status) VALUES (seen);
           RETURN NULL;
         END
       $fn$`
    );
    await admin.query(
      `CREATE CONSTRAINT TRIGGER witness_correction_at_commit
         AFTER INSERT ON "${schema}".evidence_outcomes
         DEFERRABLE INITIALLY DEFERRED
         FOR EACH ROW EXECUTE FUNCTION "${schema}".witness_correction_completion()`
    );
    const correctionIdempotency: IdempotencyContext = {
      endpoint: correctionEndpoint,
      key: correctionKey,
      payload: { applicationId: correctionApplicationId, criterionId, outcome: correctionOutcome }
    };
    const correctionInput: CorrectEvidenceOutcomeInput = {
      organizationId,
      applicationId: correctionApplicationId,
      criterionId,
      outcome: correctionOutcome,
      correctedByUserId: userId,
      reason: "the quote belongs to a different candidate"
    };
    await correctEvidenceOutcome(databaseUrl, schema, correctionInput, correctionIdempotency);
    await admin.query(`DROP TRIGGER witness_correction_at_commit ON "${schema}".evidence_outcomes`);
    const correctionWitnessed = await admin.query<{ observed_status: number | null }>(
      `SELECT observed_status FROM "${schema}".correction_commit_witness
        WHERE observed_status IS NOT NULL OR true ORDER BY observed_status NULLS FIRST LIMIT 1`
    );
    // Retrying the same key must replay rather than append a second
    // correction on top of the first.
    const correctionReplay = await correctEvidenceOutcome(databaseUrl, schema, correctionInput, correctionIdempotency);
    const correctionRevisions = await admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "${schema}".evidence_outcomes WHERE application_id = $1`,
      [correctionApplicationId]
    );

    // ---- 4: negative control, the old three-call shape ----
    // Claim, act and complete on three separate connections, with the
    // process "dying" before the third. This is what the code did before
    // this fix, reproduced here so the difference is measured rather than
    // asserted in a comment.
    const legacyApplicationId = await createApplication(2, "Jordan");
    const legacyKey = `legacy-${suffix}`;
    const legacyPayload = { applicationId: legacyApplicationId, decision: "advance" };
    const legacyClaim = await claimIdempotentRequest(databaseUrl, schema, {
      organizationId,
      endpoint,
      idempotencyKey: legacyKey,
      payload: legacyPayload
    });
    if (legacyClaim.outcome !== "claimed") {
      throw new Error(`probe expected the legacy claim to succeed, got ${legacyClaim.outcome}`);
    }
    await recordCandidateDecision(databaseUrl, schema, {
      organizationId,
      applicationId: legacyApplicationId,
      decision: "advance",
      rationale: "legacy shape, decision commits on its own",
      decidedByUserId: userId
    });
    // completeIdempotentRequest is deliberately NOT called: that is the fault.
    const legacyDecisionsAfterFault = await countDecisions(legacyApplicationId);
    const legacySameKeyRetry = await claimIdempotentRequest(databaseUrl, schema, {
      organizationId,
      endpoint,
      idempotencyKey: legacyKey,
      payload: legacyPayload
    });
    // Wedged on the original key, the client rotates to a fresh one.
    const legacyNewKeyClaim = await claimIdempotentRequest(databaseUrl, schema, {
      organizationId,
      endpoint,
      idempotencyKey: `legacy-rotated-${suffix}`,
      payload: legacyPayload
    });
    if (legacyNewKeyClaim.outcome !== "claimed") {
      throw new Error(`probe expected the rotated legacy key to claim, got ${legacyNewKeyClaim.outcome}`);
    }
    await recordCandidateDecision(databaseUrl, schema, {
      organizationId,
      applicationId: legacyApplicationId,
      decision: "advance",
      rationale: "legacy shape, the duplicate human decision",
      decidedByUserId: userId
    });
    const legacyDecisionsAfterNewKeyRetry = await countDecisions(legacyApplicationId);

    return {
      faultedThrew,
      decisionsAfterFault,
      claimRowsAfterFault: Number(claimsAfterFault.rows[0]?.count ?? "-1"),
      retryAfterFaultOutcome: retry.outcome,
      decisionsAfterRetry,
      claimStatusAfterRetry: claimRow.rows[0]?.response_status ?? null,
      replayOutcome: replay.outcome,
      replayStatus: replay.outcome === "replayed" ? replay.status : -1,
      replayBodyMatches,
      decisionsAfterReplay,
      completionStatusAtCommit: witnessed.rows[0]?.observed_status ?? null,
      correctionCompletionStatusAtCommit: correctionWitnessed.rows[0]?.observed_status ?? null,
      correctionReplayOutcome: correctionReplay.outcome,
      correctionRevisions: Number(correctionRevisions.rows[0]?.count ?? "-1"),
      legacyDecisionsAfterFault,
      legacySameKeyRetry: legacySameKeyRetry.outcome,
      legacyDecisionsAfterNewKeyRetry
    };
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}

export async function assertCandidateDecisionIntegrity(databaseUrl: string): Promise<void> {
  const suffix = randomBytes(4).toString("hex");
  const schema = `decision_probe_${suffix}`;
  const orgA = "11111111-1111-4111-8111-111111111111";
  const orgB = "22222222-2222-4222-8222-222222222222";
  const admin = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });

  try {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    for (const migration of [
      "0002_organizations_users_memberships.sql",
      "0006_evidence_extraction_runs.sql",
      "0009_roles.sql",
      "0013_file_intakes.sql",
      "0016_applications_and_import_finalization.sql",
      "0017_evidence_outcomes.sql",
      "0018_evidence_corrections.sql",
      "0019_correction_attribution.sql",
      "0020_candidate_decisions.sql",
      "0021_single_decision_root.sql"
    ]) {
      await admin.query(readFileSync(join(MIGRATIONS_DIRECTORY, migration), "utf8"));
    }

    await admin.query(`INSERT INTO organizations (organization_id, name) VALUES ($1, 'A'), ($2, 'B')`, [orgA, orgB]);
    const member = await admin.query<{ user_id: string }>(
      `INSERT INTO users (email, display_name) VALUES ($1, 'Member') RETURNING user_id`,
      [`decider_${suffix}@acme.test`]
    );
    const outsider = await admin.query<{ user_id: string }>(
      `INSERT INTO users (email, display_name) VALUES ($1, 'Outsider') RETURNING user_id`,
      [`outsider_${suffix}@acme.test`]
    );
    const memberId = member.rows[0]?.user_id;
    const outsiderId = outsider.rows[0]?.user_id;
    if (memberId === undefined || outsiderId === undefined) {
      throw new Error("probe could not create users");
    }
    await admin.query(`INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'recruiter')`, [
      orgA,
      memberId
    ]);
    const role = await admin.query<{ role_id: string }>(
      `INSERT INTO roles (organization_id, title, created_by_user_id) VALUES ($1, 'R', $2) RETURNING role_id`,
      [orgA, memberId]
    );
    const intake = await admin.query<{ intake_id: string }>(
      `INSERT INTO file_intakes (organization_id, role_id, storage_key, declared_filename, declared_mime_type, created_by_user_id)
       VALUES ($1, $2, $3, 'a.csv', 'text/csv', $4) RETURNING intake_id`,
      [orgA, role.rows[0]?.role_id, `probe/${suffix}.csv`, memberId]
    );
    const application = await admin.query<{ application_id: string }>(
      `INSERT INTO applications (organization_id, role_id, intake_id, source_row_number, candidate_full_name, candidate_email)
       VALUES ($1, $2, $3, 1, 'Casey', $4) RETURNING application_id`,
      [orgA, role.rows[0]?.role_id, intake.rows[0]?.intake_id, `casey_${suffix}@acme.test`]
    );
    const applicationId = application.rows[0]?.application_id;
    if (applicationId === undefined) {
      throw new Error("probe could not create an application");
    }

    // 1. "The only place": applications carries no status column, so
    //    there is nothing else that could hold a workflow status.
    const columns = await admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'applications'`,
      [schema]
    );
    const statusLike = columns.rows
      .map((row) => row.column_name)
      .filter((name) => /status|stage|disposition|outcome|decision/u.test(name));
    if (statusLike.length > 0) {
      throw new Error(
        `applications must hold no workflow status of its own; found ${statusLike.join(", ")} -- a second copy the decision log cannot keep in sync`
      );
    }

    // 2. A decision records, and reads back as the current status.
    const first = await recordCandidateDecision(databaseUrl, schema, {
      organizationId: orgA,
      applicationId,
      decision: "advance",
      rationale: "meets every criterion with cited evidence",
      decidedByUserId: memberId
    });
    if (first.outcome !== "recorded" || first.supersededId !== undefined) {
      throw new Error(`the first decision supersedes nothing; got ${JSON.stringify(first)}`);
    }

    // 3. A revision supersedes it, and the original survives.
    const second = await recordCandidateDecision(databaseUrl, schema, {
      organizationId: orgA,
      applicationId,
      decision: "decline",
      rationale: "reference check contradicted the cited claim",
      decidedByUserId: memberId
    });
    if (second.outcome !== "recorded" || second.supersededId !== first.decisionId) {
      throw new Error(`a revision must name the decision it replaced; got ${JSON.stringify(second)}`);
    }
    const history = await listCandidateDecisionsForApplication(databaseUrl, schema, orgA, applicationId);
    if (history.length !== 2) {
      throw new Error(`the earlier decision must survive; history has ${history.length}`);
    }
    if (history[0]?.decision !== "advance") {
      throw new Error("the original decision must still read as it did");
    }

    // 4. Never a nameless or unexplained decision, and never someone
    //    without standing in this tenant. Each attempt gets its own key
    //    so a duplicate-key error cannot masquerade as the constraint.
    const rejections: Array<[string, string, string | null, string | null, string | null]> = [
      ["a decision by someone with no membership here", orgA, "decline", "no", outsiderId],
      // The ticket's core claim is "always a named human action". Without
      // this case, removing decided_by_user_id's NOT NULL failed nothing
      // -- the membership foreign key is MATCH SIMPLE, so a NULL decider
      // satisfies it, and only the NOT NULL catches a nameless decision.
      ["a decision with no decider at all", orgA, "hold", "someone decided this", null],
      ["a whitespace-only rationale", orgA, "hold", "\t\n ", memberId],
      ["an empty rationale", orgA, "hold", "", memberId],
      ["a null rationale", orgA, "hold", null, memberId],
      ["a decision about another tenant's candidate", orgB, "decline", "no", memberId]
    ];
    for (const [label, organizationId, kind, rationale, decider] of rejections) {
      let rejected = false;
      try {
        await admin.query(
          `INSERT INTO candidate_decisions (organization_id, application_id, decision, rationale, decided_by_user_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [organizationId, applicationId, kind, rationale, decider]
        );
      } catch {
        rejected = true;
      }
      if (!rejected) {
        throw new Error(`${label} must not be recordable`);
      }
    }

    // 5. Nothing edits or erases a decision.
    for (const statement of [
      `UPDATE candidate_decisions SET decision = 'advance'`,
      `DELETE FROM candidate_decisions`,
      `TRUNCATE candidate_decisions`
    ]) {
      let rejected = false;
      try {
        await admin.query(statement);
      } catch {
        rejected = true;
      }
      if (!rejected) {
        throw new Error(`a recorded decision must be immutable; permitted: ${statement}`);
      }
    }

    // 6. Concurrency: two reviewers deciding at once must not fork the
    //    chain. Both launched before either is awaited.
    const [a, b] = await Promise.all([
      recordCandidateDecision(databaseUrl, schema, {
        organizationId: orgA,
        applicationId,
        decision: "hold",
        rationale: "first reviewer",
        decidedByUserId: memberId
      }),
      recordCandidateDecision(databaseUrl, schema, {
        organizationId: orgA,
        applicationId,
        decision: "advance",
        rationale: "second reviewer",
        decidedByUserId: memberId
      })
    ]);
    const after = await listCandidateDecisionsForApplication(databaseUrl, schema, orgA, applicationId);
    const supersededIds = after
      .map((decision) => decision.supersedesDecisionId)
      .filter((id): id is string => id !== undefined);
    // Stated honestly, because it was measured: this assertion cannot
    // fail while the schema is intact, and dropping 0020_candidate_decisions.sql's unique index
    // to prove otherwise does not isolate it -- the INSERT fails earlier
    // with "there is no unique or exclusion constraint matching the ON
    // CONFLICT specification". The same is true of AF-49's equivalent.
    // Kept as a statement of the invariant and as a guard against a
    // future refactor that stops routing decisions through ON CONFLICT;
    // the assertions that genuinely discriminate here are the exactly-
    // one-head check below and the rejection cases above.
    if (new Set(supersededIds).size !== supersededIds.length) {
      throw new Error("concurrent decisions forked the chain: two rows claim the same predecessor");
    }
    const heads = after.filter((decision) => !supersededIds.includes(decision.decisionId));
    if (heads.length !== 1) {
      throw new Error(`a candidate must have exactly one current decision, got ${heads.length}`);
    }
    for (const result of [a, b]) {
      if (result.outcome === "recorded" && result.decisionId === undefined) {
        throw new Error("a recorded decision must report its id");
      }
    }
  } finally {
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } catch {
      // Best-effort cleanup; the next probe uses a unique suffix.
    }
    await admin.end().catch(() => undefined);
  }
}
