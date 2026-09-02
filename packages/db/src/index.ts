import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AuditAction,
  DomainPort,
  MagicLinkInvite,
  MagicLinkRedemptionAttempt,
  MagicLinkTokenRecord,
  MembershipRole
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
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`recordInferenceUsage requires a non-negative integer ${field}, got: ${value}`);
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
      inputTokens: row === undefined ? 0 : bigintColumnToNumber(row.input_tokens, "input_tokens"),
      outputTokens: row === undefined ? 0 : bigintColumnToNumber(row.output_tokens, "output_tokens")
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

export interface ReserveInferenceBudgetInput extends RecordInferenceUsageInput {
  /** Cap on (input + output) tokens for this organization/model/period. */
  readonly maxTotalTokens: number;
}

export type ReserveInferenceBudgetOutcome =
  | { readonly outcome: "reserved"; readonly totalTokensAfter: number }
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
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    const reserved = await client.query<{ total_tokens: string }>(
      `INSERT INTO "${schema}".inference_usage_ledger
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
       RETURNING (input_tokens + output_tokens)::bigint AS total_tokens`,
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
      return { outcome: "reserved", totalTokensAfter: bigintColumnToNumber(row.total_tokens, "total_tokens") };
    }
    // Read back on the connection already open, rather than calling
    // getInferenceUsage and opening a second one. This is the capped path,
    // which is the hot one exactly when a tenant is hammering the cap.
    const current = await client.query<{ input_tokens: string; output_tokens: string }>(
      `SELECT input_tokens, output_tokens FROM "${schema}".inference_usage_ledger
        WHERE organization_id = $1 AND model = $2 AND period_start = $3`,
      [input.organizationId, input.model, input.periodStart]
    );
    const currentRow = current.rows[0];
    const totalTokensBefore =
      currentRow === undefined
        ? 0
        : bigintColumnToNumber(currentRow.input_tokens, "input_tokens") +
          bigintColumnToNumber(currentRow.output_tokens, "output_tokens");
    return {
      outcome: "cap_exceeded",
      totalTokensBefore,
      maxTotalTokens: input.maxTotalTokens
    };
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
    // 0004 uses FORCE ROW LEVEL SECURITY, so the table OWNER is subject to
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
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
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
