import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalizeCsvColumnMapping,
  classifyCsvImportRow,
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
