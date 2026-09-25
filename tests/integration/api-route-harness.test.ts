import assert from "node:assert/strict";
import test from "node:test";

import { CONTRACT_SCHEMA_VERSION } from "../../packages/domain/src/index.ts";
import { loadRouteMethods, withApiRouteHarness } from "../support/route-harness.ts";

/**
 * AF-100: the first tests in this repository that issue a real request to a
 * real route handler and then look at the rows it produced.
 *
 * The two endpoints driven here are the two that append to a human-attributed
 * audit trail: a candidate decision and an evidence correction. Both take
 * their actor from the session and from nowhere else, and until now that
 * claim was checked by matching the source text of the handler -- a guard that
 * an unused import or a doc comment can satisfy. Each test below states the
 * claim as a request and a row instead.
 *
 * The ticket also names AF-54's review-timing endpoint. It is not on develop:
 * there is no timing migration, no timing writer and no timing route to drive,
 * so the second human-attributed writer that does exist -- evidence
 * corrections -- is covered in its place. When AF-54 lands it needs one test
 * here, not a harness.
 */

const DECISIONS_ROUTE = "roles/[roleId]/applications/[applicationId]/decisions";
const CORRECTIONS_ROUTE = "roles/[roleId]/applications/[applicationId]/evidence/[criterionId]/corrections";

interface DecisionRow extends Record<string, unknown> {
  readonly decision: string;
  readonly rationale: string;
  readonly decided_by_user_id: string;
  readonly supersedes_decision_id: string | null;
}

interface EvidenceRow extends Record<string, unknown> {
  readonly evidence_outcome_id: string;
  readonly kind: string;
  readonly corrected_by_user_id: string | null;
  readonly correction_reason: string | null;
  readonly supersedes_evidence_outcome_id: string | null;
}

const DECISION_ROWS = `SELECT decision, rationale, decided_by_user_id, supersedes_decision_id
                         FROM candidate_decisions WHERE application_id = $1 ORDER BY decided_at`;

const EVIDENCE_ROWS = `SELECT evidence_outcome_id, kind, corrected_by_user_id, correction_reason,
                              supersedes_evidence_outcome_id
                         FROM evidence_outcomes WHERE application_id = $1 ORDER BY recorded_at`;

function correction(criterionId: string, organizationId: string, candidateId: string): Record<string, unknown> {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "not_found",
    organizationId,
    candidateId,
    criterionId
  };
}

// ---- The claim the structural guard used to make ----
//
// tests/architecture/decision-path-isolation.test.ts asserted this by looking
// for the strings "readSessionUserId(request)" and "decidedByUserId: userId"
// in the route file. Both would still be present in a handler that read the
// session, ignored it, and wrote something else.

test("a recorded decision is attributed to the session user, taken from the cookie and nowhere else", async () => {
  await withApiRouteHarness(async (harness) => {
    const response = await harness.request({
      route: DECISIONS_ROUTE,
      method: "POST",
      params: { roleId: harness.probe.roleId, applicationId: harness.probe.applicationId },
      as: "recruiter",
      idempotencyKey: "decision-attribution-1",
      body: { decision: "advance", rationale: "strong Postgres evidence, moving to interview" }
    });
    assert.equal(response.status, 201, await response.clone().text());

    const rows = await harness.rows<DecisionRow>(DECISION_ROWS, [harness.probe.applicationId]);
    assert.equal(rows.length, 1, "exactly one decision must have been recorded");
    assert.equal(
      rows[0]?.decided_by_user_id,
      harness.userId("recruiter"),
      "the stored actor must be the user the session cookie names"
    );
    assert.equal(rows[0]?.decision, "advance");
    assert.equal(rows[0]?.rationale, "strong Postgres evidence, moving to interview");
    assert.equal(rows[0]?.supersedes_decision_id, null, "a first decision supersedes nothing");
  });
});

/**
 * The stronger form of the same claim, and the one a negative control
 * actually demanded.
 *
 * Asserting that a clean request stores the session user proves only that the
 * happy path is wired. It says nothing about a second channel: a handler that
 * reads the session, and then prefers a header or a query parameter when one
 * is present, passes both the structural guard and the test above. Verified by
 * building exactly that handler and watching all of them stay green.
 *
 * So this sends a real, membership-holding user's id down every channel a
 * handler could plausibly read, and requires the stored actor to be the one
 * that signed the request regardless.
 */
