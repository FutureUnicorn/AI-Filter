import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AuditAction,
  DomainPort,
  FileIntake,
  FileIntakeStatus,
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
import { CONTRACT_SCHEMA_VERSION } from "@signal-audit/domain";
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

async function emailHasMembership(
  client: Client,
  schema: string,
  email: string
): Promise<boolean> {
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
    await client.query(
      `UPDATE "${schema}".inference_kill_switch
          SET engaged = $1, reason = $2, engaged_by_user_id = $3, updated_at = CURRENT_TIMESTAMP
        WHERE id = true`,
      [input.engaged, input.reason ?? null, input.engagedByUserId ?? null]
    );
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
    createdAt: row.created_at.toISOString()
  };
}

const FILE_INTAKE_COLUMNS =
  "intake_id, organization_id, role_id, storage_key, declared_filename, declared_mime_type, status, created_by_user_id, created_at";

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
