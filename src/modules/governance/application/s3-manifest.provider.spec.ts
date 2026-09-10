import { createHash } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import type { DeletionManifest } from '../domain/deletion-manifest';
import {
  canonicalManifestJson,
  S3ManifestProvider,
} from './s3-manifest.provider';
import { ManifestProviderConflictError } from './manifest-provider.errors';

const manifest: DeletionManifest = {
  contractVersion: 'deletion-manifest.v1',
  deletionEventId: '11111111-1111-4111-8111-111111111111',
  archivedResultId: '22222222-2222-4222-8222-222222222222',
  liveSessionId: '33333333-3333-4333-8333-333333333333',
  trigger: 'retention',
  reason: 'retention',
  deletedAt: '2026-09-09T00:00:00.000Z',
  categories: ['submission', 'sessionQuestion'],
};

const body = Buffer.from(canonicalManifestJson(manifest), 'utf8');
const sha256Hex = createHash('sha256').update(body).digest('hex');
const sha256Base64 = createHash('sha256').update(body).digest('base64');

function configWith(overrides: Record<string, unknown> = {}): ConfigService {
  return {
    get: jest.fn((key: string) => {
      const values: Record<string, unknown> = {
        S3_ENDPOINT: 'http://localhost:9000',
        S3_REGION: 'us-east-1',
        S3_BUCKET: 'manifests',
        S3_PREFIX: 'deletion-manifests',
        S3_OBJECT_LOCK_DAYS: 90,
        S3_SERVER_SIDE_ENCRYPTION: 'AES256',
        S3_ACCESS_KEY_ID: 'access',
        S3_SECRET_ACCESS_KEY: 'secret',
        ...overrides,
      };
      return values[key];
    }),
    getOrThrow: jest.fn((key: string) => {
      const values: Record<string, unknown> = {
        S3_ENDPOINT: 'http://localhost:9000',
        S3_REGION: 'us-east-1',
        S3_BUCKET: 'manifests',
        S3_ACCESS_KEY_ID: 'access',
        S3_SECRET_ACCESS_KEY: 'secret',
        ...overrides,
      };
      return values[key];
    }),
  } as unknown as ConfigService;
}

function mockClient() {
  return { send: jest.fn() } as unknown as S3Client & { send: jest.Mock };
}

function preconditionFailure() {
  return { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } };
}

function accessDenied() {
  return { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } };
}

describe('S3ManifestProvider', () => {
  it('sends a first PUT with equality metadata, checksum, and object lock', async () => {
    const client = mockClient();
    client.send.mockResolvedValueOnce({});
    const provider = new S3ManifestProvider(configWith(), client);

    await provider.put(manifest);

    const command = client.send.mock.calls[0][0];
    expect(command.constructor.name).toBe('PutObjectCommand');
    expect(command.input.Bucket).toBe('manifests');
    expect(command.input.Key).toBe(
      `deletion-manifests/${manifest.deletionEventId}.json`,
    );
    expect(command.input.IfNoneMatch).toBe('*');
    expect(command.input.ChecksumSHA256).toBe(sha256Base64);
    expect(command.input.ObjectLockMode).toBe('COMPLIANCE');
    expect(command.input.Metadata).toEqual({
      'manifest-sha256': sha256Hex,
      'deletion-event-id': manifest.deletionEventId,
      'contract-version': manifest.contractVersion,
    });
  });

  it('resolves a replay when HeadObject equality metadata matches', async () => {
    const client = mockClient();
    client.send
      .mockRejectedValueOnce(preconditionFailure())
      .mockResolvedValueOnce({
        ContentLength: body.length,
        Metadata: {
          'manifest-sha256': sha256Hex,
          'deletion-event-id': manifest.deletionEventId,
          'contract-version': manifest.contractVersion,
        },
      });
    const provider = new S3ManifestProvider(configWith(), client);

    await expect(provider.put(manifest)).resolves.toBeUndefined();
    expect(client.send.mock.calls[1][0].constructor.name).toBe(
      'HeadObjectCommand',
    );
  });

  it('fails closed when the HeadObject read is denied', async () => {
    const client = mockClient();
    client.send
      .mockRejectedValueOnce(preconditionFailure())
      .mockRejectedValueOnce(accessDenied());
    const provider = new S3ManifestProvider(configWith(), client);

    await expect(provider.put(manifest)).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('fails closed when equality metadata is missing', async () => {
    const client = mockClient();
    client.send
      .mockRejectedValueOnce(preconditionFailure())
      .mockResolvedValueOnce({ ContentLength: body.length, Metadata: {} });
    const provider = new S3ManifestProvider(configWith(), client);

    await expect(provider.put(manifest)).rejects.toBeInstanceOf(
      ManifestProviderConflictError,
    );
  });

  it('rejects a checksum/metadata mismatch as a conflict', async () => {
    const client = mockClient();
    client.send
      .mockRejectedValueOnce(preconditionFailure())
      .mockResolvedValueOnce({
        ContentLength: body.length,
        Metadata: {
          'manifest-sha256': 'deadbeef',
          'deletion-event-id': manifest.deletionEventId,
          'contract-version': manifest.contractVersion,
        },
      });
    const provider = new S3ManifestProvider(configWith(), client);

    await expect(provider.put(manifest)).rejects.toBeInstanceOf(
      ManifestProviderConflictError,
    );
  });

  it('rejects a content-length mismatch as a conflict', async () => {
    const client = mockClient();
    client.send
      .mockRejectedValueOnce(preconditionFailure())
      .mockResolvedValueOnce({
        ContentLength: body.length + 1,
        Metadata: {
          'manifest-sha256': sha256Hex,
          'deletion-event-id': manifest.deletionEventId,
          'contract-version': manifest.contractVersion,
        },
      });
    const provider = new S3ManifestProvider(configWith(), client);

    await expect(provider.put(manifest)).rejects.toBeInstanceOf(
      ManifestProviderConflictError,
    );
  });

  it('maps a non-412 PUT error to unavailable', async () => {
    const client = mockClient();
    client.send.mockRejectedValueOnce(new Error('network failure'));
    const provider = new S3ManifestProvider(configWith(), client);

    await expect(provider.put(manifest)).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('includes SSEKMSKeyId when aws:kms is configured', async () => {
    const client = mockClient();
    client.send.mockResolvedValueOnce({});
    const provider = new S3ManifestProvider(
      configWith({
        S3_SERVER_SIDE_ENCRYPTION: 'aws:kms',
        S3_KMS_KEY_ID: 'arn:aws:kms:us-east-1:123456789012:key/abc',
      }),
      client,
    );

    await provider.put(manifest);

    const command = client.send.mock.calls[0][0];
    expect(command.input.ServerSideEncryption).toBe('aws:kms');
    expect(command.input.SSEKMSKeyId).toBe(
      'arn:aws:kms:us-east-1:123456789012:key/abc',
    );
  });
});