test("no channel other than the session cookie can name the decider", async () => {
  await withApiRouteHarness(async (harness) => {
    const impersonated = harness.userId("admin");
    const response = await harness.request({
      route: DECISIONS_ROUTE,
      method: "POST",
      params: { roleId: harness.probe.roleId, applicationId: harness.probe.applicationId },
      as: "recruiter",
      idempotencyKey: "decision-channels-1",
      headers: {
        "x-acting-user": impersonated,
        "x-user-id": impersonated,
        "x-on-behalf-of": impersonated
      },
      query: { decidedByUserId: impersonated, userId: impersonated },
      body: { decision: "advance", rationale: "every channel says admin; the session says recruiter" }
    });
    assert.equal(response.status, 201, await response.clone().text());

    const rows = await harness.rows<DecisionRow>(DECISION_ROWS, [harness.probe.applicationId]);
    assert.equal(rows.length, 1);
    assert.equal(
      rows[0]?.decided_by_user_id,
      harness.userId("recruiter"),
      "the decision must be attributed to the signer, not to any id the request supplied"
    );
    assert.notEqual(rows[0]?.decided_by_user_id, impersonated);
  });
});

test("a body that names its own decider is refused, and records nothing", async () => {
  await withApiRouteHarness(async (harness) => {
    // The admin's id is a real, membership-holding user in this organization,
    // so the only thing stopping it being written is the contract. A handler
    // that merged the body over the session would attribute this decision to
    // someone who never made it.
    const response = await harness.request({
      route: DECISIONS_ROUTE,
      method: "POST",
      params: { roleId: harness.probe.roleId, applicationId: harness.probe.applicationId },
      as: "recruiter",
      idempotencyKey: "decision-forged-actor-1",
      body: {
        decision: "decline",
        rationale: "attributed to someone else",
        decidedByUserId: harness.userId("admin")
      }
    });
    assert.equal(response.status, 400, "an unknown field must be rejected, not ignored");

    const rows = await harness.rows<DecisionRow>(DECISION_ROWS, [harness.probe.applicationId]);
    assert.deepEqual(rows, [], "a refused request must leave no decision behind");
  });
});

// ---- Authorization, observed at the endpoint rather than at the helper ----

test("an auditor cannot record a decision, and the refusal reaches the database as nothing", async () => {
  await withApiRouteHarness(async (harness) => {
    const response = await harness.request({
      route: DECISIONS_ROUTE,
      method: "POST",
      params: { roleId: harness.probe.roleId, applicationId: harness.probe.applicationId },
      as: "auditor",
      idempotencyKey: "decision-auditor-1",
      body: { decision: "advance", rationale: "an auditor should not be able to do this" }
    });
    assert.equal(response.status, 403, await response.clone().text());

    const rows = await harness.rows<DecisionRow>(DECISION_ROWS, [harness.probe.applicationId]);
    assert.deepEqual(rows, []);
  });
});

test("a member of another organization gets not_found, so the endpoint is not an existence oracle", async () => {
  await withApiRouteHarness(async (harness) => {
    const response = await harness.request({
      route: DECISIONS_ROUTE,
      method: "POST",
      params: { roleId: harness.probe.roleId, applicationId: harness.probe.applicationId },
      as: "outsider",
      idempotencyKey: "decision-outsider-1",
      body: { decision: "advance", rationale: "another tenant's candidate" }
    });
    // 404, not 403: a forbidden would confirm this role id is real.
    assert.equal(response.status, 404, await response.clone().text());

    const rows = await harness.rows<DecisionRow>(DECISION_ROWS, [harness.probe.applicationId]);
    assert.deepEqual(rows, []);
  });
});

test("an unauthenticated request is rejected before anything is read or written", async () => {
  await withApiRouteHarness(async (harness) => {
    const response = await harness.request({
      route: DECISIONS_ROUTE,
      method: "POST",
      params: { roleId: harness.probe.roleId, applicationId: harness.probe.applicationId },
      as: "anonymous",
      idempotencyKey: "decision-anonymous-1",
      body: { decision: "advance", rationale: "no session at all" }
    });
    assert.equal(response.status, 401, await response.clone().text());

    const rows = await harness.rows<DecisionRow>(DECISION_ROWS, [harness.probe.applicationId]);
    assert.deepEqual(rows, []);
  });
});

// ---- Idempotency, which only a second real request can show ----

