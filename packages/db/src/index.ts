import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  Application,
  AuditAction,
  CandidateDecision,
  CandidateDecisionKind,
  CanonicalTextExtraction,
  CanonicalTextPage,
  CanonicalTextQuality,
  CsvColumnMapping,
  DomainPort,
  EvidenceExtractionRunRef,
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
  ReviewTimingSpan,
  Role,
  RoleStatus,
  Rubric,
  RubricCriterion,
  RubricStatus,
  User
} from "@signal-audit/domain";
import {
  CONTRACT_SCHEMA_VERSION,
  canonicalizeCsvColumnMapping,
  compareApplicationsBySourceOrder,
  classifyCsvImportRow,
  mapCsvRowToApplication,
  summarizeFailedDocuments,
  summarizeImportRows
} from "@signal-audit/domain";
import { Client } from "pg";

/** Persistence adapters will implement domain-owned ports in this package. */
export interface DatabaseAdapterBoundary {
  readonly domain: DomainPort;
}

export interface DatabaseHealth {
  readonly database: string;
  readonly schema: string;
}

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
async function assertMembershipLookupVisible(client: Client, schema: string): Promise<void> {
  const rls = await client.query<{ active: boolean }>(
    `SELECT row_security_active('"${schema}".memberships'::regclass) AS active`
  );
  if (rls.rows[0]?.active === true) {
    throw new Error(
      `cannot verify membership for a login magic link: row-level security is active on "${schema}".memberships ` +
        `for the current database role, so the cross-organization lookup a login token requires can never match. ` +
        `Grant this role BYPASSRLS, or move the lookup into a SECURITY DEFINER function owned by the table owner.`
    );
  }
}

async function emailHasMembership(
  client: Client,
  schema: string,
  email: string
): Promise<boolean> {
  await assertMembershipLookupVisible(client, schema);
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
  client: Client,
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
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
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
    await client.end().catch(() => undefined);
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
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
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
    await client.end().catch(() => undefined);
  }
}

