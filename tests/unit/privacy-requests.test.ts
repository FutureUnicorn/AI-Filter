import assert from "node:assert/strict";
import test from "node:test";

import {
  addCalendarMonths,
  canExtendPrivacyRequest,
  computePrivacyRequestDueDate,
  describeDeletionRequestOutcome,
  describeExportRequestOutcome,
  describePrivacyRequestTimeliness,
  isPrivacyRequestOverdue,
  isPrivacyRequestTerminal,
  planCandidateDataErasure,
  PRIVACY_REQUEST_MAX_EXTENSION_MONTHS,
  PRIVACY_REQUEST_RESPONSE_MONTHS,
  summarizeCandidateDataErasureResidue,
  validatePrivacyRequestExtensionMonths,
  validatePrivacyRequestTransition
} from "../../packages/domain/src/index.ts";

// AF-64. The deadline is a legal obligation, so the arithmetic is asserted
// on the dates that separate a correct implementation from one that merely
// looks correct.

test("a calendar month clamps to the end of a short month", () => {
  // JavaScript's own setMonth overflows instead of clamping: 31 January
  // plus one month becomes 3 March, a deadline two days past the one the
  // law allows, produced by code that reads as obviously fine.
  assert.equal(
    addCalendarMonths(new Date("2026-01-31T09:00:00.000Z"), 1).toISOString(),
    "2026-02-28T09:00:00.000Z"
  );
  // And the leap year, so the clamp is a real month-length lookup rather
  // than a hardcoded 28.
  assert.equal(
    addCalendarMonths(new Date("2028-01-31T09:00:00.000Z"), 1).toISOString(),
    "2028-02-29T09:00:00.000Z"
  );
  assert.equal(
    addCalendarMonths(new Date("2026-03-31T00:00:00.000Z"), 1).toISOString(),
    "2026-04-30T00:00:00.000Z"
  );
});

test("a calendar month is not thirty days", () => {
  // The distinction the whole rule turns on. February is the month where
  // a 30-day approximation is late rather than early.
  const received = new Date("2026-01-31T00:00:00.000Z");
  const due = new Date(computePrivacyRequestDueDate(received));
  const thirtyDays = new Date(received.getTime() + 30 * 24 * 60 * 60 * 1000);
  assert.ok(due.getTime() < thirtyDays.getTime(), "a 30-day rule would answer after the deadline");
});

test("calendar months roll across a year boundary", () => {
  assert.equal(
    addCalendarMonths(new Date("2026-12-15T12:00:00.000Z"), 2).toISOString(),
    "2027-02-15T12:00:00.000Z"
  );
});

test("the due date honours the base period and the statutory ceiling", () => {
  const received = new Date("2026-03-10T00:00:00.000Z");
  assert.equal(computePrivacyRequestDueDate(received), "2026-04-10T00:00:00.000Z");
  assert.equal(
    computePrivacyRequestDueDate(received, PRIVACY_REQUEST_MAX_EXTENSION_MONTHS),
    "2026-06-10T00:00:00.000Z"
  );
  assert.equal(PRIVACY_REQUEST_RESPONSE_MONTHS, 1);
  assert.throws(
    () => computePrivacyRequestDueDate(received, PRIVACY_REQUEST_MAX_EXTENSION_MONTHS + 1),
    /extended by at most 2 months/
  );
  assert.throws(() => computePrivacyRequestDueDate(received, -1), /whole number of months and not negative/);
});

test("an extension is only available inside the original month", () => {
  // Article 12(3) requires the data subject to be told about the extension
  // within the first month. After that the request is simply late, and
  // recording an extension would relabel a breach as compliance.
  const received = new Date("2026-01-31T09:00:00.000Z");
  assert.equal(canExtendPrivacyRequest(received, new Date("2026-02-20T09:00:00.000Z")), true);
  assert.equal(canExtendPrivacyRequest(received, new Date("2026-02-28T09:00:00.000Z")), true);
  assert.equal(canExtendPrivacyRequest(received, new Date("2026-03-01T09:00:00.000Z")), false);
});

