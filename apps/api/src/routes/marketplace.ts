import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTransaction } from '../db/pool.js';
import { currentAuth, requireAuth } from '../plugins/auth.js';
import { badRequest, forbidden, notFound } from '../utils/errors.js';
import { readConfigNumber } from '../utils/institutionConfig.js';

const listingSchema = z.object({ title: z.string().trim().min(1).max(120), description: z.string().trim().max(2000).default(''), category: z.enum(['used_books','stationery','permitted_service','canteen','lost_found']), priceMinor: z.number().int().min(0).max(100_000_000).nullable().optional(), currency: z.string().trim().regex(/^[A-Z]{3}$/).default('INR'), mediaId: z.string().uuid().optional() });
export async function marketplaceRoutes(app: FastifyInstance) {
  app.get('/campus/marketplace', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const q = z.object({ category: z.enum(['used_books','stationery','permitted_service','canteen','lost_found']).optional(), q: z.string().trim().max(80).optional(), limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().datetime().optional() }).parse(request.query);
    const result = await tenantTransaction(auth.iid, (client) => client.query(
      `SELECT l.id, l.title, l.description, l.category, l.price_minor, l.currency, l.media_id, l.expires_at, l.created_at,
              u.display_name AS seller_name, l.seller_membership_id
         FROM marketplace_listings l JOIN memberships m ON m.id = l.seller_membership_id JOIN app_users u ON u.id = m.user_id
        WHERE l.institution_id = $1 AND l.status = 'active' AND l.expires_at > now()
          AND ($2::text IS NULL OR l.category = $2) AND ($3::text IS NULL OR l.title ILIKE '%' || $3 || '%' OR l.description ILIKE '%' || $3 || '%')
          AND ($4::timestamptz IS NULL OR l.created_at < $4)
          AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.institution_id = $1 AND ((b.blocker_membership_id = $5 AND b.blocked_membership_id = l.seller_membership_id) OR (b.blocked_membership_id = $5 AND b.blocker_membership_id = l.seller_membership_id)))
        ORDER BY l.created_at DESC, l.id DESC LIMIT $6`, [auth.iid, q.category ?? null, q.q ?? null, q.cursor ?? null, auth.mid, q.limit]
    ));
    return { items: result.rows, nextCursor: result.rows.length === q.limit ? new Date(result.rows[result.rows.length - 1]!.created_at).toISOString() : null };
  });

  app.post('/campus/marketplace', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const body = listingSchema.parse(request.body);
    const result = await tenantTransaction(auth.iid, async (client) => {
      const institutionResult = await client.query('SELECT config FROM institutions WHERE id = $1 AND status = $2', [auth.iid, 'active']);
      if (!institutionResult.rows[0]) throw notFound('Campus not found');
      const listingTtlDays = readConfigNumber(institutionResult.rows[0].config as Record<string, unknown>, 'listingTtlDays', 30, 1, 365);
      if (body.mediaId) {
        const media = await client.query("SELECT id FROM media_assets WHERE id = $1 AND institution_id = $2 AND membership_id = $3 AND status = 'active' AND media_kind IN ('image','avatar')", [body.mediaId, auth.iid, auth.mid]);
        if (!media.rowCount) throw forbidden('Listing image is unavailable');
      }
      const inserted = await client.query(
        `INSERT INTO marketplace_listings (institution_id, seller_membership_id, title, description, category, price_minor, currency, media_id, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now() + ($9::int * interval '1 day')) RETURNING id, title, category, status, expires_at, created_at`,
        [auth.iid, auth.mid, body.title, body.description, body.category, body.priceMinor ?? null, body.currency, body.mediaId ?? null, listingTtlDays]
      );
      await client.query('INSERT INTO outbox_events (institution_id, event_type, aggregate_id, payload, dedupe_key) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [auth.iid, 'listing.created', inserted.rows[0].id, JSON.stringify({ title: body.title, category: body.category }), `listing.created:${inserted.rows[0].id}`]);
      return inserted.rows[0];
    });
    return { listing: result };
  });

  app.patch('/campus/marketplace/:listingId', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const { listingId } = z.object({ listingId: z.string().uuid() }).parse(request.params);
    const body = listingSchema.partial().strict().parse(request.body);
    if (!Object.keys(body).length) throw badRequest('No listing fields supplied');
    const mapping: Record<string, string> = { title: 'title', description: 'description', category: 'category', priceMinor: 'price_minor', currency: 'currency', mediaId: 'media_id' };
    await tenantTransaction(auth.iid, async (client) => {
      if (body.mediaId) {
        const media = await client.query("SELECT id FROM media_assets WHERE id = $1 AND institution_id = $2 AND membership_id = $3 AND status = 'active' AND media_kind IN ('image','avatar')", [body.mediaId, auth.iid, auth.mid]);
        if (!media.rowCount) throw forbidden('Listing image is unavailable');
      }
      const values: unknown[] = [listingId, auth.iid, auth.mid];
      const updates = Object.entries(body).map(([key, val]) => { values.push(val); return `${mapping[key]} = $${values.length}`; });
      const updated = await client.query(`UPDATE marketplace_listings SET ${updates.join(', ')}, updated_at = now() WHERE id = $1 AND institution_id = $2 AND seller_membership_id = $3 AND status = 'active' RETURNING id`, values);
      if (!updated.rowCount) throw notFound('Active listing not found');
    });
    return { ok: true };
  });

  app.post('/campus/marketplace/:listingId/renew', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const { listingId } = z.object({ listingId: z.string().uuid() }).parse(request.params);
    const result = await tenantTransaction(auth.iid, async (client) => {
      const institutionResult = await client.query('SELECT config FROM institutions WHERE id = $1 AND status = $2', [auth.iid, 'active']);
      if (!institutionResult.rows[0]) throw notFound('Campus not found');
      const listingTtlDays = readConfigNumber(institutionResult.rows[0].config as Record<string, unknown>, 'listingTtlDays', 30, 1, 365);
      return client.query(`UPDATE marketplace_listings SET status = 'active', expires_at = now() + ($4::int * interval '1 day'), updated_at = now()
        WHERE id = $1 AND institution_id = $2 AND seller_membership_id = $3 AND status IN ('active','expired') RETURNING id, expires_at`, [listingId, auth.iid, auth.mid, listingTtlDays]);
    });
    if (!result.rowCount) throw notFound('Listing not found');
    return { listing: result.rows[0] };
  });

  app.patch('/campus/marketplace/:listingId/status', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const { listingId } = z.object({ listingId: z.string().uuid() }).parse(request.params);
    const body = z.object({ status: z.enum(['sold','removed']) }).parse(request.body);
    const result = await tenantTransaction(auth.iid, (client) => client.query(`UPDATE marketplace_listings SET status = $1, updated_at = now()
      WHERE id = $2 AND institution_id = $3 AND seller_membership_id = $4 AND status = 'active' RETURNING id`, [body.status, listingId, auth.iid, auth.mid]));
    if (!result.rowCount) throw notFound('Active listing not found');
    return { ok: true };
  });
}
