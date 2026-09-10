import { createHash } from 'node:crypto';
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DeletionManifest } from '../domain/deletion-manifest';
import {
  ManifestProviderConflictError,
  ManifestProviderError,
} from './manifest-provider.errors';
import type { DeletionManifestProvider } from './deletion-manifest.exporter';

export function canonicalManifestJson(manifest: DeletionManifest): string {
  return (
    JSON.stringify({
      archivedResultId: manifest.archivedResultId,
      categories: [...manifest.categories].sort(),
      contractVersion: manifest.contractVersion,
      deletedAt: manifest.deletedAt,
      deletionEventId: manifest.deletionEventId,
      liveSessionId: manifest.liveSessionId,
      reason: manifest.reason,
      trigger: manifest.trigger,
    }) + '\n'
  );
}

@Injectable()
export class S3ManifestProvider implements DeletionManifestProvider {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly lockDays: number;
  private readonly sse?: 'AES256' | 'aws:kms';
  private readonly kmsKeyId?: string;

  constructor(config: ConfigService, client?: S3Client) {
    const endpoint = config.getOrThrow<string>('S3_ENDPOINT');
    const region = config.getOrThrow<string>('S3_REGION');
    this.bucket = config.getOrThrow<string>('S3_BUCKET');
    this.prefix = (
      config.get<string>('S3_PREFIX') ?? 'deletion-manifests'
    ).replace(/^\/+|\/+$/g, '');
    this.lockDays = config.get<number>('S3_OBJECT_LOCK_DAYS') ?? 90;
    // SSE-S3 is the default, but some S3-compatible stores (e.g. MinIO
    // without KMS) reject it — allow opting out per environment.
    const sse = config.get<string>('S3_SERVER_SIDE_ENCRYPTION');
    this.sse =
      sse === 'none' ? undefined : sse === 'aws:kms' ? 'aws:kms' : 'AES256';
    this.kmsKeyId =
      this.sse === 'aws:kms' ? config.get<string>('S3_KMS_KEY_ID') : undefined;
    if (client) {
      this.client = client;
      return;
    }
    const clientConfig: S3ClientConfig = {
      endpoint,
      region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.getOrThrow<string>('S3_ACCESS_KEY_ID'),
        secretAccessKey: config.getOrThrow<string>('S3_SECRET_ACCESS_KEY'),
      },
    };
    this.client = new S3Client(clientConfig);
  }

  async put(manifest: DeletionManifest): Promise<void> {
    const body = Buffer.from(canonicalManifestJson(manifest), 'utf8');
    const checksum = createHash('sha256').update(body).digest('base64');
    const sha256Hex = createHash('sha256').update(body).digest('hex');
    const key = `${this.prefix}/${manifest.deletionEventId}.json`;
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: 'application/json',
          ChecksumSHA256: checksum,
          IfNoneMatch: '*',
          ServerSideEncryption: this.sse,
          ...(this.sse === 'aws:kms' && this.kmsKeyId
            ? { SSEKMSKeyId: this.kmsKeyId }
            : {}),
          Metadata: {
            'manifest-sha256': sha256Hex,
            'deletion-event-id': manifest.deletionEventId,
            'contract-version': manifest.contractVersion,
          },
          ObjectLockMode: 'COMPLIANCE',
          ObjectLockRetainUntilDate: new Date(
            Date.now() + this.lockDays * 86_400_000,
          ),
        }),
      );
    } catch (error) {
      if (!isPreconditionFailure(error))
        throw new ManifestProviderError(
          'S3 manifest write failed',
          'unavailable',
          { cause: error },
        );
      // A 412 proves only that a key exists, not that it holds the same
      // payload. Replay succeeds only when the existing object's equality
      // metadata matches the canonical body exactly; any unverifiable state
      // fails closed.
      try {
        const existing = await this.client.send(
          new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
        );
        const metadata = existing.Metadata ?? {};
        const lengthMatches = existing.ContentLength === body.length;
        const shaMatches =
          metadata['manifest-sha256'] === sha256Hex &&
          metadata['deletion-event-id'] === manifest.deletionEventId &&
          metadata['contract-version'] === manifest.contractVersion;
        if (!lengthMatches || !shaMatches) {
          throw new ManifestProviderConflictError();
        }
      } catch (readError) {
        if (readError instanceof ManifestProviderConflictError) throw readError;
        throw new ManifestProviderError(
          'S3 manifest verification failed',
          'unavailable',
          { cause: readError },
        );
      }
    }
  }
}

function isPreconditionFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    ('$metadata' in error || 'name' in error) &&
    ((error as { $metadata?: { httpStatusCode?: number } }).$metadata
      ?.httpStatusCode === 412 ||
      (error as { name?: string }).name === 'PreconditionFailed')
  );
}
