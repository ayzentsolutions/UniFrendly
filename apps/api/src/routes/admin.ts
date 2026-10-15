import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTransaction } from '../db/pool.js';
import { currentAuth, requireAuth, requireRole } from '../plugins/auth.js';
import { hashToken, newOpaqueToken } from '../utils/crypto.js';
import { badRequest, notFound } from '../utils/errors.js';

const invitationSchema = z.object({ email: z.string().trim().email().max(254), role: z.enum(['student', 'alumni']).default('student'), rosterReference: z.string().trim().max(120).optional(), expiresInDays: z.number().int().min(1).max(14).default(7) });
const moderationSchema = z.object({ action: z.enum(['dismiss', 'remove', 'suspend_membership']), note: z.string().trim().max(1000).default('') });
const campusSettingsSchema = z.object({
  imageMaxBytes: z.number().int().min(65_536).max(10_485_760).optional(),
  imagesPerPost: z.number().int().min(1).max(4).optional(),
  pdfMaxBytes: z.number().int().min(1_024).max(10_485_760).optional(),
  studentQuotaBytes: z.number().int().min(0).max(1_073_741_824).optional(),
  storyTtlHours: z.number().int().min(1).max(168).optional(),
  listingTtlDays: z.number().int().min(1).max(365).optional(),
  notificationRetentionDays: z.number().int().min(1).max(3650).optional(),
  temporaryUploadTtlHours: z.number().int().min(1).max(24).optional()
}).strict().refine((value) => Object.keys(value).length > 0, 'Supply at least one setting');
const DEFAULT_CAMPUS_SETTINGS = { imageMaxBytes: 1_048_576, imagesPerPost: 4, pdfMaxBytes: 10_485_760, studentQuotaBytes: 52_428_800, storyTtlHours: 24, listingTtlDays: 30, notificationRetentionDays: 90, temporaryUploadTtlHours: 24 };

