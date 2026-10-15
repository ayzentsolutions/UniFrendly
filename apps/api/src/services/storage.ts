import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env, uploadsConfigured } from '../config/env.js';

export const s3 = uploadsConfigured ? new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  credentials: { accessKeyId: env.S3_ACCESS_KEY_ID!, secretAccessKey: env.S3_SECRET_ACCESS_KEY! }
}) : null;
export async function presignUpload(key: string, mimeType: string, maxBytes: number) {
  if (!s3 || !env.S3_BUCKET) throw new Error('Private object storage is not configured');
  return createPresignedPost(s3, {
    Bucket: env.S3_BUCKET,
    Key: key,
    Expires: env.SIGNED_UPLOAD_TTL_SECONDS,
    Fields: { 'Content-Type': mimeType },
    Conditions: [['content-length-range', 1, maxBytes], ['eq', '$Content-Type', mimeType], ['eq', '$key', key]]
  });
}
export async function inspectObject(key: string) {
  if (!s3 || !env.S3_BUCKET) throw new Error('Private object storage is not configured');
  const head = await s3.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
  const range = await s3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Range: 'bytes=0-31' }));
  const bytes = range.Body ? await range.Body.transformToByteArray() : new Uint8Array();
  return { size: Number(head.ContentLength ?? 0), mimeType: head.ContentType ?? '', bytes };
}
export async function presignDownload(key: string, mimeType: string) {
  if (!s3 || !env.S3_BUCKET) throw new Error('Private object storage is not configured');
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key, ResponseContentType: mimeType, ResponseContentDisposition: 'attachment' }), { expiresIn: 60 });
}
export async function deleteObject(key: string) {
  if (!s3 || !env.S3_BUCKET) return;
  const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  await s3.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
}
export function sniffMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 5 && String.fromCharCode(...bytes.slice(0, 5)) === '%PDF-') return 'application/pdf';
  if (bytes.length >= 8 && [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a].every((v, i) => bytes[i] === v)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}
