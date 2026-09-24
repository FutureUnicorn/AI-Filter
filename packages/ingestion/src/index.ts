import { createHash } from "node:crypto";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ALLOWED_SNIFFED_MIME_TYPES, evaluateCanonicalTextQuality } from "@signal-audit/domain";
import type { CanonicalTextPage } from "@signal-audit/domain";
import { parse as parseCsv } from "csv-parse/sync";
import { fileTypeFromBuffer } from "file-type";
import { extractRawText } from "mammoth";
import { PDFParse } from "pdf-parse";
import type { BoundaryContract } from "@signal-audit/contracts";
import type { DomainPort } from "@signal-audit/domain";

/** File and parser adapters will terminate at this boundary. */
export interface IngestionAdapterBoundary {
  readonly contract: BoundaryContract;
  readonly domain: DomainPort;
}

export interface StorageConnectionOptions {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
}

function storageClient(options: StorageConnectionOptions): S3Client {
  return new S3Client({
    endpoint: options.endpoint,
    region: options.region,
    forcePathStyle: options.forcePathStyle,
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey
    },
    requestHandler: {
      requestTimeout: 5_000,
      connectionTimeout: 5_000
    }
  });
}

export async function checkStorageConnection(
  options: StorageConnectionOptions
): Promise<{ readonly bucket: string }> {
  const client = storageClient(options);
  try {
    await client.send(new HeadBucketCommand({ Bucket: options.bucket }));
    return { bucket: options.bucket };
  } finally {
    client.destroy();
  }
}

export async function verifySyntheticStorageRoundTrip(
  options: StorageConnectionOptions,
  keyPrefix: string
): Promise<void> {
  if (!/^(development|test|preview|staging)\//u.test(keyPrefix)) {
    throw new Error("Synthetic storage probes require a non-production namespace");
  }

  const key = `${keyPrefix}/af-11-storage-probe.txt`;
  const expected = "AF-11 synthetic fixture; never applicant data.\n";
  const client = storageClient(options);
  try {
    await client.send(
      new PutObjectCommand({ Bucket: options.bucket, Key: key, Body: expected })
    );
    const response = await client.send(
      new GetObjectCommand({ Bucket: options.bucket, Key: key })
    );
    const actual = await response.Body?.transformToString();
    if (actual !== expected) {
      throw new Error("Synthetic storage round-trip returned unexpected content");
    }
  } finally {
    await client
      .send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key }))
      .catch(() => undefined);
    client.destroy();
  }
}

// ---- AF-28: secure direct file upload ----
//
// The browser PUTs straight to this URL; the file never passes through
// the web process (Next.js route handlers never see the file bytes, only
// the metadata needed to mint the URL). "One-use" is enforced at the
// application layer, not the storage protocol: a presigned URL is valid
// for anyone holding it until it expires, so the short TTL plus
// packages/db's file_intakes row (started 'pending', transitioned to
// 'uploaded' exactly once by a WHERE status = 'pending' update) are what
// make a completed upload non-replayable, not the URL itself.

const UPLOAD_URL_TTL_SECONDS = 15 * 60;

export async function createPresignedUploadUrl(
  options: StorageConnectionOptions,
  key: string,
  contentType: string,
  expiresInSeconds: number = UPLOAD_URL_TTL_SECONDS
): Promise<string> {
  const client = storageClient(options);
  try {
    return await getSignedUrl(
      client,
      new PutObjectCommand({ Bucket: options.bucket, Key: key, ContentType: contentType }),
      { expiresIn: expiresInSeconds }
    );
  } finally {
    client.destroy();
  }
}

// ---- AF-29: file allowlist, MIME validation, hash and quarantine ----

export async function fetchObjectBytes(options: StorageConnectionOptions, key: string): Promise<Buffer> {
  const client = storageClient(options);
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: options.bucket, Key: key }));
    const bytes = await response.Body?.transformToByteArray();
    if (bytes === undefined) {
      throw new Error(`Object body was empty for key ${key}`);
    }
    return Buffer.from(bytes);
  } finally {
    client.destroy();
  }
}

