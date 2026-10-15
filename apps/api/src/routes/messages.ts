import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTransaction } from '../db/pool.js';
import { currentAuth, requireAuth } from '../plugins/auth.js';
import { badRequest, forbidden, notFound } from '../utils/errors.js';

const newConversationSchema = z.object({ kind: z.enum(['direct','group']), memberIds: z.array(z.string().uuid()).min(1).max(49), title: z.string().trim().min(1).max(100).optional() });
const messageSchema = z.object({ clientMessageId: z.string().uuid(), body: z.string().max(5000).default(''), attachmentMediaId: z.string().uuid().optional() }).refine((v) => v.body.trim().length > 0 || Boolean(v.attachmentMediaId), 'Message needs text or an attachment');
const cursorSchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(30), before: z.string().datetime().optional() });

export async function messageRoutes(app: FastifyInstance) {
  app.get('/conversations', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const result = await tenantTransaction(auth.iid, (client) => client.query(
      `SELECT c.id, c.kind, c.title, c.created_at, c.updated_at, cm.request_status AS my_request_status,
              (SELECT json_agg(json_build_object('membershipId', cm2.membership_id, 'displayName', u2.display_name, 'role', cm2.role, 'requestStatus', cm2.request_status)
                 ORDER BY u2.display_name)
                 FROM conversation_members cm2 JOIN memberships m2 ON m2.id = cm2.membership_id JOIN app_users u2 ON u2.id = m2.user_id
                WHERE cm2.conversation_id = c.id AND cm2.left_at IS NULL) AS members,
              (SELECT json_build_object('id', msg.id, 'body', msg.body, 'senderMembershipId', msg.sender_membership_id, 'createdAt', msg.created_at)
                 FROM messages msg WHERE msg.conversation_id = c.id AND msg.deleted_at IS NULL ORDER BY msg.created_at DESC, msg.id DESC LIMIT 1) AS last_message,
              (SELECT count(*)::int FROM messages msg WHERE msg.conversation_id = c.id AND msg.deleted_at IS NULL AND msg.sender_membership_id <> $2 AND (cm.last_read_at IS NULL OR msg.created_at > cm.last_read_at)) AS unread_count
         FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
        WHERE cm.institution_id = $1 AND cm.membership_id = $2 AND cm.left_at IS NULL AND c.institution_id = $1
          AND NOT EXISTS (SELECT 1 FROM conversation_members other_cm JOIN blocks b ON b.institution_id = $1
            AND ((b.blocker_membership_id = cm.membership_id AND b.blocked_membership_id = other_cm.membership_id)
              OR (b.blocked_membership_id = cm.membership_id AND b.blocker_membership_id = other_cm.membership_id))
            WHERE other_cm.institution_id = $1 AND other_cm.conversation_id = c.id AND other_cm.membership_id <> cm.membership_id AND other_cm.left_at IS NULL)
        ORDER BY COALESCE(c.updated_at, c.created_at) DESC LIMIT 100`, [auth.iid, auth.mid]
    ));
    return { items: result.rows };
  });

  app.post('/conversations', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const body = newConversationSchema.parse(request.body);
    const members = [...new Set([...body.memberIds, auth.mid])];
    if (body.kind === 'direct' && members.length !== 2) throw badRequest('Direct conversations require exactly two members');
    if (body.kind === 'group' && members.length < 3) throw badRequest('Group conversations require at least three members');
    const result = await tenantTransaction(auth.iid, async (client) => {
      const valid = await client.query(
        `SELECT m.id, p.allow_messages, p.discoverable, p.visibility FROM memberships m JOIN profiles p ON p.membership_id = m.id
         WHERE m.institution_id = $1 AND m.status = 'verified' AND m.id = ANY($2::uuid[]) AND (m.id = $3 OR (p.discoverable = true AND p.visibility <> 'private'))`, [auth.iid, members, auth.mid]
      );
      if (valid.rowCount !== members.length) throw notFound('One or more students are not members of this campus');
      const blocked = await client.query('SELECT 1 FROM blocks WHERE institution_id = $1 AND blocker_membership_id = ANY($2::uuid[]) AND blocked_membership_id = ANY($2::uuid[]) LIMIT 1', [auth.iid, members]);
      if (blocked.rowCount) throw forbidden('Conversation unavailable');
      let requestPending = false;
      if (body.kind === 'direct') {
        const other = members.find((id) => id !== auth.mid)!;
        const target = valid.rows.find((row) => row.id === other)!;
        if (target.allow_messages === 'nobody') throw forbidden('This student is not accepting message requests');
        const connection = await client.query(`SELECT 1 FROM follows WHERE institution_id = $1 AND status = 'accepted'
          AND ((follower_membership_id = $2 AND followed_membership_id = $3) OR (follower_membership_id = $3 AND followed_membership_id = $2)) LIMIT 1`, [auth.iid, auth.mid, other]);
        if (!connection.rowCount && target.allow_messages === 'connections') throw forbidden('Connect with this student before sending a message');
        requestPending = !connection.rowCount && target.allow_messages === 'campus';
        const existing = await client.query(
          `SELECT c.id FROM conversations c
           JOIN conversation_members self ON self.conversation_id = c.id AND self.membership_id = $2 AND self.left_at IS NULL
           JOIN conversation_members other ON other.conversation_id = c.id AND other.membership_id = $3 AND other.left_at IS NULL
           WHERE c.institution_id = $1 AND c.kind = 'direct'
             AND (SELECT count(*) FROM conversation_members cm WHERE cm.conversation_id = c.id AND cm.left_at IS NULL) = 2
           LIMIT 1`, [auth.iid, auth.mid, other]
        );
        if (existing.rows[0]) return { id: existing.rows[0].id, kind: 'direct', existing: true };
      }
      const conversation = await client.query('INSERT INTO conversations (institution_id, kind, title, created_by) VALUES ($1,$2,$3,$4) RETURNING id, kind, title, created_at', [auth.iid, body.kind, body.kind === 'group' ? body.title ?? 'Campus group' : null, auth.mid]);
      for (const memberId of members) await client.query('INSERT INTO conversation_members (institution_id, conversation_id, membership_id, role, request_status) VALUES ($1,$2,$3,$4,$5)', [auth.iid, conversation.rows[0].id, memberId, memberId === auth.mid ? 'admin' : 'member', memberId !== auth.mid && requestPending ? 'pending' : 'accepted']);
      return { ...conversation.rows[0], existing: false };
    });
    return { conversation: result };
  });

  app.get('/conversations/:conversationId/messages', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const { conversationId } = z.object({ conversationId: z.string().uuid() }).parse(request.params);
    const q = cursorSchema.parse(request.query);
    const result = await tenantTransaction(auth.iid, async (client) => {
      const member = await client.query(`SELECT cm.request_status, c.kind, EXISTS(SELECT 1 FROM conversation_members other WHERE other.institution_id = $1 AND other.conversation_id = $2 AND other.membership_id <> $3 AND other.left_at IS NULL AND other.request_status = 'pending') AS awaiting_response FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id WHERE cm.institution_id = $1 AND cm.conversation_id = $2 AND cm.membership_id = $3 AND cm.left_at IS NULL AND c.institution_id = $1`, [auth.iid, conversationId, auth.mid]);
      if (!member.rowCount) throw notFound('Conversation not found');
      const blocked = await client.query(`SELECT 1 FROM conversation_members other_cm JOIN blocks b ON b.institution_id = $1
        AND ((b.blocker_membership_id = $3 AND b.blocked_membership_id = other_cm.membership_id) OR (b.blocked_membership_id = $3 AND b.blocker_membership_id = other_cm.membership_id))
        WHERE other_cm.institution_id = $1 AND other_cm.conversation_id = $2 AND other_cm.membership_id <> $3 AND other_cm.left_at IS NULL LIMIT 1`, [auth.iid, conversationId, auth.mid]);
      if (blocked.rowCount) throw notFound('Conversation not found');
      const messages = await client.query(
        `SELECT msg.id, msg.sender_membership_id, msg.body, msg.attachment_media_id, msg.client_message_id, msg.created_at,
                u.display_name AS sender_name
           FROM messages msg JOIN memberships m ON m.id = msg.sender_membership_id JOIN app_users u ON u.id = m.user_id
          WHERE msg.institution_id = $1 AND msg.conversation_id = $2 AND msg.deleted_at IS NULL
            AND ($3::timestamptz IS NULL OR msg.created_at < $3)
          ORDER BY msg.created_at DESC, msg.id DESC LIMIT $4`, [auth.iid, conversationId, q.before ?? null, q.limit]
      );
      return { rows: messages.rows, myRequestStatus: member.rows[0].request_status as string, awaitingResponse: member.rows[0].kind === 'direct' && Boolean(member.rows[0].awaiting_response) };
    });
    const rows = result.rows.reverse();
    return { items: rows, myRequestStatus: result.myRequestStatus, awaitingResponse: result.awaitingResponse, nextCursor: rows.length === q.limit ? new Date(rows[0]!.created_at).toISOString() : null };
  });

  app.post('/conversations/:conversationId/messages', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const { conversationId } = z.object({ conversationId: z.string().uuid() }).parse(request.params);
    const body = messageSchema.parse(request.body);
    const result = await tenantTransaction(auth.iid, async (client) => {
      const conversation = await client.query(`SELECT c.kind, cm.request_status AS current_request_status FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id
        WHERE c.id = $1 AND c.institution_id = $2 AND cm.membership_id = $3 AND cm.left_at IS NULL`, [conversationId, auth.iid, auth.mid]);
      if (!conversation.rowCount) throw notFound('Conversation not found');
      if (conversation.rows[0].current_request_status === 'pending') throw forbidden('Accept this message request before replying');
      const pendingRequest = await client.query("SELECT 1 FROM conversation_members WHERE institution_id = $1 AND conversation_id = $2 AND left_at IS NULL AND request_status = 'pending' LIMIT 1", [auth.iid, conversationId]);
      if (conversation.rows[0].kind === 'direct' && pendingRequest.rowCount) throw forbidden('This message request is awaiting the recipient’s response');
      const members = await client.query('SELECT membership_id FROM conversation_members WHERE institution_id = $1 AND conversation_id = $2 AND left_at IS NULL', [auth.iid, conversationId]);
      const otherIds = members.rows.map((row) => row.membership_id as string).filter((id) => id !== auth.mid);
      if (!otherIds.length) throw forbidden('Conversation has no other active members');
      const blocked = await client.query('SELECT 1 FROM blocks WHERE institution_id = $1 AND ((blocker_membership_id = $2 AND blocked_membership_id = ANY($3::uuid[])) OR (blocked_membership_id = $2 AND blocker_membership_id = ANY($3::uuid[]))) LIMIT 1', [auth.iid, auth.mid, otherIds]);
      if (blocked.rowCount) throw forbidden('Messaging is unavailable in this conversation');
      if (body.attachmentMediaId) {
        const media = await client.query("SELECT id FROM media_assets WHERE id = $1 AND institution_id = $2 AND membership_id = $3 AND status = 'active'", [body.attachmentMediaId, auth.iid, auth.mid]);
        if (!media.rowCount) throw forbidden('Attachment is not available to this account');
      }
      const inserted = await client.query(
        `INSERT INTO messages (institution_id, conversation_id, sender_membership_id, client_message_id, body, attachment_media_id)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (sender_membership_id, client_message_id) DO NOTHING
         RETURNING id, body, attachment_media_id, created_at`, [auth.iid, conversationId, auth.mid, body.clientMessageId, body.body, body.attachmentMediaId ?? null]
      );
      let message = inserted.rows[0];
      if (!message) {
        const prior = await client.query('SELECT id, body, attachment_media_id, created_at FROM messages WHERE sender_membership_id = $1 AND client_message_id = $2', [auth.mid, body.clientMessageId]);
        message = prior.rows[0];
        if (!message || message.body !== body.body || message.attachment_media_id !== (body.attachmentMediaId ?? null)) throw badRequest('clientMessageId was already used with different content');
      } else {
        await client.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [conversationId]);
        for (const recipientId of otherIds) {
          await client.query(`INSERT INTO notifications (institution_id, recipient_membership_id, actor_membership_id, category, title, body, resource_type, resource_id, dedupe_key)
            SELECT $1,$2,$3,'message','New message', CASE WHEN s.private_message_previews THEN 'You have a new message' ELSE 'You have a new message' END, 'conversation',$4,$5
              FROM user_settings s WHERE s.membership_id = $2 AND s.notify_messages = true
            ON CONFLICT DO NOTHING`, [auth.iid, recipientId, auth.mid, conversationId, `message:${message.id}:${recipientId}`]);
        }
      }
      return { ...message, senderMembershipId: auth.mid };
    });
    return { message: result };
  });

  app.put('/conversations/:conversationId/request', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const { conversationId } = z.object({ conversationId: z.string().uuid() }).parse(request.params);
    const body = z.object({ decision: z.enum(['accept','reject']) }).parse(request.body);
    await tenantTransaction(auth.iid, async (client) => {
      const target = await client.query(`SELECT cm.request_status FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
        WHERE c.id = $1 AND c.institution_id = $2 AND c.kind = 'direct' AND cm.membership_id = $3 AND cm.left_at IS NULL FOR UPDATE OF cm`, [conversationId, auth.iid, auth.mid]);
      if (!target.rowCount || target.rows[0].request_status !== 'pending') throw notFound('Pending message request not found');
      if (body.decision === 'accept') {
        await client.query("UPDATE conversation_members SET request_status = 'accepted' WHERE institution_id = $1 AND conversation_id = $2 AND membership_id = $3 AND left_at IS NULL", [auth.iid, conversationId, auth.mid]);
      } else {
        await client.query("UPDATE conversation_members SET request_status = CASE WHEN membership_id = $3 THEN 'rejected' ELSE request_status END, left_at = now() WHERE institution_id = $1 AND conversation_id = $2 AND left_at IS NULL", [auth.iid, conversationId, auth.mid]);
      }
    });
    return { ok: true, status: body.decision === 'accept' ? 'accepted' : 'rejected' };
  });

  app.put('/conversations/:conversationId/read', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const { conversationId } = z.object({ conversationId: z.string().uuid() }).parse(request.params);
    const result = await tenantTransaction(auth.iid, (client) => client.query(`UPDATE conversation_members SET last_read_at = now()
      WHERE institution_id = $1 AND conversation_id = $2 AND membership_id = $3 AND left_at IS NULL RETURNING conversation_id`, [auth.iid, conversationId, auth.mid]));
    if (!result.rowCount) throw notFound('Conversation not found');
    return { ok: true };
  });
}
