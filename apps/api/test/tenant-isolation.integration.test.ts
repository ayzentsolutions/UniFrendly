import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import argon2 from 'argon2';
import { buildApp } from '../src/app.js';
import { pool, tenantTransaction, transaction } from '../src/db/pool.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);
describe.skipIf(!enabled)('PostgreSQL tenant isolation integration', () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const password = 'campus-test-password-2026';
  const emailA = `campus-a-${suffix}@example.test`;
  const emailB = `campus-b-${suffix}@example.test`;
  let institutionA = '';
  let institutionB = '';
  let membershipA = '';
  let membershipB = '';
  let postA = '';
  let app: Awaited<ReturnType<typeof buildApp>>;
  let tokenA = '';
  let tokenB = '';

  beforeAll(async () => {
    // CI runs the migration command against a dedicated disposable PostgreSQL service first.
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    const seed = await transaction(async (client) => {
      const a = await client.query('INSERT INTO institutions (slug, name) VALUES ($1,$2) RETURNING id', [`campus-a-${suffix}`, 'Campus A test']);
      const b = await client.query('INSERT INTO institutions (slug, name) VALUES ($1,$2) RETURNING id', [`campus-b-${suffix}`, 'Campus B test']);
      institutionA = a.rows[0].id as string;
      institutionB = b.rows[0].id as string;
      const ua = await client.query('INSERT INTO app_users (email, display_name, password_hash) VALUES ($1,$2,$3) RETURNING id', [emailA, 'Student A', passwordHash]);
      const ub = await client.query('INSERT INTO app_users (email, display_name, password_hash) VALUES ($1,$2,$3) RETURNING id', [emailB, 'Student B', passwordHash]);
      const ma = await client.query("INSERT INTO memberships (institution_id,user_id,role,status,verified_at) VALUES ($1,$2,'student','verified',now()) RETURNING id", [institutionA, ua.rows[0].id]);
      const mb = await client.query("INSERT INTO memberships (institution_id,user_id,role,status,verified_at) VALUES ($1,$2,'student','verified',now()) RETURNING id", [institutionB, ub.rows[0].id]);
      return { userA: ua.rows[0].id as string, userB: ub.rows[0].id as string, membershipA: ma.rows[0].id as string, membershipB: mb.rows[0].id as string };
    });
    membershipA = seed.membershipA;
    membershipB = seed.membershipB;

    for (const [iid, mid] of [[institutionA, membershipA], [institutionB, membershipB]] as const) {
      await tenantTransaction(iid, async (client) => {
        await client.query('INSERT INTO profiles (membership_id,institution_id) VALUES ($1,$2)', [mid, iid]);
        await client.query('INSERT INTO user_settings (membership_id,institution_id) VALUES ($1,$2)', [mid, iid]);
        await client.query('INSERT INTO media_usage (membership_id,institution_id,quota_bytes) VALUES ($1,$2,52428800)', [mid, iid]);
      });
    }
    const createdPost = await tenantTransaction(institutionA, (client) => client.query(
      "INSERT INTO posts (institution_id,author_membership_id,body,visibility) VALUES ($1,$2,'Campus A test post','campus') RETURNING id", [institutionA, membershipA]
    ));
    postA = createdPost.rows[0].id as string;
    app = await buildApp();
    const loginA = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { institutionSlug: `campus-a-${suffix}`, email: emailA, password } });
    const loginB = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { institutionSlug: `campus-b-${suffix}`, email: emailB, password } });
    expect(loginA.statusCode).toBe(200);
    expect(loginB.statusCode).toBe(200);
    tokenA = loginA.json().accessToken as string;
    tokenB = loginB.json().accessToken as string;
  }, 30_000);

  afterAll(async () => {
    if (app!) await app.close();
    const ids = [institutionA, institutionB].filter(Boolean);
    if (ids.length) await pool.query('DELETE FROM institutions WHERE id = ANY($1::uuid[])', [ids]);
  });

  it('does not return another institution’s post even when the caller knows its UUID', async () => {
    const response = await app.inject({ method: 'GET', url: `/v1/posts/${postA}`, headers: { authorization: `Bearer ${tokenB}` } });
    expect(response.statusCode).toBe(404);
  });

  it('does not expose the other institution’s rows under its PostgreSQL RLS context', async () => {
    const result = await tenantTransaction(institutionB, (client) => client.query('SELECT id FROM posts'));
    expect(result.rows.some((row) => row.id === postA)).toBe(false);
  });

  it('rejects cross-campus conversation creation when supplied a foreign membership ID', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/conversations', headers: { authorization: `Bearer ${tokenB}` }, payload: { kind: 'direct', memberIds: [membershipA] } });
    expect(response.statusCode).toBe(404);
  });

  it('allows a member to read their own campus post', async () => {
    const response = await app.inject({ method: 'GET', url: `/v1/posts/${postA}`, headers: { authorization: `Bearer ${tokenA}` } });
    expect(response.statusCode).toBe(200);
  });
});
