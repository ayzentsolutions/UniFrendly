import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { tenantTransaction } from '../db/pool.js';
import { currentAuth, requireAuth } from '../plugins/auth.js';
import { uploadsConfigured, env } from '../config/env.js';
import { deleteObject, inspectObject, presignDownload, presignUpload, sniffMime } from '../services/storage.js';
import { badRequest, conflict, forbidden, notFound, unavailable } from '../utils/errors.js';
import { readConfigNumber } from '../utils/institutionConfig.js';

const uploadIntentSchema = z.object({ fileName: z.string().trim().min(1).max(180), mimeType: z.enum(['image/jpeg','image/png','image/webp','application/pdf']), sizeBytes: z.number().int().min(1).max(10_485_760), purpose: z.enum(['post_image','avatar','study_pdf','message_attachment']).default('post_image') });
const imageExt: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

export async function mediaRoutes(app: FastifyInstance) {
  app.post('/media/upload-intents', { preHandler: requireAuth, config: { rateLimit: { max: 15, timeWindow: '1 hour' } } }, async (request) => {
    const auth = currentAuth(request);
    if (!uploadsConfigured) throw unavailable('Private object storage is not configured for this deployment');
    const body = uploadIntentSchema.parse(request.body);
    const isPdf = body.mimeType === 'application/pdf';
    if (body.purpose === 'study_pdf' && !isPdf) throw badRequest('Study resources must be PDFs');
    if (body.purpose !== 'study_pdf' && isPdf && body.purpose !== 'message_attachment') throw badRequest('This upload purpose accepts images only');
    const configResult = await tenantTransaction(auth.iid, (client) => client.query('SELECT config FROM institutions WHERE id = $1 AND status = $2', [auth.iid, 'active']));
    if (!configResult.rows[0]) throw notFound('Campus not found');
    const config = configResult.rows[0].config as Record<string, unknown>;
    const maxImage = readConfigNumber(config, 'imageMaxBytes', 1_048_576, 1, 10_485_760);
    const maxPdf = readConfigNumber(config, 'pdfMaxBytes', 10_485_760, 1, 10_485_760);
    const uploadTtlHours = readConfigNumber(config, 'temporaryUploadTtlHours', 24, 1, 24);
    const maxAllowed = isPdf ? maxPdf : maxImage;
    if (body.sizeBytes > maxAllowed) throw badRequest(`File exceeds the configured ${isPdf ? 'PDF' : 'image'} size limit`);
    const objectKey = `institutions/${auth.iid}/memberships/${auth.mid}/${randomUUID()}.${imageExt[body.mimeType]}`;
    const uploadId = randomUUID();
    await tenantTransaction(auth.iid, async (client) => {
      const reserve = await client.query(
        `UPDATE media_usage SET reserved_bytes = reserved_bytes + $3, updated_at = now()
          WHERE membership_id = $1 AND institution_id = $2 AND used_bytes + reserved_bytes + $3 <= quota_bytes
          RETURNING quota_bytes, used_bytes, reserved_bytes`, [auth.mid, auth.iid, body.sizeBytes]
      );
      if (!reserve.rowCount) throw forbidden('You have reached the campus media storage quota');
      await client.query(
        `INSERT INTO media_uploads (id, institution_id, membership_id, object_key, original_name, declared_mime, expected_bytes, media_kind, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now() + ($9::int * interval '1 hour'))`,
        [uploadId, auth.iid, auth.mid, objectKey, body.fileName, body.mimeType, body.sizeBytes, body.purpose === 'study_pdf' ? 'pdf' : body.purpose === 'message_attachment' ? 'attachment' : body.purpose === 'avatar' ? 'avatar' : 'image', uploadTtlHours]
      );
    });
    try {
      const form = await presignUpload(objectKey, body.mimeType, body.sizeBytes);
      return { uploadId, method: 'POST', url: form.url, fields: form.fields, expiresInSeconds: env.SIGNED_UPLOAD_TTL_SECONDS, maxBytes: body.sizeBytes, finalizePath: `/v1/media/uploads/${uploadId}/finalize` };
    } catch (error) {
      await tenantTransaction(auth.iid, async (client) => {
        const row = await client.query("UPDATE media_uploads SET status = 'rejected' WHERE id = $1 AND membership_id = $2 AND status = 'pending' RETURNING expected_bytes", [uploadId, auth.mid]);
        if (row.rows[0]) await client.query('UPDATE media_usage SET reserved_bytes = GREATEST(0, reserved_bytes - $1), updated_at = now() WHERE membership_id = $2', [row.rows[0].expected_bytes, auth.mid]);
      });
      throw error;
    }
  });

  app.post('/media/uploads/:uploadId/finalize', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (request) => {
    const auth = currentAuth(request);
    const { uploadId } = z.object({ uploadId: z.string().uuid() }).parse(request.params);
    const rowResult = await tenantTransaction(auth.iid, (client) => client.query("SELECT * FROM media_uploads WHERE id = $1 AND institution_id = $2 AND membership_id = $3 AND status = 'pending' AND expires_at > now()", [uploadId, auth.iid, auth.mid]));
    const upload = rowResult.rows[0];
    if (!upload) throw notFound('Pending upload not found or expired');
    if (!uploadsConfigured) throw unavailable('Object storage is not configured');
    const object = await inspectObject(upload.object_key);
    const actualMime = sniffMime(object.bytes);
    if (!object.size || object.size > Number(upload.expected_bytes) || actualMime !== upload.declared_mime || object.mimeType !== upload.declared_mime) {
      await deleteObject(upload.object_key).catch(() => undefined);
      await tenantTransaction(auth.iid, async (client) => {
        const changed = await client.query("UPDATE media_uploads SET status = 'rejected' WHERE id = $1 AND membership_id = $2 AND status = 'pending' RETURNING expected_bytes", [uploadId, auth.mid]);
        if (changed.rows[0]) await client.query('UPDATE media_usage SET reserved_bytes = GREATEST(0, reserved_bytes - $1), updated_at = now() WHERE membership_id = $2', [changed.rows[0].expected_bytes, auth.mid]);
      });
      throw badRequest('Uploaded file failed content, type or size validation');
    }
    const asset = await tenantTransaction(auth.iid, async (client) => {
      const locked = await client.query("SELECT * FROM media_uploads WHERE id = $1 AND institution_id = $2 AND membership_id = $3 AND status = 'pending' FOR UPDATE", [uploadId, auth.iid, auth.mid]);
      if (!locked.rowCount) throw conflictUpload();
      const mediaKind = upload.media_kind;
      const created = await client.query(
        `INSERT INTO media_assets (institution_id, membership_id, upload_id, object_key, mime_type, byte_size, media_kind)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, mime_type, byte_size, media_kind, created_at`, [auth.iid, auth.mid, uploadId, upload.object_key, actualMime, object.size, mediaKind]
      );
      await client.query("UPDATE media_uploads SET status = 'confirmed' WHERE id = $1", [uploadId]);
      await client.query('UPDATE media_usage SET reserved_bytes = GREATEST(0, reserved_bytes - $1), used_bytes = used_bytes + $2, updated_at = now() WHERE membership_id = $3', [upload.expected_bytes, object.size, auth.mid]);
      return created.rows[0];
    });
    return { media: asset };
  });

  app.get('/media/:mediaId/download', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request) => {
    const auth = currentAuth(request);
    const { mediaId } = z.object({ mediaId: z.string().uuid() }).parse(request.params);
    const result = await tenantTransaction(auth.iid, (client) => client.query(
      `SELECT ma.object_key, ma.mime_type, ma.membership_id
         FROM media_assets ma
        WHERE ma.id = $1 AND ma.institution_id = $2 AND ma.status = 'active'
          AND (ma.membership_id = $3
            OR EXISTS (SELECT 1 FROM post_media pm JOIN posts p ON p.id = pm.post_id WHERE pm.media_id = ma.id AND p.institution_id = $2 AND p.deleted_at IS NULL AND p.visibility <> 'private' AND (p.story_expires_at IS NULL OR p.story_expires_at > now())
              AND (p.visibility = 'campus' OR EXISTS (SELECT 1 FROM follows f WHERE f.institution_id = $2 AND f.status = 'accepted' AND ((f.follower_membership_id = $3 AND f.followed_membership_id = p.author_membership_id) OR (f.followed_membership_id = $3 AND f.follower_membership_id = p.author_membership_id))))
              AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.institution_id = $2 AND ((b.blocker_membership_id = $3 AND b.blocked_membership_id = p.author_membership_id) OR (b.blocked_membership_id = $3 AND b.blocker_membership_id = p.author_membership_id))))
            OR EXISTS (SELECT 1 FROM study_resources sr WHERE sr.media_id = ma.id AND sr.institution_id = $2 AND (sr.status = 'approved' OR (sr.status = 'pending_review' AND $4::text IN ('institution_admin','moderator'))) AND sr.visibility <> 'private'
              AND (sr.visibility = 'campus' OR EXISTS (SELECT 1 FROM follows f WHERE f.institution_id = $2 AND f.status = 'accepted' AND ((f.follower_membership_id = $3 AND f.followed_membership_id = sr.contributor_membership_id) OR (f.followed_membership_id = $3 AND f.follower_membership_id = sr.contributor_membership_id))))
              AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.institution_id = $2 AND ((b.blocker_membership_id = $3 AND b.blocked_membership_id = sr.contributor_membership_id) OR (b.blocked_membership_id = $3 AND b.blocker_membership_id = sr.contributor_membership_id))))
            OR EXISTS (SELECT 1 FROM profiles p WHERE p.avatar_media_id = ma.id AND p.institution_id = $2 AND p.visibility <> 'private' AND p.discoverable = true
              AND (p.visibility = 'campus' OR EXISTS (SELECT 1 FROM follows f WHERE f.institution_id = $2 AND f.status = 'accepted' AND ((f.follower_membership_id = $3 AND f.followed_membership_id = p.membership_id) OR (f.followed_membership_id = $3 AND f.follower_membership_id = p.membership_id))))
              AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.institution_id = $2 AND ((b.blocker_membership_id = $3 AND b.blocked_membership_id = p.membership_id) OR (b.blocked_membership_id = $3 AND b.blocker_membership_id = p.membership_id))))
            OR EXISTS (SELECT 1 FROM marketplace_listings ml WHERE ml.media_id = ma.id AND ml.institution_id = $2 AND ml.status = 'active' AND ml.expires_at > now()
              AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.institution_id = $2 AND ((b.blocker_membership_id = $3 AND b.blocked_membership_id = ml.seller_membership_id) OR (b.blocked_membership_id = $3 AND b.blocker_membership_id = ml.seller_membership_id))))
            OR EXISTS (SELECT 1 FROM messages msg JOIN conversation_members cm ON cm.conversation_id = msg.conversation_id WHERE msg.attachment_media_id = ma.id AND msg.institution_id = $2 AND cm.membership_id = $3 AND cm.left_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM conversation_members other_cm JOIN blocks b ON b.institution_id = $2 AND ((b.blocker_membership_id = $3 AND b.blocked_membership_id = other_cm.membership_id) OR (b.blocked_membership_id = $3 AND b.blocker_membership_id = other_cm.membership_id)) WHERE other_cm.institution_id = $2 AND other_cm.conversation_id = msg.conversation_id AND other_cm.membership_id <> $3 AND other_cm.left_at IS NULL)))`, [mediaId, auth.iid, auth.mid, auth.role]
    ));
    const media = result.rows[0];
    if (!media) throw notFound('Media not found or not accessible');
    if (!uploadsConfigured) throw unavailable('Object storage is not configured');
    return { url: await presignDownload(media.object_key, media.mime_type), expiresInSeconds: 60 };
  });
}
function conflictUpload() {
  return conflict('Upload has already been finalized or changed');
}
