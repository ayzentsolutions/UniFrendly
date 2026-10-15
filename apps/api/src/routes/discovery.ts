import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTransaction } from '../db/pool.js';
import { currentAuth, requireAuth } from '../plugins/auth.js';
import { badRequest, forbidden, notFound } from '../utils/errors.js';

const searchSchema = z.object({ q: z.string().trim().max(80).optional(), department: z.string().trim().max(120).optional(), programme: z.string().trim().max(120).optional(), batchYear: z.coerce.number().int().min(1950).max(2150).optional(), interest: z.string().trim().max(50).optional(), limit: z.coerce.number().int().min(1).max(30).default(20), cursor: z.string().uuid().optional() });

export async function discoveryRoutes(app: FastifyInstance) {
  app.get('/students', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const q = searchSchema.parse(request.query);
    // Search uses bounded fields, escaped wildcard inputs and a mandatory institution predicate.
    const safeQ = q.q?.replace(/[\\%_]/g, (s) => `\\${s}`);
    const result = await tenantTransaction(auth.iid, (client) => client.query(
      `SELECT m.id AS membership_id, u.display_name, p.department, p.programme, p.batch_year, p.bio, p.interests,
              EXISTS(SELECT 1 FROM follows f WHERE f.institution_id = $1 AND f.status = 'accepted' AND ((f.follower_membership_id = $2 AND f.followed_membership_id = m.id) OR (f.follower_membership_id = m.id AND f.followed_membership_id = $2))) AS connected,
              (SELECT f.status FROM follows f WHERE f.institution_id = $1 AND f.follower_membership_id = $2 AND f.followed_membership_id = m.id) AS my_request_status,
              (SELECT f.status FROM follows f WHERE f.institution_id = $1 AND f.follower_membership_id = m.id AND f.followed_membership_id = $2) AS their_request_status
         FROM memberships m JOIN app_users u ON u.id = m.user_id
         JOIN profiles p ON p.membership_id = m.id
        WHERE m.institution_id = $1 AND m.status = 'verified' AND u.account_status = 'active'
          AND m.id <> $2 AND p.discoverable = true AND p.visibility <> 'private'
          AND ($3::text IS NULL OR u.display_name ILIKE '%' || $3 || '%' OR COALESCE(p.department,'') ILIKE '%' || $3 || '%' OR COALESCE(p.programme,'') ILIKE '%' || $3 || '%')
          AND ($4::text IS NULL OR p.department ILIKE $4)
          AND ($5::text IS NULL OR p.programme ILIKE $5)
          AND ($6::smallint IS NULL OR p.batch_year = $6)
          AND ($7::text IS NULL OR EXISTS (SELECT 1 FROM unnest(p.interests) interest WHERE interest ILIKE '%' || $7 || '%'))
          AND (p.visibility = 'campus' OR EXISTS(SELECT 1 FROM follows f WHERE f.institution_id = $1 AND f.status = 'accepted' AND ((f.follower_membership_id = $2 AND f.followed_membership_id = m.id) OR (f.followed_membership_id = $2 AND f.follower_membership_id = m.id))))
          AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.institution_id = $1 AND ((b.blocker_membership_id = $2 AND b.blocked_membership_id = m.id) OR (b.blocker_membership_id = m.id AND b.blocked_membership_id = $2)))
          AND ($8::uuid IS NULL OR m.id > $8)
        ORDER BY m.id ASC LIMIT $9`,
      [auth.iid, auth.mid, safeQ ?? null, q.department ? q.department : null, q.programme ? q.programme : null, q.batchYear ?? null, q.interest ?? null, q.cursor ?? null, q.limit]
    ));
    return { items: result.rows, nextCursor: result.rows.length === q.limit ? result.rows[result.rows.length - 1]!.membership_id : null };
  });

  app.get('/connections', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const result = await tenantTransaction(auth.iid, (client) => client.query(
      `SELECT f.follower_membership_id, f.followed_membership_id, f.status, f.created_at,
              u.display_name, p.department, p.programme,
              CASE WHEN f.follower_membership_id = $2 THEN 'outgoing' ELSE 'incoming' END AS direction
         FROM follows f
         JOIN memberships other_m ON other_m.id = CASE WHEN f.follower_membership_id = $2 THEN f.followed_membership_id ELSE f.follower_membership_id END
         JOIN app_users u ON u.id = other_m.user_id LEFT JOIN profiles p ON p.membership_id = other_m.id
        WHERE f.institution_id = $1 AND (f.follower_membership_id = $2 OR f.followed_membership_id = $2)
          AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.institution_id = $1 AND ((b.blocker_membership_id = $2 AND b.blocked_membership_id = other_m.id) OR (b.blocker_membership_id = other_m.id AND b.blocked_membership_id = $2)))
        ORDER BY f.updated_at DESC LIMIT 100`, [auth.iid, auth.mid]
    ));
    return { items: result.rows };
  });

  app.post('/students/:membershipId/connect', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const { membershipId } = z.object({ membershipId: z.string().uuid() }).parse(request.params);
    if (membershipId === auth.mid) throw badRequest('You cannot connect to yourself');
    await tenantTransaction(auth.iid, async (client) => {
      const target = await client.query(
        `SELECT m.id, p.allow_messages FROM memberships m JOIN profiles p ON p.membership_id = m.id
         WHERE m.id = $1 AND m.institution_id = $2 AND m.status = 'verified' AND p.discoverable = true AND p.visibility <> 'private'`, [membershipId, auth.iid]
      );
      if (!target.rowCount) throw notFound('Student not found');
      const blocked = await client.query('SELECT 1 FROM blocks WHERE institution_id = $1 AND ((blocker_membership_id = $2 AND blocked_membership_id = $3) OR (blocker_membership_id = $3 AND blocked_membership_id = $2))', [auth.iid, auth.mid, membershipId]);
      if (blocked.rowCount) throw forbidden('Connection unavailable');
      await client.query(`INSERT INTO follows (institution_id, follower_membership_id, followed_membership_id, status)
        VALUES ($1,$2,$3,'pending') ON CONFLICT (follower_membership_id, followed_membership_id) DO UPDATE SET status = CASE WHEN follows.status = 'rejected' THEN 'pending' ELSE follows.status END, updated_at = now()`, [auth.iid, auth.mid, membershipId]);
      await client.query(`INSERT INTO notifications (institution_id, recipient_membership_id, actor_membership_id, category, title, body, resource_type, resource_id, dedupe_key)
        VALUES ($1,$2,$3,'connection','Connection request','A student wants to connect with you','profile',$3,$4) ON CONFLICT DO NOTHING`, [auth.iid, membershipId, auth.mid, `connection:${auth.mid}:${membershipId}`]);
    });
    return { ok: true, status: 'pending' };
  });

  app.patch('/connections/:membershipId/accept', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const { membershipId } = z.object({ membershipId: z.string().uuid() }).parse(request.params);
    await tenantTransaction(auth.iid, async (client) => {
      const update = await client.query(`UPDATE follows SET status = 'accepted', updated_at = now()
        WHERE institution_id = $1 AND follower_membership_id = $2 AND followed_membership_id = $3 AND status = 'pending' RETURNING follower_membership_id`, [auth.iid, membershipId, auth.mid]);
      if (!update.rowCount) throw notFound('Pending connection request not found');
      await client.query(`INSERT INTO notifications (institution_id, recipient_membership_id, actor_membership_id, category, title, body, resource_type, resource_id, dedupe_key)
        VALUES ($1,$2,$3,'connection','Connection accepted','Your connection request was accepted','profile',$3,$4) ON CONFLICT DO NOTHING`, [auth.iid, membershipId, auth.mid, `connection-accepted:${membershipId}:${auth.mid}`]);
    });
    return { ok: true, status: 'accepted' };
  });

  app.delete('/connections/:membershipId', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const { membershipId } = z.object({ membershipId: z.string().uuid() }).parse(request.params);
    await tenantTransaction(auth.iid, async (client) => {
      await client.query(`DELETE FROM follows WHERE institution_id = $1 AND ((follower_membership_id = $2 AND followed_membership_id = $3) OR (follower_membership_id = $3 AND followed_membership_id = $2))`, [auth.iid, auth.mid, membershipId]);
    });
    return { ok: true };
  });

  app.post('/students/:membershipId/block', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const { membershipId } = z.object({ membershipId: z.string().uuid() }).parse(request.params);
    if (membershipId === auth.mid) throw badRequest('You cannot block yourself');
    await tenantTransaction(auth.iid, async (client) => {
      const target = await client.query("SELECT id FROM memberships WHERE id = $1 AND institution_id = $2 AND status = 'verified'", [membershipId, auth.iid]);
      if (!target.rowCount) throw notFound('Student not found');
      await client.query('INSERT INTO blocks (institution_id, blocker_membership_id, blocked_membership_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [auth.iid, auth.mid, membershipId]);
      await client.query('DELETE FROM follows WHERE institution_id = $1 AND ((follower_membership_id = $2 AND followed_membership_id = $3) OR (follower_membership_id = $3 AND followed_membership_id = $2))', [auth.iid, auth.mid, membershipId]);
      await client.query('INSERT INTO audit_logs (institution_id, actor_membership_id, action, target_type, target_id) VALUES ($1,$2,$3,$4,$5)', [auth.iid, auth.mid, 'student.blocked', 'membership', membershipId]);
    });
    return { ok: true };
  });

  app.delete('/students/:membershipId/block', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const { membershipId } = z.object({ membershipId: z.string().uuid() }).parse(request.params);
    await tenantTransaction(auth.iid, (client) => client.query('DELETE FROM blocks WHERE institution_id = $1 AND blocker_membership_id = $2 AND blocked_membership_id = $3', [auth.iid, auth.mid, membershipId]));
    return { ok: true };
  });

  app.patch('/me/profile', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const body = z.object({ bio: z.string().trim().max(500).optional(), department: z.string().trim().max(120).nullable().optional(), programme: z.string().trim().max(120).nullable().optional(), batchYear: z.number().int().min(1950).max(2150).nullable().optional(), interests: z.array(z.string().trim().min(1).max(40)).max(20).optional(), visibility: z.enum(['private','connections','campus']).optional(), discoverable: z.boolean().optional(), allowMessages: z.enum(['nobody','connections','campus']).optional() }).strict().parse(request.body);
    const map: Record<string, string> = { bio: 'bio', department: 'department', programme: 'programme', batchYear: 'batch_year', interests: 'interests', visibility: 'visibility', discoverable: 'discoverable', allowMessages: 'allow_messages' };
    const entries = Object.entries(body);
    if (!entries.length) throw badRequest('No profile fields supplied');
    await tenantTransaction(auth.iid, async (client) => {
      const values: unknown[] = [auth.mid, auth.iid];
      const assignments = entries.map(([key, val]) => { values.push(val); return `${map[key]} = $${values.length}`; });
      const result = await client.query(`UPDATE profiles SET ${assignments.join(', ')}, updated_at = now() WHERE membership_id = $1 AND institution_id = $2 RETURNING membership_id`, values);
      if (!result.rowCount) throw notFound('Profile not found');
    });
    return { ok: true };
  });
}
