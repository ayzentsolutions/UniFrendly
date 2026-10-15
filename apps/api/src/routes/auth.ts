import type { FastifyInstance } from 'fastify';
import argon2 from 'argon2';
import { z } from 'zod';
import { pool, tenantTransaction, transaction } from '../db/pool.js';
import { signAccessToken } from '../services/tokens.js';
import { hashToken, newOpaqueToken } from '../utils/crypto.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../utils/errors.js';
import { currentAuth, requireAuth } from '../plugins/auth.js';
import { env } from '../config/env.js';
import { readConfigNumber } from '../utils/institutionConfig.js';

const loginSchema = z.object({ institutionSlug: z.string().trim().toLowerCase().min(2).max(63), email: z.string().trim().email().max(254), password: z.string().min(1).max(256) });
const inviteSchema = z.object({ institutionSlug: z.string().trim().toLowerCase().min(2).max(63), email: z.string().trim().email().max(254), invitationToken: z.string().min(24).max(200), displayName: z.string().trim().min(1).max(80), password: z.string().min(12).max(128), department: z.string().trim().max(120).optional(), programme: z.string().trim().max(120).optional(), batchYear: z.number().int().min(1950).max(2150).optional() });
const refreshSchema = z.object({ refreshToken: z.string().min(32).max(200) });
const settingsSchema = z.object({ pushEnabled: z.boolean().optional(), notifyMessages: z.boolean().optional(), notifyConnections: z.boolean().optional(), notifyEvents: z.boolean().optional(), notifyStudy: z.boolean().optional(), notifyMarketplace: z.boolean().optional(), privateMessagePreviews: z.boolean().optional() }).strict();

