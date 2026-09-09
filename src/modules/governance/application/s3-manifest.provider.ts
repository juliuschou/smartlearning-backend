import { createHash } from 'node:crypto';
import {
  GetObjectCommand,
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

  constructor(config: ConfigService) {
    const endpoint = config.getOrThrow<string>('S3_ENDPOINT');
    const region = config.getOrThrow<string>('S3_REGION');
    this.bucket = config.getOrThrow<string>('S3_BUCKET');
    this.prefix = (
      config.get<string>('S3_PREFIX') ?? 'deletion-manifests'
    ).replace(/^\/+|\/+$/g, '');
    this.lockDays = config.get<number>('S3_OBJECT_LOCK_DAYS') ?? 90;
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
          ServerSideEncryption: 'AES256',
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
      try {
        const existing = await this.client.send(
          new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        );
        const bytes = existing.Body
          ? await existing.Body.transformToByteArray()
          : undefined;
        if (
          !bytes ||
          createHash('sha256').update(bytes).digest('base64') !== checksum
        ) {
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
