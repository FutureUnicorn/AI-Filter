import assert from "node:assert/strict";
import test from "node:test";

import { dropProbeSchema, getFileIntakeById, provisionFileIntakeRouteSchema } from "../../packages/db/src/index.ts";
import { ALLOWED_SNIFFED_MIME_TYPES } from "../../packages/domain/src/index.ts";
import { SESSION_COOKIE_NAME, createSessionToken } from "../../packages/security/src/index.ts";
import { storageControl } from "../support/ingestion-storage-stub.ts";
import { loadWebRoute } from "../support/web-route-loader.ts";

/**
 * PR #83 review round 2. Sai's note was "cover the endpoint behavior, not just
 * the ingestion helper", and both findings he raised were exactly that gap:
 *
 *   1. `archiveUninspectable` was set by the sniffer and honoured by the
 *      evaluator, each with its own passing unit test, and nothing carried it
 *      between them. A ZIP64 or malformed DOCX still validated. Two green
 *      tests either side of a disconnected wire prove nothing about the path
 *      that ships.
 *   2. `ObjectTooLargeError` and `ObjectChangedError` were introduced so
 *      callers could respond to them, and no caller was changed. They fell
 *      into the generic catch and answered 500, which leaves the intake in a
 *      state that invites the same request again forever.
 *
 * Both are only visible from the handler, so this drives the real handlers.
 * The single thing faked is object storage, because CI has no object store;
 * the errors themselves are the real classes, thrown from the real module, so
 * the `instanceof` checks under test are the ones that run in production.
 */

const SESSION_SECRET = "intake-route-test-session-secret-at-least-32-chars";
const REAL_HASH = "a".repeat(64);

function requireDatabase(): string {
  const databaseUrl = process.env.SIGNAL_AUDIT_RLS_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    assert.fail(
      "SIGNAL_AUDIT_RLS_DATABASE_URL must be set so the file-intake routes run against real Postgres. " +
        "Locally: run `pnpm dev:infra`, then point it at signal_audit_local (see README.md)."
    );
  }
  return databaseUrl;
}

interface PostRouteModule {
  POST(request: unknown, context: { params: Promise<Record<string, string>> }): Promise<Response>;
}

/**
 * The resolution hook and the runtime-built specifier live in
 * tests/support/web-route-loader.ts. The one thing specific to this file is
 * the redirect: `@signal-audit/ingestion` points at the stub, because CI
 * provides Postgres and no object store. It is scoped to that one specifier,
 * so every other import in the route -- the database, the domain rules, the
 * authorization check -- stays real.
 */
async function loadRoute(relativePath: string): Promise<PostRouteModule> {
  return loadWebRoute<PostRouteModule>(import.meta.url, relativePath, {
    "@signal-audit/ingestion": new URL("../support/ingestion-storage-stub.ts", import.meta.url).href
  });
}

function applyRouteEnvironment(databaseUrl: string, schema: string): void {
  Object.assign(process.env, {
    APP_ENV: "test",
    DEPLOYMENT_COMMIT_SHA: "0000000",
    DATABASE_URL: databaseUrl,
    DATABASE_SCHEMA: schema,
    STORAGE_ENDPOINT: "http://localhost:9000",
    STORAGE_REGION: "us-east-1",
    STORAGE_BUCKET: "signal-audit-test",
    STORAGE_ACCESS_KEY_ID: "test-access-key",
    STORAGE_SECRET_ACCESS_KEY: "test-secret-access-key",
    STORAGE_FORCE_PATH_STYLE: "true",
    WEB_PORT: "3000",
    WORKER_PORT: "3001",
    PUBLIC_APP_ORIGIN: "http://localhost:3000",
    SESSION_SECRET
  });
}

/**
 * The genuine NextRequest, loaded from apps/web's own installed Next.
 *
 * readSessionUserId reads `request.cookies.get(...)`, which is Next's API and
 * not the WHATWG Request's. Hand-rolling a `cookies` object would be faking
 * the exact surface every one of these handlers authenticates through, so the
 * real class is used and only its module path is resolved by hand: `next` is
 * installed under apps/web, which a test at the repository root cannot reach
 * by bare specifier.
 */
