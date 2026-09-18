import assert from "node:assert/strict";
import test from "node:test";

import {
  ALLOWED_SNIFFED_MIME_TYPES,
  MAX_DOCX_COMPRESSION_RATIO,
  MAX_DOCX_UNCOMPRESSED_BYTES,
  MAX_FILE_UPLOAD_BYTES,
  evaluateFileValidation
} from "../../packages/domain/src/index.ts";

test("a well-formed PDF within limits validates", () => {
  const result = evaluateFileValidation({
    declaredFilename: "resume.pdf",
    sniffedMimeType: "application/pdf",
    sizeBytes: 500_000
  });
  assert.deepEqual(result, { outcome: "validated" });
});

test("a well-formed DOCX with a sane compression ratio validates", () => {
  const result = evaluateFileValidation({
    declaredFilename: "resume.docx",
    sniffedMimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    sizeBytes: 100_000,
    zipUncompressedBytes: 400_000
  });
  assert.deepEqual(result, { outcome: "validated" });
});

test("a well-formed CSV validates", () => {
  const result = evaluateFileValidation({
    declaredFilename: "applicants.csv",
    sniffedMimeType: "text/csv",
    sizeBytes: 10_000
  });
  assert.deepEqual(result, { outcome: "validated" });
});

test("an oversized file is quarantined regardless of type", () => {
  const result = evaluateFileValidation({
    declaredFilename: "resume.pdf",
    sniffedMimeType: "application/pdf",
    sizeBytes: MAX_FILE_UPLOAD_BYTES + 1
  });
  assert.equal(result.outcome, "quarantined");
});

test("an unrecognized/malformed file (file-type found no signature) is quarantined", () => {
  const result = evaluateFileValidation({
    declaredFilename: "resume.pdf",
    sniffedMimeType: undefined,
    sizeBytes: 1_000
  });
  assert.equal(result.outcome, "quarantined");
});

test("a disguised file (real type not on the allowlist) is quarantined", () => {
  const result = evaluateFileValidation({
    declaredFilename: "resume.pdf",
    sniffedMimeType: "application/x-msdownload",
    sizeBytes: 1_000
  });
  assert.equal(result.outcome, "quarantined");
});

test("a filename claiming one type but sniffed as another is quarantined", () => {
  const result = evaluateFileValidation({
    declaredFilename: "resume.pdf",
    sniffedMimeType: "text/csv",
    sizeBytes: 1_000
  });
  assert.equal(result.outcome, "quarantined");
});

test("a zip declaring uncompressed size over the absolute cap is quarantined even at a modest ratio", () => {
  const result = evaluateFileValidation({
    declaredFilename: "resume.docx",
    sniffedMimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    sizeBytes: 5_000_000,
    zipUncompressedBytes: MAX_DOCX_UNCOMPRESSED_BYTES + 1
  });
  assert.equal(result.outcome, "quarantined");
});

test("a zip bomb shape (tiny compressed, enormous declared uncompressed) is quarantined on ratio", () => {
  const sizeBytes = 1_000;
  const zipUncompressedBytes = sizeBytes * (MAX_DOCX_COMPRESSION_RATIO + 1);
  const result = evaluateFileValidation({
    declaredFilename: "resume.docx",
    sniffedMimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    sizeBytes,
    zipUncompressedBytes
  });
  assert.equal(result.outcome, "quarantined");
});

// ---- PR #83 review, P1: an uninspectable archive must quarantine ----
//
// zipUncompressedBytes being absent used to mean two different things --
// "not an archive" and "an archive whose central directory could not be
// read" -- and evaluateFileValidation read both as the former. A ZIP64 or
// malformed archive sniffs as a perfectly valid DOCX, so the
// undefined-sniffed-type path was never taken, the bomb check was skipped,
// and the file validated. The check was being skipped on exactly the files
// most likely to need it.
test("a DOCX whose central directory cannot be read is quarantined, not validated", () => {
  const outcome = evaluateFileValidation({
    declaredFilename: "resume.docx",
    sniffedMimeType: ALLOWED_SNIFFED_MIME_TYPES.docx,
    sizeBytes: 2 * 1024 * 1024,
    archiveUninspectable: true
  });
  assert.equal(outcome.outcome, "quarantined");
  assert.match(
    outcome.outcome === "quarantined" ? outcome.reason : "",
    /central directory could not be read/u,
    "the reason must say why, so an operator can tell this from an ordinary rejection"
  );
});

test("the ordinary non-archive case is still unaffected by that check", () => {
  // A CSV and a PDF legitimately have no uncompressed size. Quarantining
  // those would be a false positive, so the distinction has to hold in both
  // directions, not just the unsafe one.
  for (const mimeType of [ALLOWED_SNIFFED_MIME_TYPES.csv, ALLOWED_SNIFFED_MIME_TYPES.pdf]) {
    const outcome = evaluateFileValidation({
      declaredFilename: mimeType === ALLOWED_SNIFFED_MIME_TYPES.csv ? "rows.csv" : "resume.pdf",
      sniffedMimeType: mimeType,
      sizeBytes: 1024
    });
    assert.equal(outcome.outcome, "validated", `${mimeType} must still validate`);
  }

  // And an archive that WAS inspectable and is within the cap still passes.
  assert.equal(
    evaluateFileValidation({
      declaredFilename: "resume.docx",
      sniffedMimeType: ALLOWED_SNIFFED_MIME_TYPES.docx,
      sizeBytes: 50_000,
      zipUncompressedBytes: 200_000
    }).outcome,
    "validated"
  );
});

test("an oversized object is quarantined by size before anything else", () => {
  const outcome = evaluateFileValidation({
    declaredFilename: "huge.pdf",
    sniffedMimeType: ALLOWED_SNIFFED_MIME_TYPES.pdf,
    sizeBytes: MAX_FILE_UPLOAD_BYTES + 1
  });
  assert.equal(outcome.outcome, "quarantined");
  assert.match(outcome.outcome === "quarantined" ? outcome.reason : "", /over the .*-byte limit/u);
});
