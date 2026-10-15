import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTransaction } from '../db/pool.js';
import { currentAuth, requireAuth, requireRole } from '../plugins/auth.js';
import { forbidden, notFound } from '../utils/errors.js';

const resourceSchema = z.object({ mediaId: z.string().uuid(), title: z.string().trim().min(1).max(160), description: z.string().trim().max(1000).default(''), subject: z.string().trim().min(1).max(120), semester: z.string().trim().max(40).optional(), programme: z.string().trim().max(120).optional(), visibility: z.enum(['campus','connections']).default('campus') });
export async function studyRoutes(app: FastifyInstance) {
  app.get('/study/resources', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const q = z.object({ q: z.string().trim().max(80).optional(), subject: z.string().trim().max(120).optional(), semester: z.string().trim().max(40).optional(), programme: z.string().trim().max(120).optional(), limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().datetime().optional() }).parse(request.query);
    const result = await tenantTransaction(auth.iid, (client) => client.query(
      `SELECT sr.id, sr.media_id, sr.title, sr.description, sr.subject, sr.semester, sr.programme, sr.created_at,
              sr.contributor_membership_id, u.display_name AS contributor_name, ma.byte_size,
              (SELECT count(*)::int FROM reports r WHERE r.institution_id = sr.institution_id AND r.target_type = 'study_resource' AND r.target_id = sr.id AND r.status IN ('open','in_review')) AS open_reports
         FROM study_resources sr JOIN memberships m ON m.id = sr.contributor_membership_id
         JOIN app_users u ON u.id = m.user_id JOIN media_assets ma ON ma.id = sr.media_id
        WHERE sr.institution_id = $1 AND sr.status = 'approved' AND ($2::text IS NULL OR sr.title ILIKE '%' || $2 || '%' OR sr.subject ILIKE '%' || $2 || '%')
          AND ($3::text IS NULL OR sr.subject ILIKE $3) AND ($4::text IS NULL OR sr.semester ILIKE $4) AND ($5::text IS NULL OR sr.programme ILIKE $5)
          AND ($6::timestamptz IS NULL OR sr.created_at < $6)
          AND (sr.visibility = 'campus' OR EXISTS (SELECT 1 FROM follows f WHERE f.institution_id = $1 AND f.status = 'accepted' AND ((f.follower_membership_id = $7 AND f.followed_membership_id = sr.contributor_membership_id) OR (f.followed_membership_id = $7 AND f.follower_membership_id = sr.contributor_membership_id))))
          AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.institution_id = $1 AND ((b.blocker_membership_id = $7 AND b.blocked_membership_id = sr.contributor_membership_id) OR (b.blocked_membership_id = $7 AND b.blocker_membership_id = sr.contributor_membership_id)))
        ORDER BY sr.created_at DESC, sr.id DESC LIMIT $8`, [auth.iid, q.q ?? null, q.subject ?? null, q.semester ?? null, q.programme ?? null, q.cursor ?? null, auth.mid, q.limit]
    ));
    return { items: result.rows, nextCursor: result.rows.length === q.limit ? new Date(result.rows[result.rows.length - 1]!.created_at).toISOString() : null };
  });

  app.post('/study/resources', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const body = resourceSchema.parse(request.body);
    const resource = await tenantTransaction(auth.iid, async (client) => {
      const media = await client.query("SELECT id FROM media_assets WHERE id = $1 AND institution_id = $2 AND membership_id = $3 AND media_kind = 'pdf' AND mime_type = 'application/pdf' AND status = 'active'", [body.mediaId, auth.iid, auth.mid]);
      if (!media.rowCount) throw forbidden('A validated PDF uploaded by this account is required');
      const created = await client.query(
        `INSERT INTO study_resources (institution_id, contributor_membership_id, media_id, title, description, subject, semester, programme, visibility)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, title, status, created_at`, [auth.iid, auth.mid, body.mediaId, body.title, body.description, body.subject, body.semester ?? null, body.programme ?? null, body.visibility]
      );
      await client.query('INSERT INTO outbox_events (institution_id, event_type, aggregate_id, payload, dedupe_key) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [auth.iid, 'study.submitted', created.rows[0].id, JSON.stringify({ contributorMembershipId: auth.mid }), `study.submitted:${created.rows[0].id}`]);
      return created.rows[0];
    });
    return { resource };
  });

  app.get('/study/resources/mine', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const result = await tenantTransaction(auth.iid, (client) => client.query('SELECT id, title, subject, semester, programme, status, created_at, updated_at FROM study_resources WHERE institution_id = $1 AND contributor_membership_id = $2 ORDER BY created_at DESC LIMIT 50', [auth.iid, auth.mid]));
    return { items: result.rows };
  });

  app.post('/study/resources/:resourceId/review', { preHandler: [requireAuth, requireRole('institution_admin','moderator')] }, async (request) => {
    const auth = currentAuth(request);
    const { resourceId } = z.object({ resourceId: z.string().uuid() }).parse(request.params);
    const body = z.object({ decision: z.enum(['approve','reject']), note: z.string().trim().max(1000).default('') }).parse(request.body);
    const result = await tenantTransaction(auth.iid, async (client) => {
      const updated = await client.query(`UPDATE study_resources SET status = $1, updated_at = now()
        WHERE id = $2 AND institution_id = $3 AND status = 'pending_review' RETURNING id, contributor_membership_id, title`, [body.decision === 'approve' ? 'approved' : 'rejected', resourceId, auth.iid]);
      if (!updated.rowCount) throw notFound('Pending study resource not found');
      await client.query('INSERT INTO audit_logs (institution_id, actor_membership_id, action, target_type, target_id, metadata) VALUES ($1,$2,$3,$4,$5,$6)', [auth.iid, auth.mid, `study.${body.decision}`, 'study_resource', resourceId, JSON.stringify({ note: body.note })]);
      await client.query(`INSERT INTO notifications (institution_id, recipient_membership_id, actor_membership_id, category, title, body, resource_type, resource_id, dedupe_key)
        VALUES ($1,$2,$3,'study',$4,$5,'study_resource',$6,$7) ON CONFLICT DO NOTHING`, [auth.iid, updated.rows[0].contributor_membership_id, auth.mid, body.decision === 'approve' ? 'Study resource approved' : 'Study resource not approved', body.decision === 'approve' ? 'Your study resource is available to campus members' : 'Your study resource needs changes', resourceId, `study.review:${resourceId}:${body.decision}`]);
      return updated.rows[0];
    });
    return { resource: result };
  });
}
