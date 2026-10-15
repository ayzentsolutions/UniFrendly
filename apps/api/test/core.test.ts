import { afterAll, describe, expect, it } from 'vitest';
import { newOpaqueToken, hashToken } from '../src/utils/crypto.js';
import { pageSchema } from '../src/utils/pagination.js';
import { sniffMime } from '../src/services/storage.js';
import { buildApp } from '../src/app.js';
import { readConfigNumber } from '../src/utils/institutionConfig.js';

describe('security and pagination primitives', () => {
  it('creates high-entropy opaque tokens and stores only deterministic digests', () => {
    const token = newOpaqueToken();
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(token).not.toBe(hashToken(token));
    expect(hashToken(token)).toHaveLength(64);
    expect(hashToken(token)).toBe(hashToken(token));
  });
  it('bounds page size and rejects unreasonable values', () => {
    expect(pageSchema.parse({}).limit).toBeLessThanOrEqual(50);
    expect(pageSchema.parse({ limit: '25' }).limit).toBe(25);
    expect(pageSchema.safeParse({ limit: '5000' }).success).toBe(false);
  });
  it('sniffs actual PDF/image signatures instead of trusting file names', () => {
    expect(sniffMime(Buffer.from('%PDF-1.7\n'))).toBe('application/pdf');
    expect(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]))).toBe('image/jpeg');
    expect(sniffMime(Buffer.from('not a png'))).toBeNull();
  });
  it('validates institution limits with safe defaults and bounds', () => {
    expect(readConfigNumber({ imageMaxBytes: 512_000 }, 'imageMaxBytes', 1_048_576, 1, 10_485_760)).toBe(512_000);
    expect(readConfigNumber({ imagesPerPost: 99 }, 'imagesPerPost', 4, 1, 4)).toBe(4);
    expect(readConfigNumber({ storyTtlHours: 'untrusted' }, 'storyTtlHours', 24, 1, 168)).toBe(24);
    expect(readConfigNumber(undefined, 'studentQuotaBytes', 52_428_800, 0, 1_073_741_824)).toBe(52_428_800);
  });
});

describe('HTTP health endpoint', () => {
  const appPromise = buildApp();
  afterAll(async () => (await appPromise).close());
  it('returns a live status without requiring a database query', async () => {
    const app = await appPromise;
    const response = await app.inject({ method: 'GET', url: '/health/live' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', service: 'unifrendly-api' });
  });
  it('returns a structured not-found response for unknown routes', async () => {
    const app = await appPromise;
    const response = await app.inject({ method: 'GET', url: '/not-a-route' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });
});
