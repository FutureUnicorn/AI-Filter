import assert from "node:assert/strict";
import test from "node:test";

import { assertPrivacyRequestLifecycle } from "../../packages/db/src/index.ts";

// AF-64. The deadline is computed twice -- once in the domain, once by the
// CHECK constraint -- and the two only agree if both clamp the end of a
// short month the same way. That agreement is proved here rather than
// assumed, along with every refusal the lifecycle depends on.

const DATABASE_URL = process.env["SIGNAL_AUDIT_RLS_DATABASE_URL"];

async function observe(): Promise<Awaited<ReturnType<typeof assertPrivacyRequestLifecycle>>> {
  if (DATABASE_URL === undefined || DATABASE_URL.length === 0) {
    assert.fail(
      "SIGNAL_AUDIT_RLS_DATABASE_URL must be set to a real Postgres connection string so this test " +
        "exercises the constraints and append-only triggers for real. See README.md."
    );
  }
  return assertPrivacyRequestLifecycle(DATABASE_URL);
}

test("the domain and the database compute the same deadline for 31 January", async () => {
  // The date that separates a correct implementation from one that looks
  // correct. JavaScript's setMonth would say 3 March here.
  const observed = await observe();
  assert.equal(observed.domainDueDateForJanuary31, observed.databaseDueDateForJanuary31);
  assert.equal(observed.domainDueDateForJanuary31, "2026-02-28T09:00:00.000Z");
});

test("an extension recorded after the first month is refused by the database", async () => {
  // Not merely discouraged in application code: backdating an extension is
  // how a late response gets relabelled as a compliant one, so the
  // constraint refuses it even for a direct SQL writer.
  const observed = await observe();
  assert.match(observed.lateExtensionRejection, /privacy_requests_extension_is_timely/);
});

test("an answered request stops being overdue; an unanswered one does not", async () => {
  const observed = await observe();
  assert.equal(observed.overdueRequestIds.length, 1);
  assert.equal(observed.completedRequestIsNotOverdue, true);
});

test("the lifecycle is recorded as transitions, not just a final status", async () => {
  const observed = await observe();
  assert.deepEqual(observed.transitionsRecorded, [
    "none->received",
    "received->in_progress",
    "in_progress->completed"
  ]);
  assert.equal(observed.eventCount, 4, "two requests: one with three events, one with one");
});

test("a completed request cannot be reopened", async () => {
  const observed = await observe();
  assert.match(observed.reopenCompletedRejection, /completed is terminal/);
});

test("the transition log cannot be rewritten", async () => {
  const observed = await observe();
  assert.match(observed.eventUpdateRejection, /append-only: UPDATE is not allowed/);
});

test("the subject kind and the application it names have to agree", async () => {
  // A candidate request is about one application and must name it; an
  // employer request is tenant-wide and has none to name.
  const observed = await observe();
  assert.match(
    observed.candidateWithoutApplicationRejection,
    /privacy_requests_subject_names_application/
  );
  assert.match(
    observed.employerWithApplicationRejection,
    /privacy_requests_subject_names_application/
  );
});

test("a completed request must name who resolved it", async () => {
  // Otherwise "completed" is a word rather than a record.
  const observed = await observe();
  assert.match(observed.unattributedResolutionRejection, /privacy_requests_resolution_is_attributed/);
});

test("one organization cannot advance another's request", async () => {
  const observed = await observe();
  assert.match(observed.crossTenantRejection, /no request .* in organization/);
});