test("an extension grants one or two further months, never zero and never three", () => {
  // REV-001. computePrivacyRequestDueDate accepts 0, because an unextended
  // request is due after 0 extra months. An extension of 0 would record that
  // a deadline moved without moving it, and 3 is past Article 12(3)'s cap.
  assert.doesNotThrow(() => validatePrivacyRequestExtensionMonths(1));
  assert.doesNotThrow(() => validatePrivacyRequestExtensionMonths(PRIVACY_REQUEST_MAX_EXTENSION_MONTHS));
  for (const months of [0, 3, -1, 1.5, Number.NaN]) {
    assert.throws(() => validatePrivacyRequestExtensionMonths(months), /from 1 to 2/, `${months} must be refused`);
  }
});

test("only a resolved request is terminal, so only an open one can be extended", () => {
  assert.equal(isPrivacyRequestTerminal("received"), false);
  assert.equal(isPrivacyRequestTerminal("in_progress"), false);
  assert.equal(isPrivacyRequestTerminal("completed"), true);
  assert.equal(isPrivacyRequestTerminal("refused"), true);
});

test("resolved requests are terminal", () => {
  // A request that has been answered must not reopen and acquire a fresh
  // deadline; a second request is a second row with its own clock.
  assert.doesNotThrow(() => validatePrivacyRequestTransition("received", "in_progress"));
  assert.doesNotThrow(() => validatePrivacyRequestTransition("received", "refused"));
  assert.doesNotThrow(() => validatePrivacyRequestTransition("in_progress", "completed"));
  assert.throws(
    () => validatePrivacyRequestTransition("completed", "in_progress"),
    /completed is terminal/
  );
  assert.throws(() => validatePrivacyRequestTransition("refused", "completed"), /refused is terminal/);
  assert.throws(
    () => validatePrivacyRequestTransition("in_progress", "received"),
    /cannot move from in_progress to received/
  );
  assert.throws(
    () => validatePrivacyRequestTransition("received", "received"),
    /must change the status/
  );
});

test("overdue means unanswered past the deadline, not merely past it", () => {
  // Otherwise every historical request becomes a breach the moment its due
  // date passes, and the overdue list stops meaning anything.
  const clock = { receivedAt: "2026-01-31T00:00:00.000Z", dueAt: "2026-02-28T00:00:00.000Z" };
  const late = new Date("2026-03-05T00:00:00.000Z");
  assert.equal(isPrivacyRequestOverdue({ ...clock, status: "received" }, late), true);
  assert.equal(isPrivacyRequestOverdue({ ...clock, status: "in_progress" }, late), true);
  assert.equal(isPrivacyRequestOverdue({ ...clock, status: "completed" }, late), false);
  assert.equal(isPrivacyRequestOverdue({ ...clock, status: "refused" }, late), false);
  assert.equal(
    isPrivacyRequestOverdue({ ...clock, status: "received" }, new Date("2026-02-01T00:00:00.000Z")),
    false
  );
});

test("a deletion request is not reported as satisfied while residue remains", () => {
  // The case this exists for: answering "yes, deleted" to someone who
  // explicitly asked, while their verbatim quote is still stored, is the
  // false statement AF-61 and AF-62 were both built to avoid.
  // The run outcome is required with no default (AF-62 REV-008), and the
  // values here are the BEST case on purpose: the intake was erased, the
  // object was deleted, nothing still references it. The answer is still
  // not complete, because the append-only surfaces are what block it --
  // which is the point. Passing a pessimistic outcome would let this test
  // pass for the wrong reason.
  const residue = summarizeCandidateDataErasureResidue(planCandidateDataErasure("retention_expiry"), {
    intakeErased: true,
    objectStorageDeleted: true,
    applicationsStillReferencingIntake: 0
  });
  const outcome = describeDeletionRequestOutcome(residue);
  assert.equal(outcome.kind, "delete");
  assert.equal(outcome.complete, false, "residue is outstanding, so the answer is not complete");
  assert.match(outcome.statement, /AF-91/);
});

test("an export request is answerable in full, and must name its surfaces", () => {
  // The two kinds fail in opposite places: content that cannot be erased
  // is still content that can be read.
  const outcome = describeExportRequestOutcome(["applications", "evidence_outcomes"]);
  assert.equal(outcome.complete, true);
  assert.match(outcome.statement, /applications; evidence_outcomes/);
  assert.throws(() => describeExportRequestOutcome([]), /must name the surfaces/);
});

