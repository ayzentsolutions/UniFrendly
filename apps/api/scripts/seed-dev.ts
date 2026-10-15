import 'dotenv/config';
import argon2 from 'argon2';
import { pool, transaction } from '../src/db/pool.js';
import { readConfigNumber } from '../src/utils/institutionConfig.js';
if (process.env.NODE_ENV === 'production') throw new Error('Development seed is disabled in production.');
const slug = process.env.DEV_INSTITUTION_SLUG ?? 'northstar-college';
const email = (process.env.DEV_ADMIN_EMAIL ?? 'admin@northstar.example').toLowerCase();
const password = process.env.DEV_ADMIN_PASSWORD;
if (!password || password.length < 16) throw new Error('Set DEV_ADMIN_PASSWORD to a development-only password of at least 16 characters.');
try {
  const details = await transaction(async (client) => {
    const institution = await client.query(`INSERT INTO institutions (slug,name) VALUES ($1,$2) ON CONFLICT(slug) DO UPDATE SET name=EXCLUDED.name RETURNING id,slug,name,config`, [slug, 'Northstar College (Development Only)']);
    await client.query("SELECT set_config('app.institution_id', $1, true)", [institution.rows[0].id]);
    const hashed = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    const user = await client.query(`INSERT INTO app_users(email,display_name,password_hash) VALUES($1,$2,$3) ON CONFLICT(email) DO UPDATE SET display_name=EXCLUDED.display_name,password_hash=EXCLUDED.password_hash,account_status='active' RETURNING id,email,display_name`, [email, 'Development Admin', hashed]);
    const member = await client.query(`INSERT INTO memberships(institution_id,user_id,role,status,verified_at) VALUES($1,$2,'institution_admin','verified',now()) ON CONFLICT(institution_id,user_id) DO UPDATE SET role='institution_admin',status='verified',verified_at=now() RETURNING id,institution_id,role,status`, [institution.rows[0].id,user.rows[0].id]);
    await client.query("INSERT INTO profiles(membership_id,institution_id,visibility,discoverable,allow_messages) VALUES($1,$2,'private',false,'nobody') ON CONFLICT(membership_id) DO NOTHING", [member.rows[0].id,institution.rows[0].id]);
    const quotaBytes = readConfigNumber(institution.rows[0].config as Record<string, unknown>, 'studentQuotaBytes', 52_428_800, 0, 1_073_741_824);
    await client.query('INSERT INTO media_usage(membership_id,institution_id,quota_bytes) VALUES($1,$2,$3) ON CONFLICT(membership_id) DO NOTHING', [member.rows[0].id,institution.rows[0].id,quotaBytes]);
    return { institution: institution.rows[0], admin: user.rows[0], membership: member.rows[0] };
  });
  console.info(JSON.stringify(details,null,2));
} finally { await pool.end(); }
