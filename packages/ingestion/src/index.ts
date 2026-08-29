import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
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
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 5_000,
      requestTimeout: 5_000
    })
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