// ---- AF-20: immutable audit events ----
//
// Insert only. There is deliberately no update or delete function here,
// on top of the database trigger that rejects them outright (migration
// 0005): immutability is enforced twice, not assumed from one layer.

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

  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    await insert(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

// ---- AF-40: persist model/prompt/schema/rubric versions ----
//
// Insert only, same as appendAuditEvent: immutability is enforced by
// the database trigger (migration 0006), and there is deliberately no
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
  input: RecordEvidenceExtractionRunInput
): Promise<void> {
  assertSafeSchema(schema);
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    await client.query(
      `INSERT INTO "${schema}".evidence_extraction_runs
         (organization_id, entity_type, entity_id, provider, model, prompt_version,
          extraction_schema_version, extraction_schema_name, rubric_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
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
  } finally {
    await client.end().catch(() => undefined);
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

/** Increments the existing row for this (organization, model, period), or creates it. */
export async function recordInferenceUsage(
  databaseUrl: string,
  schema: string,
  input: RecordInferenceUsageInput
): Promise<void> {
  assertSafeSchema(schema);
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
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
    await client.end().catch(() => undefined);
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
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    const result = await client.query<{ input_tokens: string; output_tokens: string }>(
      `SELECT input_tokens, output_tokens FROM "${schema}".inference_usage_ledger
        WHERE organization_id = $1 AND model = $2 AND period_start = $3`,
      [input.organizationId, input.model, input.periodStart]
    );
    const row = result.rows[0];
    return {
      inputTokens: row === undefined ? 0 : Number(row.input_tokens),
      outputTokens: row === undefined ? 0 : Number(row.output_tokens)
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

// ---- AF-42: inference kill switch ----
//
// The table (migration 0008) is a singleton with a seed row, so a read
// finding no row at all means the migration hasn't run, not that the
// switch is somehow undefined -- that is treated as an error, not a
// silent "assume disengaged."

export interface InferenceKillSwitchRow {
  readonly engaged: boolean;
  readonly reason?: string;
}

export async function getInferenceKillSwitchStatus(
  databaseUrl: string,
  schema: string
): Promise<InferenceKillSwitchRow> {
  assertSafeSchema(schema);
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    const result = await client.query<{ engaged: boolean; reason: string | null }>(
      `SELECT engaged, reason FROM "${schema}".inference_kill_switch WHERE id = true`
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("inference_kill_switch has no row; the seed insert from migration 0008 is missing");
    }
    return row.reason === null ? { engaged: row.engaged } : { engaged: row.engaged, reason: row.reason };
  } finally {
    await client.end().catch(() => undefined);
  }
}

export interface SetInferenceKillSwitchInput {
  readonly engaged: boolean;
  readonly reason?: string;
  readonly engagedByUserId?: string;
}

/**
 * The database CHECK constraint (migration 0008) is the real enforcement:
 * engaging without a reason and an engagedByUserId is rejected there
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
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    const result = await client.query(
      `UPDATE "${schema}".inference_kill_switch
          SET engaged = $1, reason = $2, engaged_by_user_id = $3, updated_at = CURRENT_TIMESTAMP
        WHERE id = true`,
      [input.engaged, input.reason ?? null, input.engagedByUserId ?? null]
    );
    if (result.rowCount === 0) {
      throw new Error("inference_kill_switch has no row; the seed insert from migration 0008 is missing");
    }
  } finally {
    await client.end().catch(() => undefined);
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
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    const result = await client.query<UserRow>(
      `SELECT user_id, email, display_name, created_at FROM "${schema}".users WHERE email = $1`,
      [email]
    );
    return result.rows[0] === undefined ? undefined : rowToUser(result.rows[0]);
  } finally {
    await client.end().catch(() => undefined);
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
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
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
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
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
    await client.end().catch(() => undefined);
  }
}

// ---- AF-24: recruiter roles list ----

export async function listRolesForOrganization(
  databaseUrl: string,
  schema: string,
  organizationId: string
): Promise<readonly Role[]> {
  assertSafeSchema(schema);
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
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
    await client.end().catch(() => undefined);
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
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
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
    await client.end().catch(() => undefined);
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
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
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
    await client.end().catch(() => undefined);
  }
}

export type UpsertDraftRubricOutcome =
  | { readonly outcome: "saved"; readonly rubric: Rubric }
  | { readonly outcome: "no_such_role" };

/**
 * Creates the role's first draft, or overwrites the existing one --
 * never both in the same call, and never touches a published version.
 * The role_id foreign key plus the one-draft-per-role partial unique
 * index (migration 0010) are what make this safe under concurrent
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
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
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
    await client.end().catch(() => undefined);
  }
}

// ---- AF-27: named approval and immutable rubric publishing ----

export type PublishRubricOutcome =
  | { readonly outcome: "published"; readonly rubric: Rubric }
  | { readonly outcome: "no_draft" };

/**
 * The UPDATE's own WHERE status = 'draft' is what makes "approve the
 * current draft" atomic and race-free -- two concurrent publish calls
 * can't both succeed, and once the first one wins, migration 0011's
 * trigger makes the resulting row permanently unreachable to any future
 * UPDATE, this function included.
 */
export async function publishRubric(
  databaseUrl: string,
  schema: string,
  rubricId: string,
  approvedByUserId: string
): Promise<PublishRubricOutcome> {
  assertSafeSchema(schema);
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
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
    await client.end().catch(() => undefined);
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
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
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
    await client.end().catch(() => undefined);
  }
}

export async function getFileIntakeById(
  databaseUrl: string,
  schema: string,
  intakeId: string
): Promise<FileIntake | undefined> {
  assertSafeSchema(schema);
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    const result = await client.query<FileIntakeRow>(
      `SELECT ${FILE_INTAKE_COLUMNS} FROM "${schema}".file_intakes WHERE intake_id = $1`,
      [intakeId]
    );
    return result.rows[0] === undefined ? undefined : rowToFileIntake(result.rows[0]);
  } finally {
    await client.end().catch(() => undefined);
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
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
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
    await client.end().catch(() => undefined);
  }
}

export interface RecordFileValidationInput {
  readonly sniffedMimeType: string | undefined;
  readonly sizeBytes: number;
  readonly sha256Hash: string;
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
export async function recordFileValidationResult(
  databaseUrl: string,
  schema: string,
  intakeId: string,
  input: RecordFileValidationInput
): Promise<RecordFileValidationOutcome> {
  assertSafeSchema(schema);
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    const newStatus: FileIntakeStatus = input.validation.outcome === "validated" ? "validated" : "quarantined";
    const rejectionReason = input.validation.outcome === "validated" ? null : input.validation.reason;
    const result = await client.query<FileIntakeRow>(
      `UPDATE "${schema}".file_intakes
          SET status = $2, sniffed_mime_type = $3, size_bytes = $4, sha256_hash = $5, rejection_reason = $6
        WHERE intake_id = $1 AND status = 'uploaded'
        RETURNING ${FILE_INTAKE_COLUMNS}`,
      [intakeId, newStatus, input.sniffedMimeType ?? null, input.sizeBytes, input.sha256Hash, rejectionReason]
    );
    const row = result.rows[0];
    return row === undefined ? { outcome: "not_uploaded" } : { outcome: "recorded", intake: rowToFileIntake(row) };
  } finally {
    await client.end().catch(() => undefined);
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
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
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
    await client.end().catch(() => undefined);
  }
}

export async function getCanonicalTextExtractionByIntakeId(
  databaseUrl: string,
  schema: string,
  intakeId: string
): Promise<CanonicalTextExtraction | undefined> {
  assertSafeSchema(schema);
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    const result = await client.query<CanonicalTextExtractionRow>(
      `SELECT ${CANONICAL_TEXT_EXTRACTION_COLUMNS} FROM "${schema}".canonical_text_extractions WHERE intake_id = $1`,
      [intakeId]
    );
    return result.rows[0] === undefined ? undefined : rowToCanonicalTextExtraction(result.rows[0]);
  } finally {
    await client.end().catch(() => undefined);
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

async function insertImportRow(
  client: Client,
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
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
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
              values.appliedAt ?? null
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
    await client.end().catch(() => undefined);
  }
}

export async function getImportRowsForIntake(
  databaseUrl: string,
  schema: string,
  intakeId: string
): Promise<readonly ImportRow[]> {
  assertSafeSchema(schema);
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    const result = await client.query<ImportRowRow>(
      `SELECT ${IMPORT_ROW_COLUMNS} FROM "${schema}".import_rows WHERE intake_id = $1 ORDER BY row_number`,
      [intakeId]
    );
    return result.rows.map(rowToImportRow);
  } finally {
    await client.end().catch(() => undefined);
  }
}

// ---- AF-22: exercise memberships RLS with a real non-superuser role ----

const MIGRATIONS_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "../migrations");

/**
 * Creates a throwaway schema, applies the real 0002/0004 migrations, and
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
    await admin.query(
      `INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'owner'), ($3, $4, 'owner')`,
      [orgA, userA, orgB, userB]
    );

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
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
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

// ---- AF-45: tenant-scoped application review queue ----

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

// ---- AF-58: failed-document rate ----

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
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
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
    await client.end().catch(() => undefined);
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
      "0012_file_intakes.sql",
      "0013_file_intake_validation.sql",
      "0014_canonical_text_extractions.sql"
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
    // A misattributed row -- org B pointing at org A's role -- used to be
    // insertable here, and this probe deliberately created one to prove the
    // organization_id predicate was load-bearing. AF-28's composite foreign
    // key on (role_id, organization_id) now rejects it at the schema level,
    // so that scenario can no longer be constructed and the case has been
    // removed rather than left as a test that cannot fail.
    //
    // The predicate itself is kept, but it is honestly defence in depth now,
    // not the thing enforcing isolation: role_id is a globally unique
    // primary key and the composite FK ties it to one organization, so
    // filtering on role_id alone would already be correct. It stays because
    // POL-011 is a tenant boundary and a query over tenant data should say
    // which tenant it means. Removing it would fail no test today.

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
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
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
    await client.end().catch(() => undefined);
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
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
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
    await client.end().catch(() => undefined);
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
      "0012_file_intakes.sql",
      "0015_applications_and_import_finalization.sql"
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
      "0012_file_intakes.sql",
      "0015_applications_and_import_finalization.sql"
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

// ---- AF-48 prerequisite: evidence outcome persistence ----

export interface RecordEvidenceOutcomeInput {
  readonly organizationId: string;
  readonly applicationId: string;
  readonly outcome: EvidenceOutcome;
  /** The extraction run that produced this, when one did. */
  readonly runId?: string;
}

/**
 * Insert only. evidence_outcomes is append-only at the database level
 * (0016's trigger), so there is deliberately no update or delete
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
  input: RecordEvidenceOutcomeInput
): Promise<void> {
  assertSafeSchema(schema);
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
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
  } finally {
    await client.end().catch(() => undefined);
  }
}

export interface RecordedEvidenceOutcome {
  readonly outcome: EvidenceOutcome;
  readonly recordedAt: string;
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
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
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
    await client.end().catch(() => undefined);
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
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
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
    await client.end().catch(() => undefined);
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

  const outcome = (kind: "supported" | "not_found", criterionId: string): EvidenceOutcome =>
    kind === "supported"
      ? {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          kind: "supported",
          criterionId,
          citation: {
            document: "resume.pdf",
            pageOrSection: "Experience",
            offset: 10,
            quote: "Built Python services in production."
          }
        }
      : { schemaVersion: CONTRACT_SCHEMA_VERSION, kind: "not_found", criterionId };

  try {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    for (const migration of [
      "0002_organizations_users_memberships.sql",
      "0006_evidence_extraction_runs.sql",
      "0009_roles.sql",
      "0012_file_intakes.sql",
      "0015_applications_and_import_finalization.sql",
      "0016_evidence_outcomes.sql"
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
    //    0006 hit the same thing on audit_events.
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

/**
 * A file intake carries both a tenant column and a reference to a
 * tenant-owned row. Constraining those separately lets a row sit in
 * organization B while pointing at organization A's role, and the
 * misattributed document then counts toward the wrong tenant's per-role
 * figures -- AF-58's failed-document rate reads exactly this pair.
 *
 * Third occurrence of this defect class (audit_events on AF-20,
 * evidence_outcomes on AF-48, this), so the property is worth pinning
 * rather than trusting the migration to stay correct.
 */
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
      "0012_file_intakes.sql"
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

// ---- AF-49: append-only evidence corrections ----

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
export type EvidenceCorrectionResult =
  | { readonly outcome: "recorded"; readonly evidenceOutcomeId: string; readonly supersededId: string }
  | { readonly outcome: "nothing_to_correct" }
  | { readonly outcome: "superseded" };

export async function correctEvidenceOutcome(
  databaseUrl: string,
  schema: string,
  input: CorrectEvidenceOutcomeInput
): Promise<EvidenceCorrectionResult> {
  assertSafeSchema(schema);
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    await client.query("BEGIN");
    try {
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
        await client.query("ROLLBACK");
        return { outcome: "superseded" };
      }
      await client.query("COMMIT");
      return { outcome: "recorded", evidenceOutcomeId, supersededId };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

export interface RecordedEvidenceRevision {
  readonly evidenceOutcomeId: string;
  readonly outcome: EvidenceOutcome;
  readonly recordedAt: string;
  readonly correctedByUserId?: string | undefined;
  readonly correctionReason?: string | undefined;
  readonly supersedesEvidenceOutcomeId?: string | undefined;
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
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
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
    await client.end().catch(() => undefined);
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

  const outcomeOf = (kind: "supported" | "not_found" | "unclear", criterionId: string): EvidenceOutcome =>
    kind === "supported"
      ? {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          kind: "supported",
          criterionId,
          citation: { document: "resume.pdf", pageOrSection: "Experience", offset: 4, quote: "Ran Postgres." }
        }
      : kind === "unclear"
        ? {
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            kind: "unclear",
            criterionId,
            citation: { document: "resume.pdf", pageOrSection: "Skills", offset: 9, quote: "Databases." }
          }
        : { schemaVersion: CONTRACT_SCHEMA_VERSION, kind: "not_found", criterionId };

  try {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    for (const migration of [
      "0002_organizations_users_memberships.sql",
      "0006_evidence_extraction_runs.sql",
      "0009_roles.sql",
      "0012_file_intakes.sql",
      "0015_applications_and_import_finalization.sql",
      "0016_evidence_outcomes.sql",
      "0017_evidence_corrections.sql",
      "0018_correction_attribution.sql"
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
    // AF-50: the corrector must be a member of the organization whose
    // evidence they correct (0018's membership foreign key), so the
    // probe has to create one. That this line is required is itself the
    // constraint working.
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
    // schema is intact, and dropping 0017's unique index to prove it
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

    // 5. AF-50: a reason must say something, and the person must have
    //    standing. Every attempt uses its own primary key, because a
    //    shared one lets a duplicate-key error masquerade as the
    //    constraint under test -- which is exactly what happened the
    //    first time these were checked by hand.
    const outsider = await admin.query<{ user_id: string }>(
      `INSERT INTO users (email, display_name) VALUES ($1, 'Outsider') RETURNING user_id`,
      [`outsider_${suffix}@acme.test`]
    );
    const outsiderId = outsider.rows[0]?.user_id;
    const headRow = await admin.query<{ evidence_outcome_id: string }>(
      `SELECT evidence_outcome_id FROM evidence_outcomes WHERE criterion_id = 'postgres' ORDER BY recorded_at DESC LIMIT 1`
    );
    const headId = headRow.rows[0]?.evidence_outcome_id;
    if (outsiderId === undefined || headId === undefined) {
      throw new Error("probe could not set up the attribution cases");
    }

    const attributionCases: Array<[string, string, string | null]> = [
      ["a spaces-only reason", userId, "   "],
      ["an empty reason", userId, ""],
      ["a tab-and-newline-only reason", userId, "\t\n "],
      ["a corrector with no membership in this organization", outsiderId, "a real reason"]
    ];
    for (const [label, corrector, reason] of attributionCases) {
      let rejected = false;
      try {
        await admin.query(
          `INSERT INTO evidence_outcomes
             (organization_id, application_id, criterion_id, kind, outcome,
              corrected_by_user_id, correction_reason, supersedes_evidence_outcome_id)
           VALUES ($1, $2, 'postgres', 'not_found', $3::jsonb, $4, $5, $6)`,
          [organizationId, applicationId, JSON.stringify(outcomeOf("not_found", "postgres")), corrector, reason, headId]
        );
      } catch {
        rejected = true;
      }
      if (!rejected) {
        throw new Error(`${label} must not be accepted as a correction`);
      }
    }

    // 6. And the membership that attributes a correction cannot be
    //    deleted out from under it -- offboarding must not orphan the
    //    record of what someone changed.
    let membershipDeleteRefused = false;
    try {
      await admin.query(`DELETE FROM memberships WHERE user_id = $1 AND organization_id = $2`, [
        userId,
        organizationId
      ]);
    } catch {
      membershipDeleteRefused = true;
    }
    if (!membershipDeleteRefused) {
      throw new Error("deleting the membership that attributes a correction must be refused");
    }

    // 7. Nothing edits or erases a correction either.
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

// ---- AF-51: named human advance/hold/decline recording ----

export interface RecordCandidateDecisionInput {
  readonly organizationId: string;
  readonly applicationId: string;
  readonly decision: CandidateDecisionKind;
  readonly rationale: string;
  /**
   * Always required, never defaulted. There is no signature of this
   * function that records a decision without a named person, which is
   * the code-level half of what 0019's NOT NULL enforces.
   */
  readonly decidedByUserId: string;
}

export type CandidateDecisionResult =
  | { readonly outcome: "recorded"; readonly decisionId: string; readonly supersededId?: string }
  | { readonly outcome: "superseded" };

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
export async function recordCandidateDecision(
  databaseUrl: string,
  schema: string,
  input: RecordCandidateDecisionInput
): Promise<CandidateDecisionResult> {
  assertSafeSchema(schema);
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    await client.query("BEGIN");
    try {
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
          LIMIT 1
          FOR UPDATE`,
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
        await client.query("ROLLBACK");
        return { outcome: "superseded" };
      }
      await client.query("COMMIT");
      return supersededId === undefined
        ? { outcome: "recorded", decisionId }
        : { outcome: "recorded", decisionId, supersededId };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    await client.end().catch(() => undefined);
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
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
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
    await client.end().catch(() => undefined);
  }
}

