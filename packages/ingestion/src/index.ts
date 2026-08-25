import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
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
