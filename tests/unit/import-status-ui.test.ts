import assert from "node:assert/strict";
import test from "node:test";

import { buildImportErrorsCsv, buildImportStatusSummary } from "../../packages/domain/src/index.ts";
import type { ImportRow } from "../../packages/domain/src/index.ts";

test("no rows finalized yet reports waiting for the whole file", () => {
  assert.deepEqual(buildImportStatusSummary(5, []), {
    status: "waiting",
    totalRows: 5,
    processedCount: 0,
    failedCount: 0,
    skippedCount: 0,
    waitingCount: 5
  });
});

test("a fully finalized file reports zero waiting and the real split", () => {
  const rows = [{ outcome: "processed" as const }, { outcome: "failed" as const }, { outcome: "skipped" as const }];
  assert.deepEqual(buildImportStatusSummary(3, rows), {
    status: "finalized",
    totalRows: 3,
    processedCount: 1,
    failedCount: 1,
    skippedCount: 1,
    waitingCount: 0
  });
});

function importRow(overrides: Partial<ImportRow>): ImportRow {
  return {
    importRowId: "11111111-1111-4111-8111-111111111111",
    intakeId: "22222222-2222-4222-8222-222222222222",
    rowNumber: 1,
    outcome: "failed",
    ...overrides
  };
}

test("buildImportErrorsCsv includes only failed rows", () => {
  const rows: ImportRow[] = [
    importRow({ rowNumber: 1, outcome: "processed", applicationId: "app-1" }),
    importRow({ rowNumber: 2, outcome: "failed", failureReason: "Missing required field(s): candidateEmail" }),
    importRow({ rowNumber: 3, outcome: "skipped" })
  ];
  const csv = buildImportErrorsCsv(rows);
  assert.equal(csv, "row_number,failure_reason\n2,Missing required field(s): candidateEmail\n");
});

test("buildImportErrorsCsv on no failed rows is just the header", () => {
  const rows: ImportRow[] = [importRow({ rowNumber: 1, outcome: "processed", applicationId: "app-1" })];
  assert.equal(buildImportErrorsCsv(rows), "row_number,failure_reason\n");
});

test("buildImportErrorsCsv quotes a failure reason containing a comma", () => {
  const rows: ImportRow[] = [importRow({ rowNumber: 1, outcome: "failed", failureReason: "Missing fields: a, b" })];
  assert.equal(buildImportErrorsCsv(rows), 'row_number,failure_reason\n1,"Missing fields: a, b"\n');
});
