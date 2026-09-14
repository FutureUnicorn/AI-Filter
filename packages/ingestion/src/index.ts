import { createHash } from "node:crypto";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ALLOWED_SNIFFED_MIME_TYPES, MAX_FILE_UPLOAD_BYTES, evaluateCanonicalTextQuality } from "@signal-audit/domain";
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

/**
 * Thrown when an object is larger than the caller is willing to read. Its own
 * type so a caller can turn it into a rejection rather than a 500: an
 * oversized upload is an expected outcome of an untrusted PUT, not a fault.
 */
export class ObjectTooLargeError extends Error {
  readonly key: string;
  readonly limitBytes: number;
  readonly observedBytes: number | undefined;

  constructor(key: string, limitBytes: number, observedBytes: number | undefined) {
    super(
      `Object ${key} exceeds the ${limitBytes}-byte read limit` +
        (observedBytes === undefined ? "" : ` (observed at least ${observedBytes} bytes)`)
    );
    this.name = "ObjectTooLargeError";
    this.key = key;
    this.limitBytes = limitBytes;
    this.observedBytes = observedBytes;
  }
}

/**
 * Reads an object, refusing to buffer more than `limitBytes`.
 *
 * Review #83, P1: this used `transformToByteArray()`, which allocates the
 * whole object before any validation sees `MAX_FILE_UPLOAD_BYTES`. The signed
 * PUT carries no content-length constraint, so an attacker holding a valid
 * upload URL could make every validator buffer an arbitrarily large object.
 * The size limit was being enforced after the damage it exists to prevent.
 *
 * Two gates, because either alone is insufficient:
 *
 *  1. `HeadObject` first. Trusted metadata from the store, so an oversized
 *     object is refused without transferring it at all. But `ContentLength`
 *     can be absent, so this cannot be the only check.
 *  2. Streaming accumulation with a hard stop. Counts what has actually
 *     arrived and aborts the moment the limit is passed, which bounds memory
 *     even when metadata was missing or wrong.
 */
export async function fetchObjectBytes(
  options: StorageConnectionOptions,
  key: string,
  limitBytes: number = MAX_FILE_UPLOAD_BYTES
): Promise<Buffer> {
  const client = storageClient(options);
  try {
    // Gate 1: refuse before transferring anything, when the store tells us.
    const head = await client.send(new HeadObjectCommand({ Bucket: options.bucket, Key: key }));
    if (head.ContentLength !== undefined && head.ContentLength > limitBytes) {
      throw new ObjectTooLargeError(key, limitBytes, head.ContentLength);
    }

    const response = await client.send(new GetObjectCommand({ Bucket: options.bucket, Key: key }));
    const body = response.Body;
    if (body === undefined) {
      throw new Error(`Object body was empty for key ${key}`);
    }

    // Gate 2: bound what is actually read, whatever the metadata claimed.
    return await readCappedStream(body as AsyncIterable<Uint8Array>, limitBytes, key);
  } finally {
    client.destroy();
  }
}

/**
 * Accumulates a stream, aborting the moment it passes `limitBytes`.
 *
 * Exported so the enforcement itself is directly testable. CI provides
 * Postgres but no object store, so an end-to-end oversized-upload test
 * against real storage cannot run there; this is the part that actually
 * bounds memory, and it is tested against synthetic streams instead. The
 * `HeadObject` pre-check above is a transfer-avoidance optimisation on top of
 * it, not the guarantee.
 *
 * Aborts on the chunk that crosses the limit rather than after the loop, so
 * peak memory stays within one chunk of the cap no matter how much the sender
 * intended to deliver.
 */
export async function readCappedStream(
  stream: AsyncIterable<Uint8Array>,
  limitBytes: number,
  key: string
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > limitBytes) {
      throw new ObjectTooLargeError(key, limitBytes, total);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
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
 * ZIP, including a ZIP64 one, identified by the 0xFFFFFFFF sentinel in
 * the EOCD.
 *
 * This comment used to claim that case was already quarantined "via
 * evaluateFileValidation's undefined-sniffed-type path". Review #83 showed
 * that was false: such a file sniffs as a perfectly valid DOCX, so the
 * sniffed type is defined and that path is never taken. The absent size was
 * then read downstream as "not an archive", and the bomb check was skipped
 * on exactly the files most likely to need it. `sniffUploadedFile` now sets
 * `archiveUninspectable` so the two cases are distinguishable, and
 * `evaluateFileValidation` quarantines this one explicitly.
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
  /** Set when the file is a ZIP-based format whose central directory could
   * not be read, so no expansion size is knowable. Distinct from simply
   * having no size, which is the ordinary non-archive case. */
  readonly archiveUninspectable?: boolean | undefined;
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
  // Whether this file IS a ZIP-based format, kept separate from whether its
  // directory could be read. Collapsing the two is what let a ZIP64 archive
  // skip the bomb check: it sniffs as a valid DOCX, produced no summary, and
  // the absent size was then read downstream as "not an archive".
  const isArchiveFormat = detected?.mime === ALLOWED_SNIFFED_MIME_TYPES.docx;
  const zipSummary = isArchiveFormat ? inspectZipCentralDirectory(bytes) : undefined;
  const archiveUninspectable = isArchiveFormat && zipSummary === undefined;
  return {
    sizeBytes: bytes.length,
    sniffedMimeType,
    sha256Hash: createHash("sha256").update(bytes).digest("hex"),
    ...(zipSummary === undefined ? {} : { zipUncompressedBytes: zipSummary.totalUncompressedBytes }),
    ...(archiveUninspectable ? { archiveUninspectable: true } : {})
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
