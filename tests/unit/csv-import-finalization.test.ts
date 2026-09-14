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
