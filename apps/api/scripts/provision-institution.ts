import 'dotenv/config';
import argon2 from 'argon2';
import { pool, transaction } from '../src/db/pool.js';
import { readConfigNumber } from '../src/utils/institutionConfig.js';

const slug = process.env.PROVISION_INSTITUTION_SLUG?.trim().toLowerCase();
const name = process.env.PROVISION_INSTITUTION_NAME?.trim();
const email = process.env.PROVISION_ADMIN_EMAIL?.trim().toLowerCase();
const displayName = process.env.PROVISION_ADMIN_NAME?.trim();
const password = process.env.PROVISION_ADMIN_PASSWORD;
const productionConfirmed = process.env.CONFIRM_PRODUCTION_PROVISIONING === 'YES';
if (process.env.NODE_ENV === 'production' && !productionConfirmed) throw new Error('Set CONFIRM_PRODUCTION_PROVISIONING=YES only for an intentional, reviewed production bootstrap.');
if (!slug || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug) || !name || !email || !displayName || !password) {
  throw new Error('Set PROVISION_INSTITUTION_SLUG, PROVISION_INSTITUTION_NAME, PROVISION_ADMIN_EMAIL, PROVISION_ADMIN_NAME, and PROVISION_ADMIN_PASSWORD.');
}
if (password.length < 16) throw new Error('Bootstrap admin password must be at least 16 characters.');

try {
  const result = await transaction(async (client) => {
    const existing = await client.query('SELECT id FROM institutions WHERE slug = $1', [slug]);
    if (existing.rowCount) throw new Error(`Institution slug "${slug}" already exists; bootstrap is not an update operation.`);
    const existingUser = await client.query('SELECT id FROM app_users WHERE email = $1', [email]);
    if (existingUser.rowCount) throw new Error('Admin email is already registered; use a reviewed recovery process instead.');
    const institution = await client.query('INSERT INTO institutions (slug,name) VALUES ($1,$2) RETURNING id, slug, name, config', [slug, name]);
    await client.query("SELECT set_config('app.institution_id', $1, true)", [institution.rows[0].id]);
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    const user = await client.query('INSERT INTO app_users (email,display_name,password_hash) VALUES ($1,$2,$3) RETURNING id,email,display_name', [email, displayName, passwordHash]);
    const membership = await client.query("INSERT INTO memberships (institution_id,user_id,role,status,verified_at) VALUES ($1,$2,'institution_admin','verified',now()) RETURNING id, institution_id, role, status", [institution.rows[0].id, user.rows[0].id]);
    await client.query('INSERT INTO profiles (membership_id,institution_id,visibility,discoverable,allow_messages) VALUES ($1,$2,\'private\',false,\'nobody\')', [membership.rows[0].id, institution.rows[0].id]);
    const quotaBytes = readConfigNumber(institution.rows[0].config as Record<string, unknown>, 'studentQuotaBytes', 52_428_800, 0, 1_073_741_824);
    await client.query('INSERT INTO media_usage (membership_id,institution_id,quota_bytes) VALUES ($1,$2,$3)', [membership.rows[0].id, institution.rows[0].id, quotaBytes]);
    return { institution: institution.rows[0], user: user.rows[0], membership: membership.rows[0] };
  });
  console.info(JSON.stringify({ ...result, nextStep: 'Sign in on the native app. Create student invitations from the institution admin workflow and distribute tokens through an authenticated channel.' }, null, 2));
} finally {
  await pool.end();
}