const nextServerUrl = new URL("../../apps/web/node_modules/next/server.js", import.meta.url).href;
const { NextRequest } = (await import(nextServerUrl)) as {
  NextRequest: new (url: string, init?: RequestInit) => NextRequestLike;
};

interface NextRequestLike extends Request {
  readonly cookies: { get(name: string): { value: string } | undefined };
}

function authorizedRequest(url: string, userId: string, body?: unknown): NextRequestLike {
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(createSessionToken(userId, SESSION_SECRET))}`
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

const VALIDATE_ROUTE = "../../apps/web/src/app/api/roles/[roleId]/files/[intakeId]/validate/route.ts";
const CSV_PREVIEW_ROUTE = "../../apps/web/src/app/api/roles/[roleId]/files/[intakeId]/csv-preview/route.ts";

// ---- Finding 1: the unwired archiveUninspectable flag ----

test("a DOCX whose central directory cannot be read is quarantined by the validate route", async () => {
  const databaseUrl = requireDatabase();
  const probe = await provisionFileIntakeRouteSchema(databaseUrl, {
    declaredFilename: "resume.docx",
    declaredMimeType: ALLOWED_SNIFFED_MIME_TYPES.docx
  });
  try {
    applyRouteEnvironment(databaseUrl, probe.schema);
    // Exactly what sniffUploadedFile returns for a ZIP64 or malformed DOCX:
    // a recognized DOCX MIME, a real hash, no knowable expansion size, and
    // the flag saying why the size is missing. Before the fix the route
    // dropped that last field and the file validated like any other DOCX.
    storageControl.behaviour = {
      kind: "sniffed",
      sniffed: {
        sizeBytes: 4096,
        sniffedMimeType: ALLOWED_SNIFFED_MIME_TYPES.docx,
        sha256Hash: REAL_HASH,
        archiveUninspectable: true
      }
    };

    const route = await loadRoute(VALIDATE_ROUTE);
    const response = await route.POST(
      authorizedRequest(
        `http://localhost:3000/api/roles/${probe.roleId}/files/${probe.intakeId}/validate`,
        probe.userId
      ),
      { params: Promise.resolve({ roleId: probe.roleId, intakeId: probe.intakeId }) }
    );
    assert.equal(response.status, 200, await response.clone().text());

    const stored = await getFileIntakeById(databaseUrl, probe.schema, probe.intakeId);
    assert.equal(
      stored?.status,
      "quarantined",
      "an archive whose contents cannot be inspected must not be accepted as a validated DOCX"
    );
  } finally {
    await dropProbeSchema(databaseUrl, probe.schema);
  }
});

// ---- Finding 2: typed errors that no caller handled ----

test("an object over the read cap makes the validate route answer 413 and quarantine the intake", async () => {
  const databaseUrl = requireDatabase();
  const probe = await provisionFileIntakeRouteSchema(databaseUrl, {
    declaredFilename: "huge.pdf",
    declaredMimeType: ALLOWED_SNIFFED_MIME_TYPES.pdf
  });
  try {
    applyRouteEnvironment(databaseUrl, probe.schema);
    storageControl.behaviour = { kind: "too_large", limitBytes: 1024, observedBytes: 8192 };

    const route = await loadRoute(VALIDATE_ROUTE);
    const response = await route.POST(
      authorizedRequest(
        `http://localhost:3000/api/roles/${probe.roleId}/files/${probe.intakeId}/validate`,
        probe.userId
      ),
      { params: Promise.resolve({ roleId: probe.roleId, intakeId: probe.intakeId }) }
    );

    // 500 was the old answer. It is the wrong one twice over: it says the
    // server failed when the client's object is the problem, and it invites
    // an identical retry that will buffer up to the cap again.
    assert.equal(response.status, 413, await response.clone().text());

    const stored = await getFileIntakeById(databaseUrl, probe.schema, probe.intakeId);
    assert.equal(stored?.status, "quarantined", "an oversized object must not stay retryable as `uploaded`");
  } finally {
    await dropProbeSchema(databaseUrl, probe.schema);
  }
});

