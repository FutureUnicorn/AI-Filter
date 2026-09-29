import assert from "node:assert/strict";
import test from "node:test";

import { dropProbeSchema, getFileIntakeById, provisionFileIntakeRouteSchema } from "../../packages/db/src/index.ts";
import { ALLOWED_SNIFFED_MIME_TYPES } from "../../packages/domain/src/index.ts";
import { storageControl } from "../support/ingestion-storage-stub.ts";
import {
  applyRouteEnvironment,
  loadRouteHandler,
  registerModuleRedirect,
  requireRouteDatabase,
  routeRequest
} from "../support/route-harness.ts";

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

const REAL_HASH = "a".repeat(64);

/**
 * AF-100: the mechanism this file used to carry -- the resolution hook, the
 * runtime-built specifier, the genuine NextRequest, the environment -- now
 * lives in tests/support/route-harness.ts, which is the repository's one way
 * to drive a route. Only the part that is specific to these tests is left
 * here: the stub standing in for object storage, and this file's own probe,
 * which seeds an intake rather than the harness's application chain.
 *
 * Registered at module scope, before any route is imported: Node caches a
 * module the first time a route asks for it, so a redirect installed later
 * would silently not apply.
 */
registerModuleRedirect("@signal-audit/ingestion", new URL("../support/ingestion-storage-stub.ts", import.meta.url).href);

const VALIDATE_ROUTE = "roles/[roleId]/files/[intakeId]/validate";
const CSV_PREVIEW_ROUTE = "roles/[roleId]/files/[intakeId]/csv-preview";

/** Drive one of these routes as a signed-in member of the probe's organization. */
async function postAsMember(
  route: string,
  probe: { readonly roleId: string; readonly intakeId: string; readonly userId: string },
  body?: unknown
): Promise<Response> {
  const handler = await loadRouteHandler(route, "POST");
  assert.ok(handler !== undefined, `apps/web/src/app/api/${route}/route.ts exports no POST`);
  const params = { roleId: probe.roleId, intakeId: probe.intakeId };
  const request = routeRequest({ route, method: "POST", params, as: "recruiter", body }, probe.userId);
  return handler(request, { params: Promise.resolve(params) });
}

// ---- Finding 1: the unwired archiveUninspectable flag ----

test("a DOCX whose central directory cannot be read is quarantined by the validate route", async () => {
  const databaseUrl = requireRouteDatabase();
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

    const response = await postAsMember(VALIDATE_ROUTE, probe);
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
  const databaseUrl = requireRouteDatabase();
  const probe = await provisionFileIntakeRouteSchema(databaseUrl, {
    declaredFilename: "huge.pdf",
    declaredMimeType: ALLOWED_SNIFFED_MIME_TYPES.pdf
  });
  try {
    applyRouteEnvironment(databaseUrl, probe.schema);
    storageControl.behaviour = { kind: "too_large", limitBytes: 1024, observedBytes: 8192 };

    const response = await postAsMember(VALIDATE_ROUTE, probe);

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
  const databaseUrl = requireRouteDatabase();
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

    const response = await postAsMember(CSV_PREVIEW_ROUTE, probe, {});
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
  const databaseUrl = requireRouteDatabase();
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

    const response = await postAsMember(CSV_PREVIEW_ROUTE, probe, {});
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