// ---- AF-62: candidate-data deletion workflow ----

/**
 * Deletes a stored document. The one retention surface that a plain
 * delete actually reaches.
 *
 * S3 DeleteObject is idempotent and answers 204 for a key that was never
 * there, so a success here means "the object is not in the bucket", not
 * "the object was in the bucket and now is not". That is the right
 * guarantee for an erasure -- re-running a partially completed erasure
 * must not fail on the objects it already removed -- but it does mean this
 * cannot be used to prove the document ever existed. The file_intakes row
 * is what evidences that, which is a further reason its redaction has to
 * happen after this call rather than before.
 */
export async function deleteStoredObject(
  options: StorageConnectionOptions,
  key: string
): Promise<void> {
  if (key.trim().length === 0) {
    throw new Error("deleteStoredObject requires a non-empty key");
  }
  const client = storageClient(options);
  try {
    await client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key }));
  } finally {
    client.destroy();
  }
}

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_EOCD_MIN_SIZE = 22;
const ZIP_MAX_COMMENT_SIZE = 65_535;

export interface ZipCentralDirectorySummary {
  readonly entryCount: number;
  readonly totalUncompressedBytes: number;
}

/**
 * Reads only the ZIP central directory (small, fixed+variable-length
 * metadata records) to sum every entry's declared uncompressed size --
 * never decompresses any entry's actual data. This is what lets a
 * zip-bomb's absurd declared size be caught before any bytes are
 * inflated, which is the whole point: decompressing first to check the
 * result would already be the attack succeeding.
 *
 * Returns undefined for anything that isn't a well-formed single-disk
 * ZIP (including a ZIP64 one, identified by the 0xFFFFFFFF sentinel in
 * the EOCD): AF-29's caller treats "couldn't read the central directory
 * of something that sniffed as a ZIP-based format" as quarantine-worthy
 * on its own, via evaluateFileValidation's undefined-sniffed-type path,
 * not as license to skip the bomb check.
 */
export function inspectZipCentralDirectory(buffer: Buffer): ZipCentralDirectorySummary | undefined {
  const searchStart = Math.max(0, buffer.length - ZIP_EOCD_MIN_SIZE - ZIP_MAX_COMMENT_SIZE);
  let eocdOffset = -1;
  for (let offset = buffer.length - ZIP_EOCD_MIN_SIZE; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset === -1) {
    return undefined;
  }

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (totalEntries === 0xffff || centralDirectoryOffset === 0xffffffff) {
    return undefined; // ZIP64 sentinel; not handled here.
  }

  let cursor = centralDirectoryOffset;
  let totalUncompressedBytes = 0;
  for (let entry = 0; entry < totalEntries; entry += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
      return undefined;
    }
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const filenameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    totalUncompressedBytes += uncompressedSize;
    cursor += 46 + filenameLength + extraLength + commentLength;
  }
  return { entryCount: totalEntries, totalUncompressedBytes };
}

export interface SniffedFile {
  readonly sizeBytes: number;
  readonly sniffedMimeType: string | undefined;
  readonly sha256Hash: string;
  readonly zipUncompressedBytes?: number | undefined;
}

/**
 * file-type only ever detects binary formats by magic bytes; its own
 * readme says as much and lists .csv by name as one it will never
 * identify (github.com/sindresorhus/file-type, "not able to detect...
 * .csv"). A real CSV upload therefore always sniffs as undefined from
 * fileTypeFromBuffer alone -- discovered here, live, while verifying
 * AF-31 against a genuine file, not assumed. This is deliberately
 * narrow: a null byte or invalid UTF-8 anywhere fails it outright (real
 * binary data, not text), and what's left still has to actually parse
 * as at least one non-empty CSV row, so a renamed but content-free or
 * garbage file still won't pass.
 */