/**
 * AF-51: proves the decision log is the only place a candidate's status
 * can change, and that every row in it names a person and a reason.
 */
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
      "0012_file_intakes.sql",
      "0015_applications_and_import_finalization.sql",
      "0016_evidence_outcomes.sql",
      "0017_evidence_corrections.sql",
      "0018_correction_attribution.sql",
      "0019_candidate_decisions.sql"
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
    // fail while the schema is intact, and dropping 0019's unique index
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

// ---- AF-52: low-evidence random audit sampling ----

export interface RecordAuditSampleInput {
  readonly organizationId: string;
  readonly roleId: string;
  readonly seed: string;
  readonly requestedSize: number;
  readonly eligibleCount: number;
  readonly drawnByUserId: string;
  readonly sampledApplicationIds: readonly string[];
}

export interface RecordedAuditSample {
  readonly auditSampleId: string;
  readonly seed: string;
  readonly requestedSize: number;
  readonly eligibleCount: number;
  readonly drawnByUserId: string;
  readonly drawnAt: string;
  readonly sampledApplicationIds: readonly string[];
}

/**
 * The draw and its members are written in ONE transaction, because a
 * draw recorded without its membership is indistinguishable from a draw
 * whose membership was chosen afterwards -- which is precisely the thing
 * recording the seed exists to rule out.
 */
