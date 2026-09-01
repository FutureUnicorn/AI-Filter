import assert from "node:assert/strict";
import test from "node:test";

import {
  PRIVACY_REQUEST_MAX_EXTENSION_MONTHS,
  PRIVACY_REQUEST_RESPONSE_MONTHS,
  addCalendarMonths,
  canExtendPrivacyRequest,
  computePrivacyRequestDueDate,
  describeDeletionRequestOutcome,
  describeExportRequestOutcome,
  isPrivacyRequestOverdue,
  planCandidateDataErasure,
  summarizeCandidateDataErasureResidue,
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
  const residue = summarizeCandidateDataErasureResidue(planCandidateDataErasure("retention_expiry"));
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
