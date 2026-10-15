import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { pool } from '../db/pool.js';
import { verifyAccessToken, type AccessClaims } from '../services/tokens.js';
import { forbidden, unauthorized } from '../utils/errors.js';

declare module 'fastify' {
  interface FastifyRequest { auth: (AccessClaims & { displayName: string; email: string }) | null }
}
export async function authenticate(request: FastifyRequest, _reply: FastifyReply) {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized();
  const claims = await verifyAccessToken(header.slice(7));
  const result = await pool.query(
    `SELECT u.id AS user_id, u.email, u.display_name, u.account_status,
            m.id AS membership_id, m.institution_id, m.role, m.status AS membership_status,
            (m.expires_at IS NULL OR m.expires_at > now()) AS membership_current, i.status AS institution_status, s.revoked_at, s.expires_at
       FROM auth_sessions s
       JOIN app_users u ON u.id = s.user_id
       JOIN memberships m ON m.id = s.membership_id
       JOIN institutions i ON i.id = m.institution_id
      WHERE s.id = $1 AND s.user_id = $2 AND s.membership_id = $3`,
    [claims.sid, claims.sub, claims.mid]
  );
  const row = result.rows[0];
  if (!row || row.revoked_at || new Date(row.expires_at).getTime() <= Date.now()) throw unauthorized('Session revoked or expired');
  if (row.account_status !== 'active' || row.membership_status !== 'verified' || !row.membership_current || row.institution_status !== 'active') {
    if (row.membership_status === 'verified' && !row.membership_current) {
      await pool.query("UPDATE memberships SET status = 'expired', updated_at = now() WHERE id = $1 AND status = 'verified' AND expires_at <= now()", [row.membership_id]);
    }
    await pool.query('UPDATE auth_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [claims.sid]);
    throw forbidden('Your institution membership is no longer active');
  }
  request.auth = { ...claims, displayName: row.display_name, email: row.email, iid: row.institution_id, mid: row.membership_id, role: row.role };
  await pool.query('UPDATE auth_sessions SET last_used_at = now() WHERE id = $1', [claims.sid]);
}
export const requireAuth: preHandlerHookHandler = async (request, reply) => {
  await authenticate(request, reply);
};
export const requireRole = (...roles: string[]): preHandlerHookHandler => async (request) => {
  if (!request.auth) throw unauthorized();
  if (!roles.includes(request.auth.role)) throw forbidden();
};
export function currentAuth(request: FastifyRequest) {
  if (!request.auth) throw unauthorized();
  return request.auth;
}