// ---- REV-002: the retrospective half of the deadline ----
//
// isPrivacyRequestOverdue answers "is this still open and past due",
// which is the operational half and is correct. The half a regulator or
// an internal audit asks -- was this request answered in time -- had no
// support, and the data only carried half of it: a completed request
// recorded completed_at, a refused one recorded nothing, so dating a
// refusal meant joining privacy_request_events. resolved_by_user_id was
// already symmetric across both terminal states, which is what made the
// timestamp an oversight rather than a design.

function resolved(
  status: "completed" | "refused",
  resolvedAt: string
): PrivacyRequestClock {
  return {
    status,
    receivedAt: "2026-01-05T09:00:00.000Z",
    dueAt: "2026-02-05T09:00:00.000Z",
    resolvedAt
  };
}

test("a request answered before its deadline reads as on time, whichever way it was answered", () => {
  // Both terminal states, because the asymmetry was the finding.
  for (const status of ["completed", "refused"] as const) {
    assert.equal(
      describePrivacyRequestTimeliness(resolved(status, "2026-02-01T09:00:00.000Z")),
      "on_time",
      `a ${status} request answered four days early must read as on time`
    );
  }
});

test("a request answered after its deadline reads as late, and keeps reading late forever", () => {
  for (const status of ["completed", "refused"] as const) {
    assert.equal(describePrivacyRequestTimeliness(resolved(status, "2026-02-06T09:00:00.000Z")), "late");
  }
  // The distinction from isPrivacyRequestOverdue, stated: that one goes
  // false the moment a request is resolved, whatever the resolution cost.
  // A late answer must not launder itself into compliance by being given.
  const lateButAnswered = resolved("completed", "2026-03-01T09:00:00.000Z");
  assert.equal(isPrivacyRequestOverdue(lateButAnswered, new Date("2026-06-01T09:00:00.000Z")), false);
  assert.equal(describePrivacyRequestTimeliness(lateButAnswered), "late");
});

test("answering exactly on the deadline is answering in time", () => {
  assert.equal(describePrivacyRequestTimeliness(resolved("completed", "2026-02-05T09:00:00.000Z")), "on_time");
});

test("an unresolved request is unresolved, not compliant and not a breach", () => {
  // Three outcomes rather than a boolean. Collapsing "not answered yet"
  // into either side would either count an open request as compliant or
  // count it as a breach twice, once here and once via
  // isPrivacyRequestOverdue.
  for (const status of ["received", "in_progress"] as const) {
    assert.equal(
      describePrivacyRequestTimeliness({
        status,
        receivedAt: "2026-01-05T09:00:00.000Z",
        dueAt: "2026-02-05T09:00:00.000Z"
      }),
      "unresolved"
    );
  }
});

test("a terminal request with no resolution timestamp is refused, not passed", () => {
  // The schema forbids it -- privacy_requests_resolution_is_recorded is an
  // equivalence -- so reaching this means the value came from somewhere
  // other than that table. Answering on_time would be an unearned pass for
  // a request nobody can date.
  assert.throws(
    () =>
      describePrivacyRequestTimeliness({
        status: "refused",
        receivedAt: "2026-01-05T09:00:00.000Z",
        dueAt: "2026-02-05T09:00:00.000Z"
      }),
    /must carry resolvedAt/
  );
});

test("an unreadable timestamp is refused rather than taken as on time", () => {
  // NaN compares false against everything, so an unparseable value would
  // silently take the on_time branch. Same fail-open shape AF-66 REV-003
  // removed from authorizeSupportAccess.
  assert.throws(() => describePrivacyRequestTimeliness(resolved("completed", "not-a-date")), /readable timestamps/);
  assert.throws(
    () =>
      describePrivacyRequestTimeliness({
        status: "completed",
        receivedAt: "2026-01-05T09:00:00.000Z",
        dueAt: "nonsense",
        resolvedAt: "2026-02-01T09:00:00.000Z"
      }),
    /readable timestamps/
  );
});