test("retrying a decision with the same key replays the first response and records one decision", async () => {
  await withApiRouteHarness(async (harness) => {
    const body = { decision: "hold", rationale: "waiting on the take-home" };
    const send = (): Promise<Response> =>
      harness.request({
        route: DECISIONS_ROUTE,
        method: "POST",
        params: { roleId: harness.probe.roleId, applicationId: harness.probe.applicationId },
        as: "recruiter",
        idempotencyKey: "decision-replay-1",
        body
      });

    const first = await send();
    assert.equal(first.status, 201, await first.clone().text());
    const second = await send();

    // Identical, because a fresh 201 would be indistinguishable from having
    // recorded a second decision -- and a second decision here is a decision
    // no person made, presented by the supersede chain as the current one.
    assert.equal(second.status, first.status);
    assert.deepEqual(await second.json(), await first.json());

    const rows = await harness.rows<DecisionRow>(DECISION_ROWS, [harness.probe.applicationId]);
    assert.equal(rows.length, 1, "a retry must not append a second human decision");
  });
});

test("the same key with a different body is a conflict, not a replay", async () => {
  await withApiRouteHarness(async (harness) => {
    const first = await harness.request({
      route: DECISIONS_ROUTE,
      method: "POST",
      params: { roleId: harness.probe.roleId, applicationId: harness.probe.applicationId },
      as: "recruiter",
      idempotencyKey: "decision-mismatch-1",
      body: { decision: "advance", rationale: "first body" }
    });
    assert.equal(first.status, 201, await first.clone().text());

    const second = await harness.request({
      route: DECISIONS_ROUTE,
      method: "POST",
      params: { roleId: harness.probe.roleId, applicationId: harness.probe.applicationId },
      as: "recruiter",
      idempotencyKey: "decision-mismatch-1",
      body: { decision: "decline", rationale: "different body, same key" }
    });
    assert.equal(second.status, 409, await second.clone().text());

    const rows = await harness.rows<DecisionRow>(DECISION_ROWS, [harness.probe.applicationId]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.decision, "advance", "the stored decision must be the one that was actually made");
  });
});

test("a POST with no Idempotency-Key is refused outright", async () => {
  await withApiRouteHarness(async (harness) => {
    const response = await harness.request({
      route: DECISIONS_ROUTE,
      method: "POST",
      params: { roleId: harness.probe.roleId, applicationId: harness.probe.applicationId },
      as: "recruiter",
      body: { decision: "advance", rationale: "no key supplied" }
    });
    assert.equal(response.status, 400, await response.clone().text());

    const rows = await harness.rows<DecisionRow>(DECISION_ROWS, [harness.probe.applicationId]);
    assert.deepEqual(rows, []);
  });
});

// ---- The read side, and the derived status ----

test("the status a reader sees is derived from the decision the writer stored", async () => {
  await withApiRouteHarness(async (harness) => {
    await harness.request({
      route: DECISIONS_ROUTE,
      method: "POST",
      params: { roleId: harness.probe.roleId, applicationId: harness.probe.applicationId },
      as: "recruiter",
      idempotencyKey: "decision-read-1",
      body: { decision: "decline", rationale: "no evidence against two of the criteria" }
    });

    const response = await harness.request({
      route: DECISIONS_ROUTE,
      method: "GET",
      params: { roleId: harness.probe.roleId, applicationId: harness.probe.applicationId },
      as: "recruiter"
    });
    assert.equal(response.status, 200, await response.clone().text());

    const body = (await response.json()) as { status: string; history: readonly { decision: string }[] };
    assert.equal(body.status, "decline");
    assert.equal(body.history.length, 1);
    assert.equal(body.history[0]?.decision, "decline");

    // The GET asks for `review_candidates`, which an auditor does not hold --
    // `view_audit_reports` is a different capability and does not reach into a
    // named candidate's workflow status. Asserted here rather than against
    // ROLE_CAPABILITIES because the question is what the endpoint does with
    // the table, not what the table says.
    const auditorResponse = await harness.request({
      route: DECISIONS_ROUTE,
      method: "GET",
      params: { roleId: harness.probe.roleId, applicationId: harness.probe.applicationId },
      as: "auditor"
    });
    assert.equal(auditorResponse.status, 403, await auditorResponse.clone().text());
  });
});

// ---- The verb inventory, read off the module rather than out of the source ----
//
// The structural version scanned the file for `export async function ([A-Z]+)(`
// and would count one inside a comment or a string. This asks the loaded
// module what it actually exports, which is the thing Next mounts.

test("the decision endpoint exposes POST and GET and no other verb", async () => {
  assert.deepEqual(await loadRouteMethods(DECISIONS_ROUTE), ["GET", "POST"]);
});