test("an object replaced after validation makes a reader answer 409 and quarantine the intake", async () => {
  const databaseUrl = requireDatabase();
  const probe = await provisionFileIntakeRouteSchema(databaseUrl, {
    declaredFilename: "candidates.csv",
    declaredMimeType: "text/csv",
    status: "validated",
    sniffedMimeType: ALLOWED_SNIFFED_MIME_TYPES.csv,
    sha256Hash: REAL_HASH,
    sizeBytes: 512
  });
  try {
    applyRouteEnvironment(databaseUrl, probe.schema);
    storageControl.behaviour = { kind: "changed", actual: "b".repeat(64) };

    const route = await loadRoute(CSV_PREVIEW_ROUTE);
    const response = await route.POST(
      authorizedRequest(
        `http://localhost:3000/api/roles/${probe.roleId}/files/${probe.intakeId}/csv-preview`,
        probe.userId,
        {}
      ),
      { params: Promise.resolve({ roleId: probe.roleId, intakeId: probe.intakeId }) }
    );
    assert.equal(response.status, 409, await response.clone().text());

    const stored = await getFileIntakeById(databaseUrl, probe.schema, probe.intakeId);
    assert.equal(stored?.status, "quarantined", "a substituted object must not stay `validated`");

    // The validated digest is deliberately kept. It is the evidence of what
    // was actually approved, and clearing it would make the quarantine
    // unauditable after the fact.
    assert.equal(stored?.sha256Hash, REAL_HASH, "the validated hash must survive the quarantine");
  } finally {
    await dropProbeSchema(databaseUrl, probe.schema);
  }
});

/**
 * PR #83 review round 5, REV-014. Previously left `validated` on the theory
 * that an oversized read says nothing about whether the stored bytes are the
 * approved ones. That theory didn't hold: the approved bytes already passed
 * this same limit during validation (evaluateFileValidation, review #83
 * P1), so bytes that now exceed it cannot be those bytes -- the object was
 * replaced after validation, exactly like a hash mismatch. Leaving the
 * intake `validated` stranded it forever: every reader kept answering 413
 * with no quarantine/re-upload path back.
 *
 * csv-preview is driven here because it is the route the finding cited, but
 * extract-text, finalize and import-status hit the identical branch and all
 * four call the same invalidateOversizedIntake, so this proves the shared
 * fix rather than a per-route patch.
 */
test("an oversized read from a post-validation reader answers 413 and quarantines the intake", async () => {
  const databaseUrl = requireDatabase();
  const probe = await provisionFileIntakeRouteSchema(databaseUrl, {
    declaredFilename: "candidates.csv",
    declaredMimeType: "text/csv",
    status: "validated",
    sniffedMimeType: ALLOWED_SNIFFED_MIME_TYPES.csv,
    sha256Hash: REAL_HASH,
    sizeBytes: 512
  });
  try {
    applyRouteEnvironment(databaseUrl, probe.schema);
    storageControl.behaviour = { kind: "too_large", limitBytes: 1024, observedBytes: 99_999 };

    const route = await loadRoute(CSV_PREVIEW_ROUTE);
    const response = await route.POST(
      authorizedRequest(
        `http://localhost:3000/api/roles/${probe.roleId}/files/${probe.intakeId}/csv-preview`,
        probe.userId,
        {}
      ),
      { params: Promise.resolve({ roleId: probe.roleId, intakeId: probe.intakeId }) }
    );
    assert.equal(response.status, 413, await response.clone().text());

    const stored = await getFileIntakeById(databaseUrl, probe.schema, probe.intakeId);
    assert.equal(stored?.status, "quarantined", "an oversized post-validation read must not leave the intake reprocessable forever");

    // The validated digest is deliberately kept, same as the hash-mismatch
    // case: it is the evidence of what was actually approved.
    assert.equal(stored?.sha256Hash, REAL_HASH, "the validated hash must survive the quarantine");
  } finally {
    await dropProbeSchema(databaseUrl, probe.schema);
  }
});