async function issueSession(userId: string, membershipId: string, institutionId: string, role: string, requestUa?: string | string[]) {
  const refresh = newOpaqueToken();
  const result = await pool.query(
    `INSERT INTO auth_sessions (user_id, membership_id, refresh_hash, expires_at, user_agent)
     VALUES ($1, $2, $3, now() + ($4::int * interval '1 day'), $5) RETURNING id, expires_at`,
    [userId, membershipId, hashToken(refresh), env.REFRESH_TOKEN_TTL_DAYS, Array.isArray(requestUa) ? requestUa[0] : requestUa ?? null]
  );
  const session = result.rows[0];
  const accessToken = await signAccessToken({ sub: userId, mid: membershipId, iid: institutionId, role, sid: session.id });
  return { accessToken, refreshToken: refresh, tokenType: 'Bearer', expiresIn: env.ACCESS_TOKEN_TTL_SECONDS, refreshExpiresAt: session.expires_at };
}

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/invitations/accept', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request) => {
    const body = inviteSchema.parse(request.body);
    const email = body.email.toLowerCase();
    const invitationHash = hashToken(body.invitationToken);
    const outcome = await transaction(async (client) => {
      const inv = await client.query(
        `SELECT v.*, i.status AS institution_status, i.config AS institution_config FROM institution_invitations v
         JOIN institutions i ON i.id = v.institution_id
         WHERE i.slug = $1 AND lower(v.email) = $2 AND v.token_hash = $3
           AND v.used_at IS NULL AND v.expires_at > now() FOR UPDATE OF v`,
        [body.institutionSlug, email, invitationHash]
      );
      const invitation = inv.rows[0];
      if (!invitation || invitation.institution_status !== 'active') throw badRequest('Invitation is invalid or expired', 'INVITATION_INVALID');
      const existing = await client.query('SELECT id FROM app_users WHERE email = $1', [email]);
      if (existing.rowCount) throw conflict('An account already exists for this email. Sign in first or use account recovery.');
      await client.query("SELECT set_config('app.institution_id', $1, true)", [invitation.institution_id]);
      const passwordHash = await argon2.hash(body.password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
      const user = await client.query(
        `INSERT INTO app_users (email, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id`,
        [email, body.displayName, passwordHash]
      );
      const membership = await client.query(
        `INSERT INTO memberships (institution_id, user_id, role, status, student_ref_hash, verified_at)
         VALUES ($1, $2, $3, 'verified', $4, now()) RETURNING id, institution_id, role`,
        [invitation.institution_id, user.rows[0].id, invitation.role, invitation.roster_ref ?? null]
      );
      await client.query(
        `INSERT INTO profiles (membership_id, institution_id, department, programme, batch_year)
         VALUES ($1, $2, $3, $4, $5)`,
        [membership.rows[0].id, membership.rows[0].institution_id, body.department ?? null, body.programme ?? null, body.batchYear ?? null]
      );
      await client.query('INSERT INTO user_settings (membership_id, institution_id) VALUES ($1, $2)', [membership.rows[0].id, membership.rows[0].institution_id]);
      const institutionConfig = invitation.institution_config as Record<string, unknown>;
      const quotaBytes = readConfigNumber(institutionConfig, 'studentQuotaBytes', 52_428_800, 0, 1_073_741_824);
      await client.query('INSERT INTO media_usage (membership_id, institution_id, quota_bytes) VALUES ($1, $2, $3)', [membership.rows[0].id, membership.rows[0].institution_id, quotaBytes]);
      await client.query('UPDATE institution_invitations SET used_at = now() WHERE id = $1', [invitation.id]);
      return { userId: user.rows[0].id, membershipId: membership.rows[0].id, institutionId: membership.rows[0].institution_id, role: membership.rows[0].role };
    });
    const session = await issueSession(outcome.userId, outcome.membershipId, outcome.institutionId, outcome.role, request.headers['user-agent']);
    return { ...session, user: { id: outcome.userId, email, displayName: body.displayName }, membership: { id: outcome.membershipId, institutionId: outcome.institutionId, role: outcome.role, status: 'verified' } };
  });

  app.post('/auth/login', { config: { rateLimit: { max: 8, timeWindow: '15 minutes' } } }, async (request) => {
    const body = loginSchema.parse(request.body);
    const email = body.email.toLowerCase();
    const found = await pool.query(
      `SELECT u.id AS user_id, u.email, u.display_name, u.password_hash, u.account_status,
              m.id AS membership_id, m.institution_id, m.role, m.status AS membership_status,
              (m.expires_at IS NULL OR m.expires_at > now()) AS membership_current, i.status AS institution_status
         FROM app_users u JOIN memberships m ON m.user_id = u.id
         JOIN institutions i ON i.id = m.institution_id
        WHERE u.email = $1 AND i.slug = $2`, [email, body.institutionSlug]
    );
    const row = found.rows[0];
    if (!row?.password_hash || !(await argon2.verify(row.password_hash, body.password))) throw unauthorized('Email or password is incorrect');
    if (row.membership_status === 'verified' && !row.membership_current) {
      await pool.query("UPDATE memberships SET status = 'expired', updated_at = now() WHERE id = $1 AND status = 'verified' AND expires_at <= now()", [row.membership_id]);
    }
    if (row.account_status !== 'active' || row.membership_status !== 'verified' || !row.membership_current || row.institution_status !== 'active') throw forbidden('Your campus membership is not currently active');
    const session = await issueSession(row.user_id, row.membership_id, row.institution_id, row.role, request.headers['user-agent']);
    return { ...session, user: { id: row.user_id, email: row.email, displayName: row.display_name }, membership: { id: row.membership_id, institutionId: row.institution_id, role: row.role, status: row.membership_status } };
  });

  app.post('/auth/refresh', { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (request) => {
    const body = refreshSchema.parse(request.body);
    const oldHash = hashToken(body.refreshToken);
    const nextRefresh = newOpaqueToken();
    const session = await transaction(async (client) => {
      const rowResult = await client.query(
        `SELECT s.id AS session_id, s.user_id, s.membership_id, s.expires_at,
                m.institution_id, m.role, m.status AS membership_status, (m.expires_at IS NULL OR m.expires_at > now()) AS membership_current, u.account_status, i.status AS institution_status
           FROM auth_sessions s JOIN memberships m ON m.id = s.membership_id
           JOIN app_users u ON u.id = s.user_id JOIN institutions i ON i.id = m.institution_id
          WHERE s.refresh_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
          FOR UPDATE OF s`, [oldHash]
      );
      const row = rowResult.rows[0];
      if (!row) throw unauthorized('Refresh token is invalid or expired');
      if (row.membership_status !== 'verified' || !row.membership_current || row.account_status !== 'active' || row.institution_status !== 'active') {
        // Expiry is enforced server-side; persist its state and revoke before rejecting refresh.
        if (row.membership_status === 'verified' && !row.membership_current) {
          await client.query("UPDATE memberships SET status = 'expired', updated_at = now() WHERE id = $1 AND status = 'verified' AND expires_at <= now()", [row.membership_id]);
        }
        // Return a sentinel so the revocation transaction commits before rejecting the refresh.
        await client.query('UPDATE auth_sessions SET revoked_at = now() WHERE id = $1', [row.session_id]);
        return { revoked: true as const };
      }
      await client.query('UPDATE auth_sessions SET refresh_hash = $1, last_used_at = now() WHERE id = $2', [hashToken(nextRefresh), row.session_id]);
      return { revoked: false as const, ...row, sessionId: row.session_id, refreshExpiresAt: row.expires_at };
    });
    if (session.revoked) throw forbidden('Campus membership is no longer active');
    const accessToken = await signAccessToken({ sub: session.user_id, mid: session.membership_id, iid: session.institution_id, role: session.role, sid: session.sessionId });
    return { accessToken, refreshToken: nextRefresh, tokenType: 'Bearer', expiresIn: env.ACCESS_TOKEN_TTL_SECONDS, refreshExpiresAt: session.refreshExpiresAt };
  });

  app.post('/auth/logout', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    await pool.query('UPDATE auth_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [auth.sid]);
    return { ok: true };
  });
  app.post('/auth/logout-all', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    await pool.query('UPDATE auth_sessions SET revoked_at = now() WHERE membership_id = $1 AND revoked_at IS NULL', [auth.mid]);
    return { ok: true };
  });
  app.get('/me', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const result = await tenantTransaction(auth.iid, (client) => client.query(
      `SELECT m.id AS membership_id, m.role, m.status, i.id AS institution_id, i.slug AS institution_slug, i.name AS institution_name,
              p.department, p.programme, p.batch_year, p.bio, p.interests, p.visibility, p.discoverable, p.allow_messages,
              s.push_enabled, s.notify_messages, s.notify_connections, s.notify_events, s.notify_study, s.notify_marketplace, s.private_message_previews,
              u.email, u.display_name
         FROM memberships m JOIN institutions i ON i.id = m.institution_id JOIN app_users u ON u.id = m.user_id
         LEFT JOIN profiles p ON p.membership_id = m.id LEFT JOIN user_settings s ON s.membership_id = m.id
        WHERE m.id = $1 AND m.institution_id = $2 AND m.status = 'verified'`, [auth.mid, auth.iid]));
    if (!result.rows[0]) throw notFound('Membership not found');
    return { user: { id: auth.sub, email: auth.email, displayName: auth.displayName }, membership: result.rows[0] };
  });
  app.patch('/me/settings', { preHandler: requireAuth }, async (request) => {
    const auth = currentAuth(request);
    const body = settingsSchema.parse(request.body);
    const keys = Object.keys(body) as Array<keyof typeof body>;
    if (!keys.length) throw badRequest('Provide at least one setting to update');
    const columnMap: Record<keyof typeof body, string> = {
      pushEnabled: 'push_enabled', notifyMessages: 'notify_messages', notifyConnections: 'notify_connections', notifyEvents: 'notify_events', notifyStudy: 'notify_study', notifyMarketplace: 'notify_marketplace', privateMessagePreviews: 'private_message_previews'
    };
    await transaction(async (client) => {
      await client.query("SELECT set_config('app.institution_id', $1, true)", [auth.iid]);
      const values: unknown[] = [auth.mid];
      const assignments = keys.map((key) => { values.push(body[key]); return `${columnMap[key]} = $${values.length}`; });
      await client.query(`UPDATE user_settings SET ${assignments.join(', ')}, updated_at = now() WHERE membership_id = $1`, values);
    });
    return { ok: true };
  });
}
