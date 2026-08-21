import type {
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