export async function recordAuditSample(
  databaseUrl: string,
  schema: string,
  input: RecordAuditSampleInput
): Promise<string> {
  assertSafeSchema(schema);
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    await client.query("BEGIN");
    try {
      const drawn = await client.query<{ audit_sample_id: string }>(
        `INSERT INTO "${schema}".audit_samples
           (organization_id, role_id, seed, requested_size, eligible_count, drawn_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING audit_sample_id`,
        [
          input.organizationId,
          input.roleId,
          input.seed,
          input.requestedSize,
          input.eligibleCount,
          input.drawnByUserId
        ]
      );
      const auditSampleId = drawn.rows[0]?.audit_sample_id;
      if (auditSampleId === undefined) {
        throw new Error("recording an audit sample did not produce a draw row");
      }
      for (const applicationId of input.sampledApplicationIds) {
        await client.query(
          `INSERT INTO "${schema}".audit_sample_members (audit_sample_id, organization_id, application_id)
           VALUES ($1, $2, $3)`,
          [auditSampleId, input.organizationId, applicationId]
        );
      }
      await client.query("COMMIT");
      return auditSampleId;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Every draw for a role, newest first, with its membership. */
export async function listAuditSamplesForRole(
  databaseUrl: string,
  schema: string,
  organizationId: string,
  roleId: string
): Promise<readonly RecordedAuditSample[]> {
  assertSafeSchema(schema);
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    const result = await client.query<{
      audit_sample_id: string;
      seed: string;
      requested_size: number;
      eligible_count: number;
      drawn_by_user_id: string;
      drawn_at: Date;
      application_ids: string[] | null;
    }>(
      `SELECT s.audit_sample_id, s.seed, s.requested_size, s.eligible_count,
              s.drawn_by_user_id, s.drawn_at,
              array_agg(m.application_id ORDER BY m.application_id)
                FILTER (WHERE m.application_id IS NOT NULL) AS application_ids
         FROM "${schema}".audit_samples s
         LEFT JOIN "${schema}".audit_sample_members m ON m.audit_sample_id = s.audit_sample_id
        WHERE s.organization_id = $1 AND s.role_id = $2
        GROUP BY s.audit_sample_id
        ORDER BY s.drawn_at DESC, s.audit_sample_id DESC`,
      [organizationId, roleId]
    );
    return result.rows.map((row) => ({
      auditSampleId: row.audit_sample_id,
      seed: row.seed,
      requestedSize: row.requested_size,
      eligibleCount: row.eligible_count,
      drawnByUserId: row.drawn_by_user_id,
      drawnAt: row.drawn_at.toISOString(),
      sampledApplicationIds: row.application_ids ?? []
    }));
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * AF-52: proves a recorded draw cannot be re-rolled, re-attributed, or
 * quietly extended after the fact.
 *
 * Every rejection attempt uses its own primary key. A shared one lets a
 * duplicate-key error masquerade as the constraint under test -- which
 * happened while checking this table by hand, and made a cross-tenant
 * case look enforced when the unique index had fired instead.
 */
export async function assertAuditSampleIntegrity(databaseUrl: string): Promise<void> {
  const suffix = randomBytes(4).toString("hex");
  const schema = `sample_probe_${suffix}`;
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
      "0012_file_intakes.sql",
      "0015_applications_and_import_finalization.sql",
      "0016_evidence_outcomes.sql",
      "0017_evidence_corrections.sql",
      "0018_correction_attribution.sql",
      "0019_candidate_decisions.sql",
      "0020_audit_samples.sql"
    ]) {
      await admin.query(readFileSync(join(MIGRATIONS_DIRECTORY, migration), "utf8"));
    }

    await admin.query(`INSERT INTO organizations (organization_id, name) VALUES ($1, 'A'), ($2, 'B')`, [orgA, orgB]);
    const member = await admin.query<{ user_id: string }>(
      `INSERT INTO users (email, display_name) VALUES ($1, 'Auditor') RETURNING user_id`,
      [`auditor_${suffix}@acme.test`]
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
    await admin.query(`INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'auditor')`, [
      orgA,
      memberId
    ]);
    const role = await admin.query<{ role_id: string }>(
      `INSERT INTO roles (organization_id, title, created_by_user_id) VALUES ($1, 'R', $2) RETURNING role_id`,
      [orgA, memberId]
    );
    const roleId = role.rows[0]?.role_id;
    const intake = await admin.query<{ intake_id: string }>(
      `INSERT INTO file_intakes (organization_id, role_id, storage_key, declared_filename, declared_mime_type, created_by_user_id)
       VALUES ($1, $2, $3, 'a.csv', 'text/csv', $4) RETURNING intake_id`,
      [orgA, roleId, `probe/${suffix}.csv`, memberId]
    );
    const applicationIds: string[] = [];
    for (let index = 1; index <= 3; index += 1) {
      const application = await admin.query<{ application_id: string }>(
        `INSERT INTO applications (organization_id, role_id, intake_id, source_row_number, candidate_full_name, candidate_email)
         VALUES ($1, $2, $3, $4, 'C', $5) RETURNING application_id`,
        [orgA, roleId, intake.rows[0]?.intake_id, index, `c${index}_${suffix}@acme.test`]
      );
      const id = application.rows[0]?.application_id;
      if (id === undefined) {
        throw new Error("probe could not create an application");
      }
      applicationIds.push(id);
    }
    if (roleId === undefined) {
      throw new Error("probe could not create a role");
    }

    // 1. A draw records with its membership, atomically.
    const sampleId = await recordAuditSample(databaseUrl, schema, {
      organizationId: orgA,
      roleId,
      seed: `audit-${suffix}`,
      requestedSize: 2,
      eligibleCount: 3,
      drawnByUserId: memberId,
      sampledApplicationIds: applicationIds.slice(0, 2)
    });
    const drawn = await listAuditSamplesForRole(databaseUrl, schema, orgA, roleId);
    if (drawn.length !== 1 || drawn[0]?.sampledApplicationIds.length !== 2) {
      throw new Error(`expected one draw of two applications, got ${JSON.stringify(drawn)}`);
    }
    if (drawn[0]?.seed !== `audit-${suffix}` || drawn[0]?.eligibleCount !== 3) {
      throw new Error("a draw must record the seed and the eligible population it drew from");
    }

    // 2. A draw that cannot record its membership records nothing.
    //    Otherwise a failed write leaves a seed with no members, which
    //    reads as "we sampled and found nobody".
    let partialRejected = false;
    try {
      await recordAuditSample(databaseUrl, schema, {
        organizationId: orgA,
        roleId,
        seed: `atomic-${suffix}`,
        requestedSize: 1,
        eligibleCount: 3,
        drawnByUserId: memberId,
        sampledApplicationIds: ["99999999-9999-4999-8999-999999999999"]
      });
    } catch {
      partialRejected = true;
    }
    if (!partialRejected) {
      throw new Error("a draw naming an application that does not exist must fail");
    }
    const afterFailure = await listAuditSamplesForRole(databaseUrl, schema, orgA, roleId);
    if (afterFailure.length !== 1) {
      throw new Error(
        `a failed draw must leave nothing behind; found ${afterFailure.length} draws, so the seed was recorded without its members`
      );
    }

    // 3. Rejections. Each attempt gets its own primary key.
    const rejections: Array<[string, string, string, string, number, number, string]> = [
      ["a blank seed", "b0000001-4444-4444-8444-444444444444", orgA, "   ", 2, 3, memberId],
      ["a zero sample size", "b0000002-4444-4444-8444-444444444444", orgA, "s", 0, 3, memberId],
      ["a negative eligible count", "b0000003-4444-4444-8444-444444444444", orgA, "s", 2, -1, memberId],
      ["a drawer with no membership here", "b0000004-4444-4444-8444-444444444444", orgA, "s", 2, 3, outsiderId],
      ["org B drawing on org A's role", "b0000005-4444-4444-8444-444444444444", orgB, "s", 2, 3, memberId]
    ];
    for (const [label, id, organizationId, seed, size, eligible, drawer] of rejections) {
      let rejected = false;
      try {
        await admin.query(
          `INSERT INTO audit_samples
             (audit_sample_id, organization_id, role_id, seed, requested_size, eligible_count, drawn_by_user_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, organizationId, roleId, seed, size, eligible, drawer]
        );
      } catch {
        rejected = true;
      }
      if (!rejected) {
        throw new Error(`${label} must not be recordable as a draw`);
      }
    }

    // 4. A member from another tenant, with a FRESH draw so the
    //    (sample, application) unique key cannot fire first and be
    //    mistaken for the tenant constraint doing the work.
    let crossTenantRejected = false;
    try {
      await admin.query(
        `INSERT INTO audit_sample_members (audit_sample_id, organization_id, application_id) VALUES ($1, $2, $3)`,
        [sampleId, orgB, applicationIds[2]]
      );
    } catch {
      crossTenantRejected = true;
    }
    if (!crossTenantRejected) {
      throw new Error("a draw must not be able to claim another tenant's application");
    }

    // 5. Nothing edits, extends by rewriting, or erases a recorded draw.
    for (const statement of [
      `UPDATE audit_samples SET seed = 'rerolled'`,
      `DELETE FROM audit_samples`,
      `UPDATE audit_sample_members SET application_id = application_id`,
      `DELETE FROM audit_sample_members`,
      `TRUNCATE audit_sample_members`
    ]) {
      let rejected = false;
      try {
        await admin.query(statement);
      } catch {
        rejected = true;
      }
      if (!rejected) {
        throw new Error(`a recorded draw must be immutable; permitted: ${statement}`);
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

// ---- AF-54: capture recruiter review timing ----

export interface RecordReviewTimingSpanInput {
  readonly organizationId: string;
  readonly applicationId: string;
  readonly reviewerUserId: string;
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly activeMs: number;
  readonly truncatedByIdle: boolean;
}

export async function recordReviewTimingSpan(
  databaseUrl: string,
  schema: string,
  input: RecordReviewTimingSpanInput
): Promise<void> {
  assertSafeSchema(schema);
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    await client.query(
      `INSERT INTO "${schema}".review_timing_spans
         (organization_id, application_id, reviewer_user_id, started_at, ended_at, active_ms, truncated_by_idle)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.organizationId,
        input.applicationId,
        input.reviewerUserId,
        input.startedAt,
        input.endedAt,
        input.activeMs,
        input.truncatedByIdle
      ]
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Spans for a role, grouped by application.
 *
 * There is deliberately NO listReviewTimingSpansForReviewer, and no
 * index that would make one cheap. Time-per-application is a product
 * baseline; the same rows sorted by person are a performance-management
 * dataset, and which of those exists is decided by which query is easy
 * to write. reviewer_user_id is stored because a span with no actor
 * cannot be deduplicated or excluded when someone leaves -- not so it
 * can be reported on.
 */
export async function listReviewTimingSpansForRole(
  databaseUrl: string,
  schema: string,
  organizationId: string,
  roleId: string
): Promise<readonly ReviewTimingSpan[]> {
  assertSafeSchema(schema);
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    const result = await client.query<{
      application_id: string;
      active_ms: number;
      truncated_by_idle: boolean;
    }>(
      `SELECT s.application_id, s.active_ms, s.truncated_by_idle
         FROM "${schema}".review_timing_spans s
         JOIN "${schema}".applications a
           ON a.application_id = s.application_id AND a.organization_id = s.organization_id
        WHERE s.organization_id = $1 AND a.role_id = $2
        ORDER BY s.application_id, s.started_at`,
      [organizationId, roleId]
    );
    return result.rows.map((row) => ({
      applicationId: row.application_id,
      activeMs: row.active_ms,
      truncatedByIdle: row.truncated_by_idle
    }));
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * AF-54: proves a review-timing span cannot record a duration it did
 * not measure, cannot cross tenants, and cannot be edited afterwards.
 *
 * Every rejection attempt uses its own primary key, and the ids are
 * hex-safe. A first pass at this used ids beginning with `t`, which is
 * not a hex digit -- every case failed with "invalid input syntax for
 * type uuid" and would have read as "all rejected" from the exit status
 * alone.
 */
export async function assertReviewTimingIntegrity(databaseUrl: string): Promise<void> {
  const suffix = randomBytes(4).toString("hex");
  const schema = `timing_probe_${suffix}`;
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
      "0012_file_intakes.sql",
      "0015_applications_and_import_finalization.sql",
      "0016_evidence_outcomes.sql",
      "0017_evidence_corrections.sql",
      "0018_correction_attribution.sql",
      "0019_candidate_decisions.sql",
      "0020_audit_samples.sql",
      "0021_review_timing.sql"
    ]) {
      await admin.query(readFileSync(join(MIGRATIONS_DIRECTORY, migration), "utf8"));
    }

    await admin.query(`INSERT INTO organizations (organization_id, name) VALUES ($1, 'A'), ($2, 'B')`, [orgA, orgB]);
    const reviewer = await admin.query<{ user_id: string }>(
      `INSERT INTO users (email, display_name) VALUES ($1, 'Reviewer') RETURNING user_id`,
      [`reviewer_${suffix}@acme.test`]
    );
    const outsider = await admin.query<{ user_id: string }>(
      `INSERT INTO users (email, display_name) VALUES ($1, 'Outsider') RETURNING user_id`,
      [`outsider_${suffix}@acme.test`]
    );
    const reviewerId = reviewer.rows[0]?.user_id;
    const outsiderId = outsider.rows[0]?.user_id;
    if (reviewerId === undefined || outsiderId === undefined) {
      throw new Error("probe could not create users");
    }
    await admin.query(`INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'recruiter')`, [
      orgA,
      reviewerId
    ]);
    const role = await admin.query<{ role_id: string }>(
      `INSERT INTO roles (organization_id, title, created_by_user_id) VALUES ($1, 'R', $2) RETURNING role_id`,
      [orgA, reviewerId]
    );
    const roleId = role.rows[0]?.role_id;
    const intake = await admin.query<{ intake_id: string }>(
      `INSERT INTO file_intakes (organization_id, role_id, storage_key, declared_filename, declared_mime_type, created_by_user_id)
       VALUES ($1, $2, $3, 'a.csv', 'text/csv', $4) RETURNING intake_id`,
      [orgA, roleId, `probe/${suffix}.csv`, reviewerId]
    );
    const application = await admin.query<{ application_id: string }>(
      `INSERT INTO applications (organization_id, role_id, intake_id, source_row_number, candidate_full_name, candidate_email)
       VALUES ($1, $2, $3, 1, 'C', $4) RETURNING application_id`,
      [orgA, roleId, intake.rows[0]?.intake_id, `c_${suffix}@acme.test`]
    );
    const applicationId = application.rows[0]?.application_id;
    if (applicationId === undefined || roleId === undefined) {
      throw new Error("probe could not create an application");
    }

    // 1. Two honest spans record and read back at the right grain.
    await recordReviewTimingSpan(databaseUrl, schema, {
      organizationId: orgA,
      applicationId,
      reviewerUserId: reviewerId,
      startedAt: new Date("2026-08-29T10:00:00Z"),
      endedAt: new Date("2026-08-29T10:01:30Z"),
      activeMs: 90_000,
      truncatedByIdle: false
    });
    await recordReviewTimingSpan(databaseUrl, schema, {
      organizationId: orgA,
      applicationId,
      reviewerUserId: reviewerId,
      startedAt: new Date("2026-08-29T11:00:00Z"),
      endedAt: new Date("2026-08-29T11:05:00Z"),
      activeMs: 120_000,
      truncatedByIdle: true
    });
    const spans = await listReviewTimingSpansForRole(databaseUrl, schema, orgA, roleId);
    if (spans.length !== 2) {
      throw new Error(`expected both spans for this role, got ${spans.length}`);
    }
    if (!spans.some((span) => span.truncatedByIdle)) {
      throw new Error("the idle flag must survive the round trip; a summary cannot exclude what it cannot see");
    }

    // 2. A span cannot claim more active time than the wall clock it
    //    sits inside. This is the check that catches a client sending a
    //    fabricated duration, which would quietly corrupt the baseline.
    const rejections: Array<[string, string, string, string, string, number]> = [
      [
        "eight hours of activity inside ninety seconds",
        "ea000001-4444-4444-8444-444444444444",
        orgA,
        "2026-08-29T14:00:00Z",
        "2026-08-29T14:01:30Z",
        28_800_000
      ],
      [
        "negative active time",
        "ea000002-4444-4444-8444-444444444444",
        orgA,
        "2026-08-29T15:00:00Z",
        "2026-08-29T15:01:00Z",
        -5
      ],
      [
        "a span that ended before it started",
        "ea000003-4444-4444-8444-444444444444",
        orgA,
        "2026-08-29T16:00:00.500Z",
        "2026-08-29T16:00:00.000Z",
        0
      ],
      [
        "another tenant timing this application",
        "ea000004-4444-4444-8444-444444444444",
        orgB,
        "2026-08-29T17:00:00Z",
        "2026-08-29T17:01:00Z",
        60_000
      ]
    ];
    for (const [label, id, organizationId, startedAt, endedAt, activeMs] of rejections) {
      let rejected = false;
      try {
        await admin.query(
          `INSERT INTO review_timing_spans
             (review_timing_span_id, organization_id, application_id, reviewer_user_id,
              started_at, ended_at, active_ms, truncated_by_idle)
           VALUES ($1, $2, $3, $4, $5, $6, $7, false)`,
          [id, organizationId, applicationId, reviewerId, startedAt, endedAt, activeMs]
        );
      } catch {
        rejected = true;
      }
      if (!rejected) {
        throw new Error(`${label} must not be recordable as review timing`);
      }
    }

    // 3. A reviewer with no standing in this tenant cannot be recorded
    //    as having reviewed.
    let outsiderRejected = false;
    try {
      await admin.query(
        `INSERT INTO review_timing_spans
           (review_timing_span_id, organization_id, application_id, reviewer_user_id,
            started_at, ended_at, active_ms, truncated_by_idle)
         VALUES ('ea000005-4444-4444-8444-444444444444', $1, $2, $3, $4, $5, 60000, false)`,
        [orgA, applicationId, outsiderId, "2026-08-29T18:00:00Z", "2026-08-29T18:01:00Z"]
      );
    } catch {
      outsiderRejected = true;
    }
    if (!outsiderRejected) {
      throw new Error("a reviewer with no membership in this organization must not be recordable");
    }

    // 4. Nothing edits or erases a recorded span. Checked with rows
    //    present -- an UPDATE or DELETE affecting zero rows never fires
    //    a row-level trigger and would pass for the wrong reason.
    const before = await admin.query<{ count: string }>(`SELECT count(*)::text AS count FROM review_timing_spans`);
    if (Number(before.rows[0]?.count ?? 0) === 0) {
      throw new Error("the immutability check needs rows present to be meaningful");
    }
    for (const statement of [
      `UPDATE review_timing_spans SET active_ms = 1`,
      `DELETE FROM review_timing_spans`,
      `TRUNCATE review_timing_spans`
    ]) {
      let rejected = false;
      try {
        await admin.query(statement);
      } catch {
        rejected = true;
      }
      if (!rejected) {
        throw new Error(`a recorded timing span must be immutable; permitted: ${statement}`);
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
