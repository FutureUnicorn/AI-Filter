import assert from "node:assert/strict";
import test from "node:test";

import {
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