// ---- The harness's own read path ----
//
// PR #90 review, REV-001. `readProbeRows` refused a write by matching a
// leading SELECT, which checks only how the string starts. With no parameters
// `pg` uses the simple query protocol and runs several statements in one call,
// so `SELECT 1; DELETE FROM memberships` passed the guard and emptied the
// table -- measured at five rows to zero.
//
// Each case asserts the rows SURVIVE as well as that the call throws. A
// version that deleted and then threw would satisfy the throw alone, which is
// the same shape of mistake this whole file exists to stop making.

const MEMBERSHIP_COUNT = "SELECT count(*)::int AS n FROM memberships";

interface CountRow extends Record<string, unknown> {
  readonly n: number;
}

const REFUSED_READS: readonly { readonly label: string; readonly sql: string }[] = [
  // Layer 2: a second statement cannot reach the server at all.
  { label: "a second statement appended after a SELECT", sql: "SELECT 1; DELETE FROM memberships" },
  // The same shape carrying a COMMIT, which would otherwise end the read-only
  // transaction and let what follows run read-write.
  {
    label: "an injected COMMIT followed by a write",
    sql: "SELECT 1; COMMIT; DELETE FROM memberships"
  },
  // DDL, which no table trigger guards -- the first probe of this bug used a
  // table whose append-only trigger refused the delete, which made the guard
  // look sound when it was not.
  { label: "a second statement creating a table", sql: "SELECT 1; CREATE TABLE bypass_probe (x int)" },
  // Layer 3: one statement, beginning with neither SELECT nor a second
  // command, that is nonetheless a delete.
  {
    label: "a single-statement CTE delete",
    sql: "WITH d AS (DELETE FROM memberships RETURNING *) SELECT * FROM d"
  }
];

for (const refused of REFUSED_READS) {
  test(`readProbeRows refuses ${refused.label}, and the rows survive`, async () => {
    await withApiRouteHarness(async (harness) => {
      const before = await harness.rows<CountRow>(MEMBERSHIP_COUNT);
      assert.ok((before[0]?.n ?? 0) > 0, "the harness must have seeded memberships for this to mean anything");

      await assert.rejects(
        async () => harness.rows(refused.sql),
        `readProbeRows must refuse: ${refused.sql}`
      );

      const after = await harness.rows<CountRow>(MEMBERSHIP_COUNT);
      assert.equal(after[0]?.n, before[0]?.n, "a refused read must not have changed the database on its way out");
    });
  });
}

/**
 * The case that makes the read-only transaction load-bearing rather than
 * decorative.
 *
 * Raised in re-review of PR #90: `SELECT * INTO t2 FROM memberships` is ONE
 * statement that begins with `SELECT`, so the regex admits it and the
 * prepared statement admits it, and it writes. Only layer 3 refuses it.
 *
 * Added because the four cases above did not need it: removing the
 * `BEGIN READ ONLY`/`ROLLBACK` pair entirely left all twenty tests in this
 * file green, which is precisely the "two layers are decorative" state the
 * re-review warned about -- the guard would have been one layer with extra
 * reading, and nothing would have said so.
 */
test("readProbeRows refuses a SELECT that writes, which only the read-only transaction catches", async () => {
  await withApiRouteHarness(async (harness) => {
    const created = "select_into_probe";
    await assert.rejects(
      async () => harness.rows(`SELECT * INTO ${created} FROM memberships`),
      "a SELECT INTO passes both the regex and the protocol check, so the transaction must refuse it"
    );

    // The refusal has to mean the table does not exist, not merely that the
    // call threw on its way back.
    const tables = await harness.rows<CountRow>(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2",
      [harness.probe.schema, created]
    );
    assert.equal(tables[0]?.n, 0, "a refused SELECT INTO must not have created a table");
  });
});

test("readProbeRows still reads, with and without parameters", async () => {
  await withApiRouteHarness(async (harness) => {
    // The named-statement change would be easy to get wrong in the direction
    // of refusing everything, so prove both call shapes still work.
    const all = await harness.rows<CountRow>(MEMBERSHIP_COUNT);
    assert.ok((all[0]?.n ?? 0) > 0);

    const scoped = await harness.rows<CountRow>(
      "SELECT count(*)::int AS n FROM memberships WHERE organization_id = $1",
      [harness.probe.organizationId]
    );
    assert.equal(scoped[0]?.n, 4, "owner, admin, recruiter and auditor are seeded in the primary organization");
  });
});

// ---- The second human-attributed writer ----

