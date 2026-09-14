import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCsvPreview,
  mapCsvRowToApplication,
  validateCsvColumnMapping
} from "../../packages/domain/src/index.ts";
import type { CsvColumnMapping } from "../../packages/domain/src/index.ts";

const HEADERS = ["Full Name", "Email", "Applied On"];

test("a mapping covering both required fields with real headers is valid", () => {
  const mapping: CsvColumnMapping[] = [
    { field: "candidateFullName", csvColumnHeader: "Full Name" },
    { field: "candidateEmail", csvColumnHeader: "Email" }
  ];
  assert.deepEqual(validateCsvColumnMapping(HEADERS, mapping), { outcome: "valid" });
});

test("missing a required field is invalid", () => {
  const mapping: CsvColumnMapping[] = [{ field: "candidateFullName", csvColumnHeader: "Full Name" }];
  const outcome = validateCsvColumnMapping(HEADERS, mapping);
  assert.equal(outcome.outcome, "invalid");
  assert.ok(
    outcome.outcome === "invalid" &&
      outcome.reasons.some((reason) => reason.includes('Required field "candidateEmail"'))
  );
});

test("mapping a field from a column that does not exist is invalid", () => {
  const mapping: CsvColumnMapping[] = [
    { field: "candidateFullName", csvColumnHeader: "Not A Real Column" },
    { field: "candidateEmail", csvColumnHeader: "Email" }
  ];
  const outcome = validateCsvColumnMapping(HEADERS, mapping);
  assert.equal(outcome.outcome, "invalid");
  assert.ok(outcome.outcome === "invalid" && outcome.reasons.some((reason) => reason.includes("does not exist")));
});

test("mapping the same field twice is invalid", () => {
  const mapping: CsvColumnMapping[] = [
    { field: "candidateFullName", csvColumnHeader: "Full Name" },
    { field: "candidateFullName", csvColumnHeader: "Email" },
    { field: "candidateEmail", csvColumnHeader: "Email" }
  ];
  const outcome = validateCsvColumnMapping(HEADERS, mapping);
  assert.equal(outcome.outcome, "invalid");
  assert.ok(
    outcome.outcome === "invalid" && outcome.reasons.some((reason) => reason.includes("mapped from more than one"))
  );
});

test("mapping the same column to two fields is invalid", () => {
  const mapping: CsvColumnMapping[] = [
    { field: "candidateFullName", csvColumnHeader: "Email" },
    { field: "candidateEmail", csvColumnHeader: "Email" }
  ];
  const outcome = validateCsvColumnMapping(HEADERS, mapping);
  assert.equal(outcome.outcome, "invalid");
  assert.ok(
    outcome.outcome === "invalid" && outcome.reasons.some((reason) => reason.includes("mapped to more than one"))
  );
});

test("a duplicate header row makes any mapping invalid", () => {
  const duplicateHeaders = ["Email", "Email"];
  const mapping: CsvColumnMapping[] = [
    { field: "candidateFullName", csvColumnHeader: "Email" },
    { field: "candidateEmail", csvColumnHeader: "Email" }
  ];
  const outcome = validateCsvColumnMapping(duplicateHeaders, mapping);
  assert.equal(outcome.outcome, "invalid");
});

test("mapCsvRowToApplication reads mapped columns and leaves unmapped fields undefined", () => {
  const mapping: CsvColumnMapping[] = [
    { field: "candidateFullName", csvColumnHeader: "Full Name" },
    { field: "candidateEmail", csvColumnHeader: "Email" }
  ];
  const row = { "Full Name": "Ada Lovelace", Email: "ada@example.com", "Applied On": "2026-01-01" };
  assert.deepEqual(mapCsvRowToApplication(row, mapping), {
    candidateFullName: "Ada Lovelace",
    candidateEmail: "ada@example.com",
    externalReferenceId: undefined,
    appliedAt: undefined
  });
});

test("mapCsvRowToApplication trims whitespace and treats blank cells as undefined", () => {
  const mapping: CsvColumnMapping[] = [{ field: "candidateFullName", csvColumnHeader: "Full Name" }];
  assert.equal(mapCsvRowToApplication({ "Full Name": "  Ada  " }, mapping).candidateFullName, "Ada");
  assert.equal(mapCsvRowToApplication({ "Full Name": "   " }, mapping).candidateFullName, undefined);
  assert.equal(mapCsvRowToApplication({}, mapping).candidateFullName, undefined);
});

test("buildCsvPreview caps at ten rows but reports the true total", () => {
  const mapping: CsvColumnMapping[] = [
    { field: "candidateFullName", csvColumnHeader: "Full Name" },
    { field: "candidateEmail", csvColumnHeader: "Email" }
  ];
  const rows = Array.from({ length: 25 }, (_, index) => ({
    "Full Name": `Person ${index}`,
    Email: `person${index}@example.com`
  }));
  const preview = buildCsvPreview(rows, mapping);
  assert.equal(preview.totalDataRows, 25);
  assert.equal(preview.previewRows.length, 10);
  assert.equal(preview.previewRows[0]?.rowNumber, 1);
  assert.equal(preview.previewRows[0]?.values.candidateFullName, "Person 0");
  assert.equal(preview.previewRows[9]?.rowNumber, 10);
  assert.equal(preview.previewRows[9]?.values.candidateFullName, "Person 9");
});

test("buildCsvPreview on fewer than ten rows returns them all", () => {
  const mapping: CsvColumnMapping[] = [{ field: "candidateFullName", csvColumnHeader: "Full Name" }];
  const rows = [{ "Full Name": "Only Row" }];
  const preview = buildCsvPreview(rows, mapping);
  assert.equal(preview.totalDataRows, 1);
  assert.equal(preview.previewRows.length, 1);
});
