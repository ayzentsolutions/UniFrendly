import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tenantTransaction } from '../db/pool.js';
import { currentAuth, requireAuth } from '../plugins/auth.js';
import { badRequest, notFound } from '../utils/errors.js';

export async function notificationRoutes(app: FastifyInstance) {
  app.get('/notifications', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const q = z.object({ limit: z.coerce.number().int().min(1).max(50).default(25), cursor: z.string().datetime().optional(), unreadOnly: z.coerce.boolean().default(false) }).parse(request.query);
    const result = await tenantTransaction(auth.iid, (client) => client.query(
      `SELECT n.id, n.category, n.title, n.body, n.resource_type, n.resource_id, n.read_at, n.created_at,
              actor.display_name AS actor_name
         FROM notifications n LEFT JOIN memberships am ON am.id = n.actor_membership_id LEFT JOIN app_users actor ON actor.id = am.user_id
        WHERE n.institution_id = $1 AND n.recipient_membership_id = $2 AND n.expires_at > now()
          AND ($3::timestamptz IS NULL OR n.created_at < $3) AND (NOT $4 OR n.read_at IS NULL)
        ORDER BY n.created_at DESC, n.id DESC LIMIT $5`, [auth.iid, auth.mid, q.cursor ?? null, q.unreadOnly, q.limit]
    ));
    return { items: result.rows, nextCursor: result.rows.length === q.limit ? new Date(result.rows[result.rows.length - 1]!.created_at).toISOString() : null };
  });
  app.get('/notifications/unread-count', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const result = await tenantTransaction(auth.iid, (client) => client.query('SELECT count(*)::int AS count FROM notifications WHERE institution_id = $1 AND recipient_membership_id = $2 AND read_at IS NULL AND expires_at > now()', [auth.iid, auth.mid]));
    return { count: result.rows[0]?.count ?? 0 };
  });
  app.put('/notifications/:notificationId/read', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const { notificationId } = z.object({ notificationId: z.string().uuid() }).parse(request.params);
    const result = await tenantTransaction(auth.iid, (client) => client.query('UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND institution_id = $2 AND recipient_membership_id = $3 RETURNING id', [notificationId, auth.iid, auth.mid]));
    if (!result.rowCount) throw notFound('Notification not found');
    return { ok: true };
  });
  app.put('/notifications/read-all', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    await tenantTransaction(auth.iid, (client) => client.query('UPDATE notifications SET read_at = now() WHERE institution_id = $1 AND recipient_membership_id = $2 AND read_at IS NULL AND expires_at > now()', [auth.iid, auth.mid]));
    return { ok: true };
  });
  app.post('/devices/push-token', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const body = z.object({ token: z.string().trim().min(20).max(512), platform: z.enum(['ios','android']) }).parse(request.body);
    if ((!body.token.startsWith('ExponentPushToken[') && !body.token.startsWith('ExpoPushToken[')) || !body.token.endsWith(']')) throw badRequest('Push token format is not recognized');
    await tenantTransaction(auth.iid, (client) => client.query(`INSERT INTO device_push_tokens (institution_id, membership_id, token, platform, active, updated_at)
      VALUES ($1,$2,$3,$4,true,now()) ON CONFLICT (token) DO UPDATE SET institution_id = EXCLUDED.institution_id, membership_id = EXCLUDED.membership_id, platform = EXCLUDED.platform, active = true, updated_at = now()`, [auth.iid, auth.mid, body.token, body.platform]));
    return { ok: true };
  });
  app.delete('/devices/push-token', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const body = z.object({ token: z.string().trim().min(20).max(512) }).parse(request.body);
    await tenantTransaction(auth.iid, (client) => client.query('UPDATE device_push_tokens SET active = false, updated_at = now() WHERE institution_id = $1 AND membership_id = $2 AND token = $3', [auth.iid, auth.mid, body.token]));
    return { ok: true };
  });

  app.get('/me/export', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const data = await tenantTransaction(auth.iid, async (client) => {
      const [profile, posts, comments, reactions, connections, resources, listings, registrations, messages] = await Promise.all([
        client.query('SELECT u.email, u.display_name, p.* FROM app_users u JOIN memberships m ON m.user_id = u.id JOIN profiles p ON p.membership_id = m.id WHERE m.id = $1 AND m.institution_id = $2', [auth.mid, auth.iid]),
        client.query('SELECT id, body, visibility, created_at, deleted_at FROM posts WHERE institution_id = $1 AND author_membership_id = $2 ORDER BY created_at DESC LIMIT 5000', [auth.iid, auth.mid]),
        client.query('SELECT id, post_id, body, created_at, deleted_at FROM post_comments WHERE institution_id = $1 AND author_membership_id = $2 ORDER BY created_at DESC LIMIT 5000', [auth.iid, auth.mid]),
        client.query('SELECT post_id, reaction, created_at FROM post_reactions WHERE institution_id = $1 AND membership_id = $2 ORDER BY created_at DESC LIMIT 5000', [auth.iid, auth.mid]),
        client.query('SELECT follower_membership_id, followed_membership_id, status, created_at FROM follows WHERE institution_id = $1 AND (follower_membership_id = $2 OR followed_membership_id = $2) LIMIT 5000', [auth.iid, auth.mid]),
        client.query('SELECT id, title, subject, status, created_at FROM study_resources WHERE institution_id = $1 AND contributor_membership_id = $2 ORDER BY created_at DESC LIMIT 2000', [auth.iid, auth.mid]),
        client.query('SELECT id, title, description, category, price_minor, status, created_at FROM marketplace_listings WHERE institution_id = $1 AND seller_membership_id = $2 ORDER BY created_at DESC LIMIT 2000', [auth.iid, auth.mid]),
        client.query('SELECT event_id, status, created_at FROM event_registrations WHERE institution_id = $1 AND membership_id = $2 ORDER BY created_at DESC LIMIT 2000', [auth.iid, auth.mid]),
        client.query('SELECT id, conversation_id, body, created_at, deleted_at FROM messages WHERE institution_id = $1 AND sender_membership_id = $2 ORDER BY created_at DESC LIMIT 10000', [auth.iid, auth.mid])
      ]);
      return { exportedAt: new Date().toISOString(), institutionId: auth.iid, account: profile.rows[0] ?? null, posts: posts.rows, comments: comments.rows, reactions: reactions.rows, connections: connections.rows, studyResources: resources.rows, marketplaceListings: listings.rows, eventRegistrations: registrations.rows, messages: messages.rows, limits: { posts: 5000, comments: 5000, connections: 5000, studyResources: 2000, listings: 2000, events: 2000, messages: 10000 } };
    });
    return data;
  });

  app.delete('/me/account', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const body = z.object({ confirmation: z.literal('DELETE MY ACCOUNT'), password: z.string().min(1).max(256) }).parse(request.body);
    const user = await pool.query('SELECT password_hash FROM app_users WHERE id = $1', [auth.sub]);
    if (!user.rows[0]?.password_hash) throw badRequest('Account cannot be deleted using this session');
    const argon2 = await import('argon2');
    if (!(await argon2.default.verify(user.rows[0].password_hash, body.password))) throw badRequest('Password confirmation failed');
    await tenantTransaction(auth.iid, async (client) => {
      await client.query("UPDATE app_users SET account_status = 'deleted', display_name = 'Deleted student', email = $1, password_hash = NULL, updated_at = now() WHERE id = $2", [`deleted+${auth.sub}@invalid.unifrendly`, auth.sub]);
      await client.query("UPDATE memberships SET status = 'revoked', updated_at = now() WHERE id = $1 AND institution_id = $2", [auth.mid, auth.iid]);
      await client.query("UPDATE profiles SET bio = '', interests = '{}', department = NULL, programme = NULL, batch_year = NULL, discoverable = false, visibility = 'private', allow_messages = 'nobody', avatar_media_id = NULL, updated_at = now() WHERE membership_id = $1 AND institution_id = $2", [auth.mid, auth.iid]);
      await client.query('UPDATE posts SET deleted_at = now(), updated_at = now() WHERE institution_id = $1 AND author_membership_id = $2 AND deleted_at IS NULL', [auth.iid, auth.mid]);
      await client.query('UPDATE post_comments SET deleted_at = now() WHERE institution_id = $1 AND author_membership_id = $2 AND deleted_at IS NULL', [auth.iid, auth.mid]);
      await client.query('DELETE FROM post_reactions WHERE institution_id = $1 AND membership_id = $2', [auth.iid, auth.mid]);
      await client.query('DELETE FROM post_bookmarks WHERE institution_id = $1 AND membership_id = $2', [auth.iid, auth.mid]);
      await client.query('DELETE FROM follows WHERE institution_id = $1 AND (follower_membership_id = $2 OR followed_membership_id = $2)', [auth.iid, auth.mid]);
      await client.query('DELETE FROM blocks WHERE institution_id = $1 AND (blocker_membership_id = $2 OR blocked_membership_id = $2)', [auth.iid, auth.mid]);
      await client.query("UPDATE messages SET body = '[message deleted]', attachment_media_id = NULL, deleted_at = now() WHERE institution_id = $1 AND sender_membership_id = $2 AND deleted_at IS NULL", [auth.iid, auth.mid]);
      await client.query("UPDATE study_resources SET status = 'removed', updated_at = now() WHERE institution_id = $1 AND contributor_membership_id = $2", [auth.iid, auth.mid]);
      await client.query("UPDATE marketplace_listings SET status = 'removed', updated_at = now() WHERE institution_id = $1 AND seller_membership_id = $2 AND status = 'active'", [auth.iid, auth.mid]);
      await client.query('UPDATE user_settings SET push_enabled = false, notify_messages = false, notify_connections = false, notify_events = false, notify_study = false, notify_marketplace = false, private_message_previews = false WHERE membership_id = $1 AND institution_id = $2', [auth.mid, auth.iid]);
      await client.query('UPDATE device_push_tokens SET active = false, updated_at = now() WHERE membership_id = $1 AND institution_id = $2', [auth.mid, auth.iid]);
      await client.query('UPDATE auth_sessions SET revoked_at = now() WHERE membership_id = $1 AND revoked_at IS NULL', [auth.mid]);
      await client.query('INSERT INTO audit_logs (institution_id, actor_membership_id, action, target_type, target_id, metadata) VALUES ($1,NULL,$2,$3,$4,$5)', [auth.iid, 'account.deleted', 'membership', auth.mid, JSON.stringify({ dataCleanupQueued: true })]);
    });
    return { ok: true, message: 'Account access has been revoked and identifying profile data has been anonymized. Media cleanup runs after the documented recovery window.' };
  });
}
