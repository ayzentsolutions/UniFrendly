import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTransaction } from '../db/pool.js';
import { currentAuth, requireAuth } from '../plugins/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors.js';
import { pageSchema } from '../utils/pagination.js';
import { readConfigNumber } from '../utils/institutionConfig.js';

const createPostSchema = z.object({ body: z.string().trim().max(5000).default(''), mediaIds: z.array(z.string().uuid()).max(4).default([]), visibility: z.enum(['campus', 'connections']).default('campus'), story: z.boolean().default(false) }).refine((value) => value.body.length > 0 || value.mediaIds.length > 0, 'A post needs text or at least one image');
const commentSchema = z.object({ body: z.string().trim().min(1).max(2000) });
const reactionSchema = z.object({ reaction: z.enum(['like','love','laugh','support','insightful']) });

export async function postRoutes(app: FastifyInstance) {
  app.get('/feed', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const q = pageSchema.extend({ mode: z.enum(['posts','stories']).default('posts') }).parse(request.query);
    const result = await tenantTransaction(auth.iid, (client) => client.query(
      `SELECT p.id, p.body, p.visibility, p.created_at, p.author_membership_id,
              u.display_name AS author_name, pr.department, pr.programme,
              COALESCE((SELECT json_agg(json_build_object('id', ma.id, 'mimeType', ma.mime_type, 'byteSize', ma.byte_size) ORDER BY pm.position)
                FROM post_media pm JOIN media_assets ma ON ma.id = pm.media_id AND ma.status = 'active'
                WHERE pm.post_id = p.id AND pm.institution_id = p.institution_id), '[]'::json) AS media,
              COALESCE((SELECT count(*) FROM post_comments c WHERE c.post_id = p.id AND c.deleted_at IS NULL), 0)::int AS comment_count,
              COALESCE((SELECT count(*) FROM post_reactions r WHERE r.post_id = p.id), 0)::int AS reaction_count,
              EXISTS(SELECT 1 FROM post_reactions r WHERE r.post_id = p.id AND r.membership_id = $2) AS reacted_by_me,
              EXISTS(SELECT 1 FROM post_bookmarks b WHERE b.post_id = p.id AND b.membership_id = $2) AS bookmarked_by_me
         FROM posts p JOIN memberships m ON m.id = p.author_membership_id JOIN app_users u ON u.id = m.user_id
         LEFT JOIN profiles pr ON pr.membership_id = m.id
        WHERE p.institution_id = $1 AND p.deleted_at IS NULL
          AND (($3 = 'stories' AND p.story_expires_at > now()) OR ($3 = 'posts' AND p.story_expires_at IS NULL))
          AND ($4::timestamptz IS NULL OR p.created_at < $4)
          AND (p.visibility = 'campus' OR EXISTS (SELECT 1 FROM follows f WHERE f.institution_id = p.institution_id AND f.status = 'accepted' AND ((f.follower_membership_id = $2 AND f.followed_membership_id = p.author_membership_id) OR (f.followed_membership_id = $2 AND f.follower_membership_id = p.author_membership_id))))
          AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.institution_id = p.institution_id AND ((b.blocker_membership_id = $2 AND b.blocked_membership_id = p.author_membership_id) OR (b.blocked_membership_id = $2 AND b.blocker_membership_id = p.author_membership_id)))
        ORDER BY p.created_at DESC, p.id DESC LIMIT $5`,
      [auth.iid, auth.mid, q.mode, q.cursor ?? null, q.limit]
    ));
    const rows = result.rows;
    return { items: rows, nextCursor: rows.length === q.limit ? new Date(rows[rows.length - 1]!.created_at).toISOString() : null };
  });

  app.get('/posts/:postId', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const { postId } = z.object({ postId: z.string().uuid() }).parse(request.params);
    const result = await tenantTransaction(auth.iid, (client) => client.query(
      `SELECT p.id, p.body, p.visibility, p.created_at, p.author_membership_id, u.display_name AS author_name,
              pr.department, pr.programme,
              COALESCE((SELECT json_agg(json_build_object('id', ma.id, 'mimeType', ma.mime_type, 'byteSize', ma.byte_size) ORDER BY pm.position)
                FROM post_media pm JOIN media_assets ma ON ma.id = pm.media_id AND ma.status = 'active'
                WHERE pm.post_id = p.id AND pm.institution_id = p.institution_id), '[]'::json) AS media,
              COALESCE((SELECT count(*)::int FROM post_comments c WHERE c.post_id = p.id AND c.deleted_at IS NULL), 0) AS comment_count,
              COALESCE((SELECT count(*)::int FROM post_reactions r WHERE r.post_id = p.id), 0) AS reaction_count,
              EXISTS(SELECT 1 FROM post_reactions r WHERE r.post_id = p.id AND r.membership_id = $2) AS reacted_by_me,
              EXISTS(SELECT 1 FROM post_bookmarks b WHERE b.post_id = p.id AND b.membership_id = $2) AS bookmarked_by_me
         FROM posts p JOIN memberships m ON m.id = p.author_membership_id JOIN app_users u ON u.id = m.user_id
         LEFT JOIN profiles pr ON pr.membership_id = m.id
        WHERE p.id = $1 AND p.institution_id = $3 AND p.deleted_at IS NULL AND p.story_expires_at IS NULL
          AND (p.visibility = 'campus' OR EXISTS(SELECT 1 FROM follows f WHERE f.institution_id = $3 AND f.status = 'accepted' AND ((f.follower_membership_id = $2 AND f.followed_membership_id = p.author_membership_id) OR (f.followed_membership_id = $2 AND f.follower_membership_id = p.author_membership_id))))
          AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.institution_id = $3 AND ((b.blocker_membership_id = $2 AND b.blocked_membership_id = p.author_membership_id) OR (b.blocked_membership_id = $2 AND b.blocker_membership_id = p.author_membership_id)))`,
      [postId, auth.mid, auth.iid]
    ));
    if (!result.rows[0]) throw notFound('Post not found');
    return { post: result.rows[0] };
  });

  app.get('/posts/:postId/comments', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const { postId } = z.object({ postId: z.string().uuid() }).parse(request.params);
    const q = pageSchema.extend({ cursor: z.string().datetime().optional() }).parse(request.query);
    const result = await tenantTransaction(auth.iid, async (client) => {
      const post = await client.query(`SELECT p.id FROM posts p WHERE p.id = $1 AND p.institution_id = $2 AND p.deleted_at IS NULL AND p.story_expires_at IS NULL AND (p.visibility = 'campus' OR EXISTS(SELECT 1 FROM follows f WHERE f.institution_id = $2 AND f.status = 'accepted' AND ((f.follower_membership_id = $3 AND f.followed_membership_id = p.author_membership_id) OR (f.followed_membership_id = $3 AND f.follower_membership_id = p.author_membership_id)))) AND NOT EXISTS(SELECT 1 FROM blocks b WHERE b.institution_id = $2 AND ((b.blocker_membership_id = $3 AND b.blocked_membership_id = p.author_membership_id) OR (b.blocked_membership_id = $3 AND b.blocker_membership_id = p.author_membership_id)))`, [postId, auth.iid, auth.mid]);
      if (!post.rowCount) throw notFound('Post not found');
      return client.query(
        `SELECT c.id, c.body, c.created_at, c.author_membership_id, u.display_name AS author_name
           FROM post_comments c JOIN memberships m ON m.id = c.author_membership_id JOIN app_users u ON u.id = m.user_id
          WHERE c.institution_id = $1 AND c.post_id = $2 AND c.deleted_at IS NULL AND ($3::timestamptz IS NULL OR c.created_at < $3)
          ORDER BY c.created_at DESC, c.id DESC LIMIT $4`, [auth.iid, postId, q.cursor ?? null, q.limit]
      );
    });
    const rows = result.rows;
    return { items: rows, nextCursor: rows.length === q.limit ? new Date(rows[rows.length - 1]!.created_at).toISOString() : null };
  });

  app.post('/posts', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const body = createPostSchema.parse(request.body);
    const result = await tenantTransaction(auth.iid, async (client) => {
      const institutionResult = await client.query('SELECT config FROM institutions WHERE id = $1 AND status = $2', [auth.iid, 'active']);
      if (!institutionResult.rows[0]) throw notFound('Campus not found');
      const config = institutionResult.rows[0].config as Record<string, unknown>;
      const imagesPerPost = readConfigNumber(config, 'imagesPerPost', 4, 1, 4);
      const storyTtlHours = readConfigNumber(config, 'storyTtlHours', 24, 1, 168);
      if (body.mediaIds.length > imagesPerPost) throw badRequest(`This campus allows up to ${imagesPerPost} image(s) per post`);
      if (body.mediaIds.length) {
        const media = await client.query(
          `SELECT id FROM media_assets WHERE institution_id = $1 AND membership_id = $2 AND id = ANY($3::uuid[]) AND status = 'active' AND media_kind IN ('image','avatar')`,
          [auth.iid, auth.mid, body.mediaIds]
        );
        if (media.rowCount !== body.mediaIds.length) throw forbidden('One or more images are unavailable for this account');
      }
      const post = await client.query(
        `INSERT INTO posts (institution_id, author_membership_id, body, visibility, story_expires_at)
         VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN now() + ($6::int * interval '1 hour') ELSE NULL END)
         RETURNING id, body, visibility, story_expires_at, created_at`, [auth.iid, auth.mid, body.body, body.visibility, body.story, storyTtlHours]
      );
      for (const [position, mediaId] of body.mediaIds.entries()) await client.query('INSERT INTO post_media (post_id, media_id, institution_id, position) VALUES ($1,$2,$3,$4)', [post.rows[0].id, mediaId, auth.iid, position]);
      await client.query('INSERT INTO outbox_events (institution_id, event_type, aggregate_id, payload, dedupe_key) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (dedupe_key) DO NOTHING', [auth.iid, 'post.created', post.rows[0].id, JSON.stringify({ authorMembershipId: auth.mid }), `post.created:${post.rows[0].id}`]);
      return post.rows[0];
    });
    return { post: result };
  });

  app.delete('/posts/:postId', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const { postId } = z.object({ postId: z.string().uuid() }).parse(request.params);
    const result = await tenantTransaction(auth.iid, async (client) => client.query(
      `UPDATE posts SET deleted_at = now(), updated_at = now() WHERE id = $1 AND institution_id = $2 AND author_membership_id = $3 AND deleted_at IS NULL RETURNING id`, [postId, auth.iid, auth.mid]
    ));
    if (!result.rowCount) throw notFound('Post not found');
    return { ok: true };
  });

  app.post('/posts/:postId/comments', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const { postId } = z.object({ postId: z.string().uuid() }).parse(request.params);
    const body = commentSchema.parse(request.body);
    const result = await tenantTransaction(auth.iid, async (client) => {
      const post = await client.query(`SELECT p.author_membership_id FROM posts p WHERE p.id = $1 AND p.institution_id = $2 AND p.deleted_at IS NULL AND p.story_expires_at IS NULL AND (p.visibility = 'campus' OR EXISTS(SELECT 1 FROM follows f WHERE f.institution_id = $2 AND f.status = 'accepted' AND ((f.follower_membership_id = $3 AND f.followed_membership_id = p.author_membership_id) OR (f.followed_membership_id = $3 AND f.follower_membership_id = p.author_membership_id)))) AND NOT EXISTS(SELECT 1 FROM blocks b WHERE b.institution_id = $2 AND ((b.blocker_membership_id = $3 AND b.blocked_membership_id = p.author_membership_id) OR (b.blocked_membership_id = $3 AND b.blocker_membership_id = p.author_membership_id)))`, [postId, auth.iid, auth.mid]);
      if (!post.rowCount) throw notFound('Post not found');
      const comment = await client.query('INSERT INTO post_comments (institution_id, post_id, author_membership_id, body) VALUES ($1,$2,$3,$4) RETURNING id, body, created_at', [auth.iid, postId, auth.mid, body.body]);
      if (post.rows[0].author_membership_id !== auth.mid) {
        await client.query(`INSERT INTO notifications (institution_id, recipient_membership_id, actor_membership_id, category, title, body, resource_type, resource_id, dedupe_key)
          VALUES ($1,$2,$3,'comment','New comment','Someone commented on your post','post',$4,$5) ON CONFLICT DO NOTHING`, [auth.iid, post.rows[0].author_membership_id, auth.mid, postId, `comment:${comment.rows[0].id}`]);
      }
      return comment.rows[0];
    });
    return { comment: result };
  });

  app.put('/posts/:postId/reaction', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const { postId } = z.object({ postId: z.string().uuid() }).parse(request.params);
    const body = reactionSchema.parse(request.body);
    await tenantTransaction(auth.iid, async (client) => {
      const post = await client.query(`SELECT p.id FROM posts p WHERE p.id = $1 AND p.institution_id = $2 AND p.deleted_at IS NULL AND p.story_expires_at IS NULL AND (p.visibility = 'campus' OR EXISTS(SELECT 1 FROM follows f WHERE f.institution_id = $2 AND f.status = 'accepted' AND ((f.follower_membership_id = $3 AND f.followed_membership_id = p.author_membership_id) OR (f.followed_membership_id = $3 AND f.follower_membership_id = p.author_membership_id)))) AND NOT EXISTS(SELECT 1 FROM blocks b WHERE b.institution_id = $2 AND ((b.blocker_membership_id = $3 AND b.blocked_membership_id = p.author_membership_id) OR (b.blocked_membership_id = $3 AND b.blocker_membership_id = p.author_membership_id)))`, [postId, auth.iid, auth.mid]);
      if (!post.rowCount) throw notFound('Post not found');
      await client.query(`INSERT INTO post_reactions (institution_id, post_id, membership_id, reaction) VALUES ($1,$2,$3,$4)
        ON CONFLICT (post_id, membership_id) DO UPDATE SET reaction = EXCLUDED.reaction, created_at = now()`, [auth.iid, postId, auth.mid, body.reaction]);
    });
    return { ok: true };
  });
  app.delete('/posts/:postId/reaction', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const { postId } = z.object({ postId: z.string().uuid() }).parse(request.params);
    await tenantTransaction(auth.iid, (client) => client.query('DELETE FROM post_reactions WHERE institution_id = $1 AND post_id = $2 AND membership_id = $3', [auth.iid, postId, auth.mid]));
    return { ok: true };
  });

  app.put('/posts/:postId/bookmark', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const { postId } = z.object({ postId: z.string().uuid() }).parse(request.params);
    await tenantTransaction(auth.iid, async (client) => {
      const post = await client.query(`SELECT p.id FROM posts p WHERE p.id = $1 AND p.institution_id = $2 AND p.deleted_at IS NULL AND p.story_expires_at IS NULL AND (p.visibility = 'campus' OR EXISTS(SELECT 1 FROM follows f WHERE f.institution_id = $2 AND f.status = 'accepted' AND ((f.follower_membership_id = $3 AND f.followed_membership_id = p.author_membership_id) OR (f.followed_membership_id = $3 AND f.follower_membership_id = p.author_membership_id)))) AND NOT EXISTS(SELECT 1 FROM blocks b WHERE b.institution_id = $2 AND ((b.blocker_membership_id = $3 AND b.blocked_membership_id = p.author_membership_id) OR (b.blocked_membership_id = $3 AND b.blocker_membership_id = p.author_membership_id)))`, [postId, auth.iid, auth.mid]);
      if (!post.rowCount) throw notFound('Post not found');
      await client.query('INSERT INTO post_bookmarks (institution_id, post_id, membership_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [auth.iid, postId, auth.mid]);
    });
    return { ok: true };
  });
  app.delete('/posts/:postId/bookmark', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const { postId } = z.object({ postId: z.string().uuid() }).parse(request.params);
    await tenantTransaction(auth.iid, (client) => client.query('DELETE FROM post_bookmarks WHERE institution_id = $1 AND post_id = $2 AND membership_id = $3', [auth.iid, postId, auth.mid]));
    return { ok: true };
  });

  app.post('/reports', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const body = z.object({ targetType: z.enum(['post','comment','profile','message','study_resource','event','listing']), targetId: z.string().uuid(), reason: z.enum(['spam','harassment','unsafe','copyright','fraud','privacy','other']), details: z.string().trim().max(1000).default('') }).parse(request.body);
    if (body.targetType === 'profile' && body.targetId === auth.mid) throw badRequest('You cannot report your own profile');
    const targetQueries: Record<typeof body.targetType, string> = {
      post: `SELECT p.id FROM posts p WHERE p.id = $1 AND p.institution_id = $2 AND p.deleted_at IS NULL AND p.story_expires_at IS NULL
        AND (p.visibility = 'campus' OR EXISTS (SELECT 1 FROM follows f WHERE f.institution_id = $2 AND f.status = 'accepted' AND ((f.follower_membership_id = $3 AND f.followed_membership_id = p.author_membership_id) OR (f.followed_membership_id = $3 AND f.follower_membership_id = p.author_membership_id))))
        AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.institution_id = $2 AND ((b.blocker_membership_id = $3 AND b.blocked_membership_id = p.author_membership_id) OR (b.blocked_membership_id = $3 AND b.blocker_membership_id = p.author_membership_id)))`,
      comment: `SELECT c.id FROM post_comments c JOIN posts p ON p.id = c.post_id WHERE c.id = $1 AND c.institution_id = $2 AND c.deleted_at IS NULL AND p.deleted_at IS NULL AND p.story_expires_at IS NULL
        AND (p.visibility = 'campus' OR EXISTS (SELECT 1 FROM follows f WHERE f.institution_id = $2 AND f.status = 'accepted' AND ((f.follower_membership_id = $3 AND f.followed_membership_id = p.author_membership_id) OR (f.followed_membership_id = $3 AND f.follower_membership_id = p.author_membership_id))))
        AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.institution_id = $2 AND ((b.blocker_membership_id = $3 AND b.blocked_membership_id = p.author_membership_id) OR (b.blocked_membership_id = $3 AND b.blocker_membership_id = p.author_membership_id)))`,
      profile: `SELECT m.id FROM memberships m WHERE m.id = $1 AND m.institution_id = $2 AND m.status = 'verified' AND m.id <> $3`,
      message: `SELECT msg.id FROM messages msg JOIN conversation_members cm ON cm.conversation_id = msg.conversation_id WHERE msg.id = $1 AND msg.institution_id = $2 AND msg.sender_membership_id <> $3 AND msg.deleted_at IS NULL AND cm.institution_id = $2 AND cm.membership_id = $3 AND cm.left_at IS NULL`,
      study_resource: `SELECT sr.id FROM study_resources sr WHERE sr.id = $1 AND sr.institution_id = $2 AND sr.status IN ('approved','pending_review') AND sr.contributor_membership_id <> $3
        AND (sr.visibility = 'campus' OR EXISTS (SELECT 1 FROM follows f WHERE f.institution_id = $2 AND f.status = 'accepted' AND ((f.follower_membership_id = $3 AND f.followed_membership_id = sr.contributor_membership_id) OR (f.followed_membership_id = $3 AND f.follower_membership_id = sr.contributor_membership_id))))
        AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.institution_id = $2 AND ((b.blocker_membership_id = $3 AND b.blocked_membership_id = sr.contributor_membership_id) OR (b.blocked_membership_id = $3 AND b.blocker_membership_id = sr.contributor_membership_id)))`,
      event: `SELECT e.id FROM campus_events e WHERE e.id = $1 AND e.institution_id = $2 AND e.status = 'published' AND e.creator_membership_id <> $3`,
      listing: `SELECT l.id FROM marketplace_listings l WHERE l.id = $1 AND l.institution_id = $2 AND l.status = 'active' AND l.expires_at > now() AND l.seller_membership_id <> $3
        AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.institution_id = $2 AND ((b.blocker_membership_id = $3 AND b.blocked_membership_id = l.seller_membership_id) OR (b.blocked_membership_id = $3 AND b.blocker_membership_id = l.seller_membership_id)))`
    };
    const result = await tenantTransaction(auth.iid, async (client) => {
      const target = await client.query(targetQueries[body.targetType], [body.targetId, auth.iid, auth.mid]);
      if (!target.rowCount) throw notFound('Report target not found or unavailable');
      const inserted = await client.query(
        `INSERT INTO reports (institution_id, reporter_membership_id, target_type, target_id, reason, details)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id, status, created_at`, [auth.iid, auth.mid, body.targetType, body.targetId, body.reason, body.details]
      );
      if (!inserted.rowCount) throw conflict('You have already reported this item and it is awaiting review');
      return inserted.rows[0];
    });
    return { report: result };
  });
}