export async function adminRoutes(app: FastifyInstance) {
  app.get('/admin/settings', { preHandler: [requireAuth, requireRole('institution_admin')] }, async (request) => {
    const auth = currentAuth(request);
    const result = await tenantTransaction(auth.iid, (client) => client.query('SELECT config FROM institutions WHERE id = $1 AND status = $2', [auth.iid, 'active']));
    if (!result.rows[0]) throw notFound('Institution not found');
    return { settings: { ...DEFAULT_CAMPUS_SETTINGS, ...(result.rows[0].config as Record<string, unknown>) } };
  });

  app.patch('/admin/settings', { preHandler: [requireAuth, requireRole('institution_admin')] }, async (request) => {
    const auth = currentAuth(request);
    const body = campusSettingsSchema.parse(request.body);
    const result = await tenantTransaction(auth.iid, async (client) => {
      const current = await client.query('SELECT config FROM institutions WHERE id = $1 AND status = $2 FOR UPDATE', [auth.iid, 'active']);
      if (!current.rows[0]) throw notFound('Institution not found');
      const previous = current.rows[0].config as Record<string, unknown>;
      const next = { ...DEFAULT_CAMPUS_SETTINGS, ...previous, ...body };
      await client.query('UPDATE institutions SET config = $2::jsonb, updated_at = now() WHERE id = $1', [auth.iid, JSON.stringify(next)]);
      await client.query('INSERT INTO audit_logs (institution_id, actor_membership_id, action, target_type, target_id, metadata) VALUES ($1,$2,$3,$4,$5,$6)', [auth.iid, auth.mid, 'institution.settings.updated', 'institution', auth.iid, JSON.stringify({ changedKeys: Object.keys(body) })]);
      return next;
    });
    return { settings: result };
  });

  app.patch('/admin/memberships/:membershipId/storage-quota', { preHandler: [requireAuth, requireRole('institution_admin')] }, async (request) => {
    const auth = currentAuth(request);
    const { membershipId } = z.object({ membershipId: z.string().uuid() }).parse(request.params);
    const body = z.object({ quotaBytes: z.number().int().min(0).max(1_073_741_824) }).strict().parse(request.body);
    const result = await tenantTransaction(auth.iid, async (client) => {
      const usage = await client.query('SELECT used_bytes, reserved_bytes FROM media_usage WHERE membership_id = $1 AND institution_id = $2 FOR UPDATE', [membershipId, auth.iid]);
      if (!usage.rows[0]) throw notFound('Campus member storage record not found');
      if (Number(usage.rows[0].used_bytes) + Number(usage.rows[0].reserved_bytes) > body.quotaBytes) throw badRequest('The new quota cannot be lower than storage already used or reserved');
      const changed = await client.query('UPDATE media_usage SET quota_bytes = $3, updated_at = now() WHERE membership_id = $1 AND institution_id = $2 RETURNING membership_id, quota_bytes, used_bytes, reserved_bytes', [membershipId, auth.iid, body.quotaBytes]);
      await client.query('INSERT INTO audit_logs (institution_id, actor_membership_id, action, target_type, target_id, metadata) VALUES ($1,$2,$3,$4,$5,$6)', [auth.iid, auth.mid, 'member.storage_quota.updated', 'membership', membershipId, JSON.stringify({ quotaBytes: body.quotaBytes })]);
      return changed.rows[0];
    });
    return { storage: result };
  });
  app.post('/admin/invitations', { preHandler: [requireAuth, requireRole('institution_admin')] }, async (request) => {
    const auth = currentAuth(request);
    const body = invitationSchema.parse(request.body);
    const token = newOpaqueToken();
    const email = body.email.toLowerCase();
    const result = await tenantTransaction(auth.iid, async (client) => {
      const institution = await client.query('SELECT id FROM institutions WHERE id = $1 AND status = $2', [auth.iid, 'active']);
      if (!institution.rowCount) throw notFound('Institution not found');
      const inserted = await client.query(
        `INSERT INTO institution_invitations (institution_id, email, role, roster_ref, token_hash, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5, now() + ($6::int * interval '1 day'), $7)
         RETURNING id, email, role, expires_at`,
        [auth.iid, email, body.role, body.rosterReference ? hashToken(body.rosterReference) : null, hashToken(token), body.expiresInDays, auth.sub]
      );
      await client.query('INSERT INTO audit_logs (institution_id, actor_membership_id, action, target_type, target_id, metadata) VALUES ($1,$2,$3,$4,$5,$6)', [auth.iid, auth.mid, 'invitation.created', 'invitation', inserted.rows[0].id, JSON.stringify({ email, role: body.role })]);
      return inserted.rows[0];
    });
    // The opaque token is revealed once so the institution can distribute a secure invitation.
    return { invitation: result, token, acceptancePath: '/v1/auth/invitations/accept' };
  });

  app.get('/admin/moderation/reports', { preHandler: [requireAuth, requireRole('institution_admin', 'moderator')] }, async (request) => {
    const auth = currentAuth(request);
    const q = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().datetime().optional(), status: z.enum(['open','in_review','actioned','dismissed','appealed']).optional() }).parse(request.query);
    const result = await tenantTransaction(auth.iid, (client) => client.query(
      `SELECT r.id, r.target_type, r.target_id, r.reason, r.details, r.status, r.created_at,
              reporter.display_name AS reporter_name
         FROM reports r JOIN memberships rm ON rm.id = r.reporter_membership_id
         JOIN app_users reporter ON reporter.id = rm.user_id
        WHERE r.institution_id = $1 AND ($2::text IS NULL OR r.status = $2) AND ($3::timestamptz IS NULL OR r.created_at < $3)
        ORDER BY r.created_at DESC, r.id DESC LIMIT $4`, [auth.iid, q.status ?? null, q.cursor ?? null, q.limit]
    ));
    return { items: result.rows, nextCursor: result.rows.length === q.limit ? new Date(result.rows[result.rows.length - 1]!.created_at).toISOString() : null };
  });

  app.get('/admin/moderation/study-resources', { preHandler: [requireAuth, requireRole('institution_admin', 'moderator')] }, async (request) => {
    const auth = currentAuth(request);
    const q = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().datetime().optional() }).parse(request.query);
    const result = await tenantTransaction(auth.iid, (client) => client.query(
      `SELECT sr.id, sr.media_id, sr.title, sr.description, sr.subject, sr.semester, sr.programme, sr.created_at,
              m.id AS contributor_membership_id, u.display_name AS contributor_name, ma.byte_size
         FROM study_resources sr JOIN memberships m ON m.id = sr.contributor_membership_id
         JOIN app_users u ON u.id = m.user_id JOIN media_assets ma ON ma.id = sr.media_id
        WHERE sr.institution_id = $1 AND sr.status = 'pending_review'
          AND ($2::timestamptz IS NULL OR sr.created_at < $2)
        ORDER BY sr.created_at DESC, sr.id DESC LIMIT $3`, [auth.iid, q.cursor ?? null, q.limit]
    ));
    return { items: result.rows, nextCursor: result.rows.length === q.limit ? new Date(result.rows[result.rows.length - 1]!.created_at).toISOString() : null };
  });

  app.post('/admin/moderation/reports/:reportId/resolve', { preHandler: [requireAuth, requireRole('institution_admin', 'moderator')] }, async (request) => {
    const auth = currentAuth(request);
    const params = z.object({ reportId: z.string().uuid() }).parse(request.params);
    const body = moderationSchema.parse(request.body);
    if (body.action === 'suspend_membership') throw badRequest('Membership suspension requires a separate, documented institution review workflow.');
    await tenantTransaction(auth.iid, async (client) => {
      const report = await client.query('SELECT * FROM reports WHERE id = $1 AND institution_id = $2 FOR UPDATE', [params.reportId, auth.iid]);
      if (!report.rowCount) throw notFound('Report not found');
      if (body.action === 'remove') {
        const r = report.rows[0];
        const tableByType: Record<string, string> = { post: 'posts', comment: 'post_comments', study_resource: 'study_resources', event: 'campus_events', listing: 'marketplace_listings' };
        const table = tableByType[r.target_type as string];
        if (table) {
          const statusSql = table === 'posts' || table === 'post_comments' ? 'deleted_at = now()' : table === 'study_resources' ? "status = 'removed'" : table === 'campus_events' ? "status = 'cancelled'" : "status = 'removed'";
          await client.query(`UPDATE ${table} SET ${statusSql} WHERE id = $1 AND institution_id = $2`, [r.target_id, auth.iid]);
        }
      }
      await client.query('UPDATE reports SET status = $1, assigned_to = $2, resolution = $3, updated_at = now() WHERE id = $4', [body.action === 'dismiss' ? 'dismissed' : 'actioned', auth.mid, body.note, params.reportId]);
      await client.query('INSERT INTO audit_logs (institution_id, actor_membership_id, action, target_type, target_id, metadata) VALUES ($1,$2,$3,$4,$5,$6)', [auth.iid, auth.mid, `report.${body.action}`, 'report', params.reportId, JSON.stringify({ note: body.note })]);
    });
    return { ok: true };
  });
}
