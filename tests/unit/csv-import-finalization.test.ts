import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalizeCsvColumnMapping,
  classifyCsvImportRow,
  normalizeAppliedAt,
  summarizeImportRows
} from "../../packages/domain/src/index.ts";
import type { CsvColumnMapping } from "../../packages/domain/src/index.ts";

test("a row with both required fields present is processed", () => {
  const classification = classifyCsvImportRow({
    candidateFullName: "Ada Lovelace",
    candidateEmail: "ada@example.com",
    externalReferenceId: undefined,
    appliedAt: undefined
  });
  assert.deepEqual(classification, { outcome: "processed" });
});

test("a row missing every required field is skipped, not failed", () => {
  const classification = classifyCsvImportRow({
    candidateFullName: undefined,
    candidateEmail: undefined,
    externalReferenceId: undefined,
    appliedAt: "2026-01-01"
  });
  assert.deepEqual(classification, { outcome: "skipped" });
});

test("a row missing only one required field is failed with a specific reason", () => {
  const classification = classifyCsvImportRow({
    candidateFullName: "Ada Lovelace",
    candidateEmail: undefined,
    externalReferenceId: undefined,
    appliedAt: undefined
  });
  assert.equal(classification.outcome, "failed");
  assert.ok(classification.outcome === "failed" && classification.reason.includes("candidateEmail"));
});

test("summarizeImportRows counts each outcome independently and totals correctly", () => {
  const rows = [
    { outcome: "processed" as const },
    { outcome: "processed" as const },
    { outcome: "failed" as const },
    { outcome: "skipped" as const }
  ];
  assert.deepEqual(summarizeImportRows(rows), {
    totalRows: 4,
    processedCount: 2,
    failedCount: 1,
    skippedCount: 1
  });
});

test("summarizeImportRows on no rows is all zeroes", () => {
  assert.deepEqual(summarizeImportRows([]), {
    totalRows: 0,
    processedCount: 0,
    failedCount: 0,
    skippedCount: 0
  });
});

test("canonicalizeCsvColumnMapping is order-independent", () => {
  const a: CsvColumnMapping[] = [
    { field: "candidateFullName", csvColumnHeader: "Full Name" },
    { field: "candidateEmail", csvColumnHeader: "Email" }
  ];
  const b: CsvColumnMapping[] = [
    { field: "candidateEmail", csvColumnHeader: "Email" },
    { field: "candidateFullName", csvColumnHeader: "Full Name" }
  ];
  assert.equal(canonicalizeCsvColumnMapping(a), canonicalizeCsvColumnMapping(b));
});

test("canonicalizeCsvColumnMapping distinguishes a genuinely different mapping", () => {
  const a: CsvColumnMapping[] = [{ field: "candidateFullName", csvColumnHeader: "Full Name" }];
  const b: CsvColumnMapping[] = [{ field: "candidateFullName", csvColumnHeader: "Name" }];
  assert.notEqual(canonicalizeCsvColumnMapping(a), canonicalizeCsvColumnMapping(b));
});

// ---- PR #83 review, P2: an invalid optional date must fail one row ----
//
// Mapping accepted any non-empty string for appliedAt and handed it to a
// timestamptz column inside the single import transaction. A cell such as
// `not-a-date` raised a cast error, rolled back every valid row, and returned
// 500. Per-row accounting means one malformed optional date is one failed
// row.
test("an unparseable appliedAt fails its own row rather than the whole import", () => {
  const complete = {
    candidateFullName: "Casey Jordan",
    candidateEmail: "casey@acme.test",
    externalReferenceId: undefined
  };

  // The shape that used to reach Postgres and abort the transaction.
  const bad = classifyCsvImportRow({ ...complete, appliedAt: "not-a-date" });
  assert.equal(bad.outcome, "failed");
  assert.match(
    bad.outcome === "failed" ? bad.reason : "",
    /appliedAt is not a valid date/u,
    "the reason must name the field, so the operator can fix that cell"
  );

  // Valid rows in the same import are unaffected: this is the property the
  // 500 destroyed.
  assert.equal(classifyCsvImportRow({ ...complete, appliedAt: "2026-03-04" }).outcome, "processed");
  assert.equal(classifyCsvImportRow({ ...complete, appliedAt: undefined }).outcome, "processed");
});

