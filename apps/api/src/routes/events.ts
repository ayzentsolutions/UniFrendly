import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTransaction } from '../db/pool.js';
import { currentAuth, requireAuth, requireRole } from '../plugins/auth.js';
import { badRequest, forbidden, notFound } from '../utils/errors.js';

const eventSchema = z.object({ title: z.string().trim().min(1).max(160), description: z.string().trim().max(4000).default(''), clubName: z.string().trim().max(120).optional(), locationLabel: z.string().trim().max(160).optional(), startsAt: z.string().datetime(), endsAt: z.string().datetime(), capacity: z.number().int().min(1).max(100000).optional() }).refine((v) => new Date(v.endsAt) > new Date(v.startsAt), 'Event end must follow its start');
export async function eventRoutes(app: FastifyInstance) {
  app.get('/campus/events', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const q = z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional(), q: z.string().trim().max(80).optional(), limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().datetime().optional() }).parse(request.query);
    const result = await tenantTransaction(auth.iid, (client) => client.query(
      `SELECT e.id, e.title, e.description, e.club_name, e.location_label, e.starts_at, e.ends_at, e.capacity, e.status,
              u.display_name AS creator_name,
              (SELECT count(*)::int FROM event_registrations r WHERE r.event_id = e.id AND r.status = 'registered') AS registered_count,
              EXISTS(SELECT 1 FROM event_registrations r WHERE r.event_id = e.id AND r.membership_id = $2 AND r.status = 'registered') AS registered_by_me
         FROM campus_events e JOIN memberships m ON m.id = e.creator_membership_id JOIN app_users u ON u.id = m.user_id
        WHERE e.institution_id = $1 AND e.status = 'published' AND e.ends_at > now()
          AND ($3::timestamptz IS NULL OR e.starts_at >= $3) AND ($4::timestamptz IS NULL OR e.starts_at <= $4)
          AND ($5::text IS NULL OR e.title ILIKE '%' || $5 || '%' OR COALESCE(e.club_name,'') ILIKE '%' || $5 || '%')
          AND ($6::timestamptz IS NULL OR e.starts_at > $6)
        ORDER BY e.starts_at ASC, e.id ASC LIMIT $7`, [auth.iid, auth.mid, q.from ?? null, q.to ?? null, q.q ?? null, q.cursor ?? null, q.limit]
    ));
    return { items: result.rows, nextCursor: result.rows.length === q.limit ? new Date(result.rows[result.rows.length - 1]!.starts_at).toISOString() : null };
  });

  app.post('/campus/events', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const body = eventSchema.parse(request.body);
    if (new Date(body.startsAt).getTime() < Date.now() - 60_000) throw badRequest('Event start must be in the future');
    const result = await tenantTransaction(auth.iid, async (client) => {
      const event = await client.query(`INSERT INTO campus_events (institution_id, creator_membership_id, title, description, club_name, location_label, starts_at, ends_at, capacity)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, title, starts_at, ends_at, status`, [auth.iid, auth.mid, body.title, body.description, body.clubName ?? null, body.locationLabel ?? null, body.startsAt, body.endsAt, body.capacity ?? null]);
      await client.query('INSERT INTO outbox_events (institution_id, event_type, aggregate_id, payload, dedupe_key) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [auth.iid, 'event.created', event.rows[0].id, JSON.stringify({ title: body.title, startsAt: body.startsAt }), `event.created:${event.rows[0].id}`]);
      return event.rows[0];
    });
    return { event: result };
  });

  app.post('/campus/events/:eventId/register', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const { eventId } = z.object({ eventId: z.string().uuid() }).parse(request.params);
    await tenantTransaction(auth.iid, async (client) => {
      const event = await client.query("SELECT id, capacity, starts_at FROM campus_events WHERE id = $1 AND institution_id = $2 AND status = 'published' AND ends_at > now() FOR UPDATE", [eventId, auth.iid]);
      if (!event.rowCount) throw notFound('Event is unavailable');
      const existing = await client.query('SELECT status FROM event_registrations WHERE event_id = $1 AND membership_id = $2 FOR UPDATE', [eventId, auth.mid]);
      if (existing.rows[0]?.status === 'registered') return;
      if (event.rows[0].capacity !== null) {
        const count = await client.query("SELECT count(*)::int AS count FROM event_registrations WHERE event_id = $1 AND status = 'registered'", [eventId]);
        if (count.rows[0].count >= event.rows[0].capacity) throw badRequest('This event is full', 'EVENT_FULL');
      }
      await client.query(`INSERT INTO event_registrations (institution_id, event_id, membership_id, status)
        VALUES ($1,$2,$3,'registered') ON CONFLICT (event_id, membership_id) DO UPDATE SET status = 'registered', updated_at = now()`, [auth.iid, eventId, auth.mid]);
      await client.query('INSERT INTO outbox_events (institution_id, event_type, aggregate_id, payload, dedupe_key) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [auth.iid, 'event.registered', eventId, JSON.stringify({ membershipId: auth.mid }), `event.registered:${eventId}:${auth.mid}`]);
    });
    return { ok: true, status: 'registered' };
  });

  app.delete('/campus/events/:eventId/register', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const { eventId } = z.object({ eventId: z.string().uuid() }).parse(request.params);
    await tenantTransaction(auth.iid, async (client) => {
      const result = await client.query("UPDATE event_registrations SET status = 'cancelled', updated_at = now() WHERE institution_id = $1 AND event_id = $2 AND membership_id = $3 AND status = 'registered' RETURNING event_id", [auth.iid, eventId, auth.mid]);
      if (!result.rowCount) throw notFound('Registration not found');
    });
    return { ok: true };
  });

  app.patch('/campus/events/:eventId/cancel', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const { eventId } = z.object({ eventId: z.string().uuid() }).parse(request.params);
    const result = await tenantTransaction(auth.iid, async (client) => {
      const event = await client.query(`UPDATE campus_events SET status = 'cancelled', updated_at = now()
        WHERE id = $1 AND institution_id = $2 AND (creator_membership_id = $3 OR $4::boolean) AND status = 'published' RETURNING id, title`, [eventId, auth.iid, auth.mid, ['institution_admin','moderator'].includes(auth.role)]);
      if (!event.rowCount) throw forbidden('You cannot cancel this event, or it is already cancelled');
      await client.query('INSERT INTO outbox_events (institution_id, event_type, aggregate_id, payload, dedupe_key) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [auth.iid, 'event.cancelled', eventId, JSON.stringify({ title: event.rows[0].title }), `event.cancelled:${eventId}`]);
      return event.rows[0];
    });
    return { event: result };
  });

  app.get('/campus/calendar', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const q = z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional() }).parse(request.query);
    const result = await tenantTransaction(auth.iid, (client) => client.query(
      `SELECT e.id, e.title, e.description, e.location_label, e.starts_at, e.ends_at, r.status AS registration_status
         FROM event_registrations r JOIN campus_events e ON e.id = r.event_id
        WHERE r.institution_id = $1 AND r.membership_id = $2 AND r.status = 'registered'
          AND ($3::timestamptz IS NULL OR e.starts_at >= $3) AND ($4::timestamptz IS NULL OR e.starts_at <= $4)
        ORDER BY e.starts_at ASC LIMIT 200`, [auth.iid, auth.mid, q.from ?? null, q.to ?? null]
    ));
    return { items: result.rows };
  });
}
