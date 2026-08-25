import type {
  AuditAction,
  DomainPort,
  MagicLinkInvite,
  MagicLinkRedemptionAttempt,
  MagicLinkTokenRecord,
  Membership,
  MembershipRole,
  Organization,
  Role,
  RoleStatus,
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

export async function createMagicLinkToken(
  databaseUrl: string,
  schema: string,
  input: CreateMagicLinkTokenInput
): Promise<void> {
  assertSafeSchema(schema);
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    await client.query(
      `INSERT INTO "${schema}".magic_link_tokens (token_hash, email, organization_id, role, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        input.tokenHash,
        input.email,
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
 * succeed. If it matched nothing, a follow-up SELECT (no race risk,
 * purely diagnostic) reports whether the token never existed or was
 * already consumed/expired.
 */
export async function redeemMagicLinkToken(
  databaseUrl: string,
  schema: string,
  tokenHash: string,
  now: Date = new Date()
): Promise<MagicLinkRedemptionAttempt> {
  assertSafeSchema(schema);
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    const redeemed = await client.query<MagicLinkTokenRow>(
      `UPDATE "${schema}".magic_link_tokens
          SET consumed_at = $2
        WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > $2
        RETURNING email, organization_id, role, expires_at, consumed_at`,
      [tokenHash, now]
    );
    const redeemedRow = redeemed.rows[0];
    if (redeemedRow !== undefined) {
      return { justRedeemed: true, record: mapMagicLinkTokenRow(redeemedRow) };
    }

    const existing = await client.query<MagicLinkTokenRow>(
      `SELECT email, organization_id, role, expires_at, consumed_at
         FROM "${schema}".magic_link_tokens WHERE token_hash = $1`,
      [tokenHash]
    );
    const existingRow = existing.rows[0];
    return {
      justRedeemed: false,
      record: existingRow === undefined ? undefined : mapMagicLinkTokenRow(existingRow)
    };
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

export async function appendAuditEvent(
  databaseUrl: string,
  schema: string,
  input: AppendAuditEventInput
): Promise<void> {
  assertSafeSchema(schema);
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    await client.query(
      `INSERT INTO "${schema}".audit_events
         (organization_id, actor_user_id, action, entity_type, entity_id, request_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [input.organizationId, input.actorUserId, input.action, input.entityType, input.entityId, input.requestId]
    );
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

export interface CreateInvitedUserInput {
  readonly email: string;
  /** No display name travels with an invite; the local part of the email
   * is a placeholder the user can change once they're in, not a real name. */
  readonly displayName: string;
  readonly organizationId: string;
  readonly role: MembershipRole;
}

/** Both inserts happen in one transaction: either the user gains exactly
 * the membership their invite named, or neither row is created. */
export async function createInvitedUser(
  databaseUrl: string,
  schema: string,
  input: CreateInvitedUserInput
): Promise<User> {
  assertSafeSchema(schema);
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    await client.query("BEGIN");
    try {
      const userResult = await client.query<UserRow>(
        `INSERT INTO "${schema}".users (email, display_name)
         VALUES ($1, $2)
         ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
         RETURNING user_id, email, display_name, created_at`,
        [input.email, input.displayName]
      );
      const row = userResult.rows[0];
      if (row === undefined) {
        throw new Error("user upsert returned no row");
      }
      await client.query(
        `INSERT INTO "${schema}".memberships (organization_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (organization_id, user_id) DO NOTHING`,
        [input.organizationId, row.user_id, input.role]
      );
      await client.query("COMMIT");
      return rowToUser(row);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
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

function roleFromRow(row: RoleRow): Role {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    roleId: row.role_id,
    organizationId: row.organization_id,
    title: row.title,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at.toISOString()
  };
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
    return roleFromRow(row);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Roles for one organization, newest first. Caller must already have
 * authorized that the organizationId belongs to the session's user --
 * this query does not check membership. */
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
    return result.rows.map(roleFromRow);
  } finally {
    await client.end().catch(() => undefined);
  }
}

interface OrganizationRow {
  readonly organization_id: string;
  readonly name: string;
  readonly created_at: Date;
}

function organizationFromRow(row: OrganizationRow): Organization {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    organizationId: row.organization_id,
    name: row.name,
    createdAt: row.created_at.toISOString()
  };
}

/** Organizations the caller already knows about from their own memberships.
 * Empty `organizationIds` short-circuits rather than running `= ANY('{}')`. */
export async function getOrganizationsByIds(
  databaseUrl: string,
  schema: string,
  organizationIds: readonly string[]
): Promise<readonly Organization[]> {
  if (organizationIds.length === 0) {
    return [];
  }
  assertSafeSchema(schema);
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    const result = await client.query<OrganizationRow>(
      `SELECT organization_id, name, created_at
         FROM "${schema}".organizations
        WHERE organization_id = ANY($1::uuid[])`,
      [organizationIds]
    );
    return result.rows.map(organizationFromRow);
  } finally {
    await client.end().catch(() => undefined);
  }
}