test("appliedAt normalization is strict about what it accepts", () => {
  // Accepted: date only, and full ISO with or without a zone.
  for (const value of ["2026-03-04", "2026-03-04T10:30:00Z", "2026-03-04T10:30:00.500Z", "2026-03-04 10:30:00"]) {
    const normalized = normalizeAppliedAt(value);
    assert.equal(normalized.outcome, "normalized", `${value} should be accepted`);
  }

  // Refused, and each for a different reason worth pinning:
  //   garbage                -> not a date at all
  //   2026                   -> a bare year the runtime would read as Jan 1,
  //                             silently turning a stray number into a date
  //   03/04/2026             -> ambiguous between day and month
  //   2026-02-30, 2026-13-01 -> pattern-valid but not real calendar dates,
  //                             which Date would otherwise roll forward
  //   empty / whitespace     -> not a value
  for (const value of ["garbage", "2026", "03/04/2026", "2026-02-30", "2026-13-01", "", "   "]) {
    assert.equal(normalizeAppliedAt(value).outcome, "invalid", `${JSON.stringify(value)} should be refused`);
  }

  // Normalization is canonical, not pass-through.
  const normalized = normalizeAppliedAt("2026-03-04");
  assert.equal(normalized.outcome === "normalized" ? normalized.value : "", "2026-03-04T00:00:00.000Z");
});

/**
 * PR #83 review, REV-001. Every zoned value above uses `Z`, which never shifts
 * the instant, so nothing here exercised the format the regex actually admits:
 * `[+-]HH:MM`. Under a real local offset the check compared the parsed instant's
 * UTC fields against the literal date parts, and any offset that crosses
 * midnight moves the instant into an adjacent day, month or year.
 *
 * The effect was not a rejected edge case. An ATS export carrying local
 * timestamps lost every candidate dated on the first or last day of a month,
 * and the failure told the operator their valid timestamp was not a valid date.
 */
test("a valid offset that shifts the UTC date is accepted, not called invalid", () => {
  // Crosses backwards over a year boundary: 2025-12-31T18:30:00Z.
  const backwards = normalizeAppliedAt("2026-01-01T00:00:00+05:30");
  assert.equal(backwards.outcome, "normalized", "an offset crossing into the previous year is still a real date");
  assert.equal(
    backwards.outcome === "normalized" ? backwards.value : "",
    "2025-12-31T18:30:00.000Z",
    "the stored value is the instant, so the offset is preserved rather than discarded"
  );

  // Crosses forwards over a month boundary: 2026-02-01T04:00:00Z.
  const forwards = normalizeAppliedAt("2026-01-31T23:00:00-05:00");
  assert.equal(forwards.outcome, "normalized", "an offset crossing into the next month is still a real date");
  assert.equal(forwards.outcome === "normalized" ? forwards.value : "", "2026-02-01T04:00:00.000Z");

  // The extremes of the offset range the pattern admits, and the colonless form.
  for (const value of ["2026-12-31T23:59:59+14:00", "2026-01-01T00:00:00-12:00", "2026-06-15T10:00:00+0530"]) {
    assert.equal(normalizeAppliedAt(value).outcome, "normalized", `${value} should be accepted`);
  }

  // And the row-level effect, which is what the operator actually saw.
  const complete = {
    candidateFullName: "Casey Jones",
    candidateEmail: "casey@example.test",
    externalReferenceId: undefined,
    appliedAt: "2026-01-31T23:00:00-05:00"
  } as const;
  assert.equal(
    classifyCsvImportRow(complete).outcome,
    "processed",
    "a candidate with a local-offset timestamp must not be dropped from the import"
  );
});

/**
 * The control for the fix above, and the reason the obvious fix is wrong.
 *
 * Scoping the year and month checks to the date-only branch, the way the day
 * check already was, would accept these: `new Date("2026-02-30T00:00:00Z")`
 * does not return NaN, it returns 2026-03-02. So that version of the fix trades
 * a false rejection for a silent corruption, storing a date the operator never
 * wrote. Both properties have to hold at once.
 */
test("an impossible calendar date is still refused, with or without a time and zone", () => {
  for (const value of [
    "2026-02-30",
    "2026-02-30T00:00:00Z",
    "2026-02-30T12:00:00+05:30",
    "2026-02-29",
    "2026-04-31T10:00:00-07:00",
    "2026-13-01T00:00:00Z",
    "2026-00-10",
    "2026-01-00"
  ]) {
    assert.equal(
      normalizeAppliedAt(value).outcome,
      "invalid",
      `${value} is not a real date and must not be rolled forward into one`
    );
  }

  // 2024 is a leap year and 2026 is not, so the day check is a real calendar
  // check rather than a fixed month-length table.
  assert.equal(normalizeAppliedAt("2024-02-29").outcome, "normalized");
  assert.equal(normalizeAppliedAt("2026-02-28").outcome, "normalized");
});