export function looksLikeCsvText(buffer: Buffer): boolean {
  if (buffer.includes(0)) {
    return false;
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return false;
  }
  try {
    const records = parseCsv(decoded, {
      bom: true,
      trim: true,
      skip_empty_lines: true,
      relax_column_count: true
    }) as string[][];
    return records.length > 0 && (records[0]?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Fetches the uploaded object once and derives every fact AF-29's pure
 * evaluateFileValidation (packages/domain) needs to decide on it.
 * file-type reports docx with its specific OOXML mime, not a generic
 * "application/zip" -- it still shares a ZIP container underneath, which
 * is exactly what makes it the one allowed type worth bomb-checking. */
export async function sniffUploadedFile(options: StorageConnectionOptions, key: string): Promise<SniffedFile> {
  const bytes = await fetchObjectBytes(options, key);
  const detected = await fileTypeFromBuffer(bytes);
  const sniffedMimeType = detected?.mime ?? (looksLikeCsvText(bytes) ? ALLOWED_SNIFFED_MIME_TYPES.csv : undefined);
  const zipSummary =
    detected?.mime === ALLOWED_SNIFFED_MIME_TYPES.docx ? inspectZipCentralDirectory(bytes) : undefined;
  return {
    sizeBytes: bytes.length,
    sniffedMimeType,
    sha256Hash: createHash("sha256").update(bytes).digest("hex"),
    ...(zipSummary === undefined ? {} : { zipUncompressedBytes: zipSummary.totalUncompressedBytes })
  };
}

// ---- AF-30: PDF/DOCX canonical text parser ----

export interface CanonicalTextResult {
  readonly pages: readonly CanonicalTextPage[];
  readonly quality: ReturnType<typeof evaluateCanonicalTextQuality>;
}

function toResult(pages: readonly CanonicalTextPage[]): CanonicalTextResult {
  return { pages, quality: evaluateCanonicalTextQuality(pages) };
}

/** Genuinely per-page: pdf-parse's own page numbering, not an assumption. */
export async function extractCanonicalTextFromPdf(buffer: Buffer): Promise<CanonicalTextResult> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return toResult(
      result.pages.map((page) => ({ pageNumber: page.num, text: page.text, characterCount: page.text.length }))
    );
  } finally {
    await parser.destroy();
  }
}

/**
 * mammoth reads the document's actual paragraph/run content, not a
 * rendered layout -- DOCX stores no reliable page-break positions
 * without a full layout engine (Word computes page breaks at render
 * time from margins/fonts/print settings, none of which live in the
 * XML), so this is always exactly one page. Documented here rather than
 * quietly inventing a page count AF-30's own "page-aware" promise
 * doesn't actually hold for this format.
 */
export async function extractCanonicalTextFromDocx(buffer: Buffer): Promise<CanonicalTextResult> {
  const result = await extractRawText({ buffer });
  const text = result.value;
  return toResult([{ pageNumber: 1, text, characterCount: text.length }]);
}

// ---- AF-31: CSV mapping and ten-row preview ----

export interface ParsedCsv {
  readonly headers: readonly string[];
  readonly rows: readonly Readonly<Record<string, string>>[];
}

/**
 * Parses with columns:false (raw string[][]) and builds the
 * header-to-value records by hand, rather than csv-parse's own
 * columns:true mode -- that mode consumes the header row internally and
 * never hands it back, and packages/domain's validateCsvColumnMapping
 * needs the real header list to check a recruiter's mapping against.
 */
export function parseCsvFile(buffer: Buffer): ParsedCsv {
  const records = parseCsv(buffer, { bom: true, trim: true, skip_empty_lines: true }) as string[][];
  if (records.length === 0) {
    return { headers: [], rows: [] };
  }
  const [headerRow, ...dataRows] = records as [string[], ...string[][]];
  const rows = dataRows.map((values) => {
    const row: Record<string, string> = {};
    headerRow.forEach((header, index) => {
      row[header] = values[index] ?? "";
    });
    return row;
  });
  return { headers: headerRow, rows };
}
