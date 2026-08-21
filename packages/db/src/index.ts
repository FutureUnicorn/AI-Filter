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
