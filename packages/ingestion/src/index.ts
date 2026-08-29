import { createHash } from "node:crypto";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ALLOWED_SNIFFED_MIME_TYPES } from "@signal-audit/domain";
import { fileTypeFromBuffer } from "file-type";
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

/** Fetches the uploaded object once and derives every fact AF-29's pure
 * evaluateFileValidation (packages/domain) needs to decide on it.
 * file-type reports docx with its specific OOXML mime, not a generic
 * "application/zip" -- it still shares a ZIP container underneath, which
 * is exactly what makes it the one allowed type worth bomb-checking. */
export async function sniffUploadedFile(options: StorageConnectionOptions, key: string): Promise<SniffedFile> {
  const bytes = await fetchObjectBytes(options, key);
  const detected = await fileTypeFromBuffer(bytes);
  const zipSummary =
    detected?.mime === ALLOWED_SNIFFED_MIME_TYPES.docx ? inspectZipCentralDirectory(bytes) : undefined;
  return {
    sizeBytes: bytes.length,
    sniffedMimeType: detected?.mime,
    sha256Hash: createHash("sha256").update(bytes).digest("hex"),
    ...(zipSummary === undefined ? {} : { zipUncompressedBytes: zipSummary.totalUncompressedBytes })
  };
}