test("a correction appends a row naming the corrector and leaves the original in place", async () => {
  await withApiRouteHarness(async (harness) => {
    const before = await harness.rows<EvidenceRow>(EVIDENCE_ROWS, [harness.probe.applicationId]);
    assert.equal(before.length, 1, "the harness seeds one pipeline-authored outcome");
    const original = before[0];
    assert.equal(original?.corrected_by_user_id, null, "the seeded outcome is not a correction");

    const response = await harness.request({
      route: CORRECTIONS_ROUTE,
      method: "POST",
      params: {
        roleId: harness.probe.roleId,
        applicationId: harness.probe.applicationId,
        criterionId: harness.probe.criterionId
      },
      as: "recruiter",
      idempotencyKey: "correction-1",
      body: {
        outcome: correction(harness.probe.criterionId, harness.probe.organizationId, harness.probe.applicationId),
        reason: "the quote is from another candidate's CV"
      }
    });
    assert.equal(response.status, 201, await response.clone().text());

    const after = await harness.rows<EvidenceRow>(EVIDENCE_ROWS, [harness.probe.applicationId]);
    assert.equal(after.length, 2, "a correction appends; it never edits");
    assert.equal(after[0]?.evidence_outcome_id, original?.evidence_outcome_id, "the original row must survive intact");
    assert.equal(after[0]?.kind, "supported");

    const appended = after[1];
    assert.equal(appended?.kind, "not_found");
    assert.equal(
      appended?.corrected_by_user_id,
      harness.userId("recruiter"),
      "the corrector must be the session user"
    );
    assert.equal(appended?.correction_reason, "the quote is from another candidate's CV");
    assert.equal(
      appended?.supersedes_evidence_outcome_id,
      original?.evidence_outcome_id,
      "the appended row must name the revision it replaced"
    );
  });
});

test("a correction whose body names a different criterion than the path is refused", async () => {
  await withApiRouteHarness(async (harness) => {
    const response = await harness.request({
      route: CORRECTIONS_ROUTE,
      method: "POST",
      params: {
        roleId: harness.probe.roleId,
        applicationId: harness.probe.applicationId,
        criterionId: harness.probe.criterionId
      },
      as: "recruiter",
      idempotencyKey: "correction-mismatched-criterion-1",
      body: {
        outcome: correction("a-different-criterion", harness.probe.organizationId, harness.probe.applicationId),
        reason: "filed against the wrong criterion"
      }
    });
    assert.equal(response.status, 400, await response.clone().text());

    const after = await harness.rows<EvidenceRow>(EVIDENCE_ROWS, [harness.probe.applicationId]);
    assert.equal(after.length, 1, "a refused correction must append nothing under either criterion");
  });
});

test("an auditor cannot correct evidence, which is a different capability from reading it", async () => {
  await withApiRouteHarness(async (harness) => {
    const response = await harness.request({
      route: CORRECTIONS_ROUTE,
      method: "POST",
      params: {
        roleId: harness.probe.roleId,
        applicationId: harness.probe.applicationId,
        criterionId: harness.probe.criterionId
      },
      as: "auditor",
      idempotencyKey: "correction-auditor-1",
      body: {
        outcome: correction(harness.probe.criterionId, harness.probe.organizationId, harness.probe.applicationId),
        reason: "an auditor should not be able to do this"
      }
    });
    assert.equal(response.status, 403, await response.clone().text());

    const after = await harness.rows<EvidenceRow>(EVIDENCE_ROWS, [harness.probe.applicationId]);
    assert.equal(after.length, 1);
  });
});

test("retrying a correction with the same key replays rather than appending a second revision", async () => {
  await withApiRouteHarness(async (harness) => {
    const send = (): Promise<Response> =>
      harness.request({
        route: CORRECTIONS_ROUTE,
        method: "POST",
        params: {
          roleId: harness.probe.roleId,
          applicationId: harness.probe.applicationId,
          criterionId: harness.probe.criterionId
        },
        as: "recruiter",
        idempotencyKey: "correction-replay-1",
        body: {
          outcome: correction(harness.probe.criterionId, harness.probe.organizationId, harness.probe.applicationId),
          reason: "re-read the source; the original quote was someone else's"
        }
      });

    const first = await send();
    assert.equal(first.status, 201, await first.clone().text());
    const second = await send();

    assert.equal(second.status, first.status);
    assert.deepEqual(await second.json(), await first.json());

    const after = await harness.rows<EvidenceRow>(EVIDENCE_ROWS, [harness.probe.applicationId]);
    assert.equal(after.length, 2, "a retry must not record a second correction no reviewer made");
  });
});
