import { pool, tenantTransaction } from './db/pool.js';
import { env, uploadsConfigured } from './config/env.js';
import { deleteObject } from './services/storage.js';

type OutboxRow = { id: string; institution_id: string; event_type: string; aggregate_id: string; payload: Record<string, unknown>; attempts: number; dedupe_key: string };
type PushRow = { id: string; institution_id: string; recipient_membership_id: string; category: string; title: string; body: string; resource_type: string | null; resource_id: string | null; push_attempts: number };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function handleOutbox(tenantId: string, event: OutboxRow) {
  await tenantTransaction(tenantId, async (client) => {
    if (event.event_type === 'event.created') {
      await client.query(
        `INSERT INTO notifications (institution_id, recipient_membership_id, actor_membership_id, category, title, body, resource_type, resource_id, dedupe_key)
         SELECT $1, m.id, e.creator_membership_id, 'event', 'New campus event', 'A new campus event was posted', 'event', e.id, $3 || ':' || m.id
           FROM memberships m JOIN user_settings s ON s.membership_id = m.id JOIN campus_events e ON e.id = $2
          WHERE m.institution_id = $1 AND m.status = 'verified' AND m.id <> e.creator_membership_id AND s.notify_events = true
         ON CONFLICT (recipient_membership_id, dedupe_key) DO NOTHING`, [tenantId, event.aggregate_id, event.dedupe_key]
      );
    } else if (event.event_type === 'event.cancelled') {
      await client.query(
        `INSERT INTO notifications (institution_id, recipient_membership_id, actor_membership_id, category, title, body, resource_type, resource_id, dedupe_key)
         SELECT $1, r.membership_id, e.creator_membership_id, 'event', 'Event cancelled', 'An event you registered for has been cancelled', 'event', e.id, $3 || ':' || r.membership_id
           FROM event_registrations r JOIN campus_events e ON e.id = r.event_id JOIN user_settings s ON s.membership_id = r.membership_id
          WHERE r.institution_id = $1 AND r.event_id = $2 AND r.status = 'registered' AND s.notify_events = true
         ON CONFLICT (recipient_membership_id, dedupe_key) DO NOTHING`, [tenantId, event.aggregate_id, event.dedupe_key]
      );
      await client.query("UPDATE event_registrations SET status = 'cancelled', updated_at = now() WHERE institution_id = $1 AND event_id = $2 AND status = 'registered'", [tenantId, event.aggregate_id]);
    } else if (event.event_type === 'study.submitted') {
      await client.query(
        `INSERT INTO notifications (institution_id, recipient_membership_id, actor_membership_id, category, title, body, resource_type, resource_id, dedupe_key)
         SELECT $1, m.id, sr.contributor_membership_id, 'study', 'Study resource needs review', 'A new study resource is awaiting moderation', 'study_resource', sr.id, $3 || ':' || m.id
           FROM memberships m JOIN study_resources sr ON sr.id = $2 JOIN user_settings s ON s.membership_id = m.id
          WHERE m.institution_id = $1 AND m.status = 'verified' AND m.role IN ('institution_admin','moderator') AND s.notify_study = true
         ON CONFLICT (recipient_membership_id, dedupe_key) DO NOTHING`, [tenantId, event.aggregate_id, event.dedupe_key]
      );
    } else if (event.event_type === 'event.registered') {
      await client.query(
        `INSERT INTO notifications (institution_id, recipient_membership_id, actor_membership_id, category, title, body, resource_type, resource_id, dedupe_key)
         SELECT $1, e.creator_membership_id, $3::uuid, 'event', 'New event registration', 'A student registered for your event', 'event', e.id, $4
           FROM campus_events e WHERE e.id = $2 AND e.creator_membership_id <> $3
         ON CONFLICT (recipient_membership_id, dedupe_key) DO NOTHING`, [tenantId, event.aggregate_id, String(event.payload.membershipId ?? ''), event.dedupe_key]
      );
    }
    // Unhandled outbox types are intentionally acknowledged; the table retains the event for audit/debugging.
    await client.query('UPDATE outbox_events SET delivered_at = now(), locked_at = NULL, last_error = NULL WHERE id = $1 AND institution_id = $2', [event.id, tenantId]);
  });
}

async function dispatchOutbox(tenantId: string) {
  const claimed = await tenantTransaction(tenantId, async (client) => {
    const rows = await client.query(
      `SELECT id, institution_id, event_type, aggregate_id, payload, attempts, dedupe_key
         FROM outbox_events WHERE institution_id = $1 AND delivered_at IS NULL AND available_at <= now()
           AND (locked_at IS NULL OR locked_at < now() - interval '5 minutes')
         ORDER BY id LIMIT 15 FOR UPDATE SKIP LOCKED`, [tenantId]
    );
    if (!rows.rowCount) return [] as OutboxRow[];
    const ids = rows.rows.map((row) => String(row.id));
    await client.query('UPDATE outbox_events SET locked_at = now(), attempts = attempts + 1 WHERE id = ANY($1::bigint[])', [ids]);
    return rows.rows as OutboxRow[];
  });
  for (const event of claimed) {
    try {
      await handleOutbox(tenantId, event);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 1000) : 'Unknown worker failure';
      await tenantTransaction(tenantId, (client) => client.query(
        `UPDATE outbox_events SET locked_at = NULL, last_error = $1,
           available_at = now() + (LEAST(3600, power(2, LEAST(attempts, 10))::int) * interval '1 second'),
           delivered_at = CASE WHEN attempts >= 8 THEN now() ELSE delivered_at END
         WHERE id = $2 AND institution_id = $3`, [message, event.id, tenantId]
      ));
    }
  }
}

async function dispatchPush(tenantId: string) {
  const batch = await tenantTransaction(tenantId, async (client) => {
    const rows = await client.query(
      `WITH candidates AS (
        SELECT n.id FROM notifications n WHERE n.institution_id = $1 AND n.push_available_at <= now()
          AND (n.push_status = 'pending' OR (n.push_status = 'processing' AND n.push_available_at < now() - interval '5 minutes'))
        ORDER BY n.created_at LIMIT 20 FOR UPDATE SKIP LOCKED
      )
      UPDATE notifications n SET push_status = 'processing', push_attempts = push_attempts + 1
       FROM candidates c WHERE n.id = c.id RETURNING n.id, n.institution_id, n.recipient_membership_id, n.category, n.title, n.body, n.resource_type, n.resource_id, n.push_attempts`, [tenantId]
    );
    return rows.rows as PushRow[];
  });
  for (const item of batch) {
    try {
      if (!env.EXPO_PUSH_ENABLED) {
        await tenantTransaction(tenantId, (client) => client.query("UPDATE notifications SET push_status = 'skipped' WHERE id = $1 AND institution_id = $2 AND push_status = 'processing'", [item.id, tenantId]));
        continue;
      }
      const deviceResult = await tenantTransaction(tenantId, (client) => client.query(
        `SELECT d.token FROM device_push_tokens d JOIN user_settings s ON s.membership_id = d.membership_id
          WHERE d.institution_id = $1 AND d.membership_id = $2 AND d.active = true AND s.push_enabled = true LIMIT 5`, [tenantId, item.recipient_membership_id]
      ));
      const tokens = deviceResult.rows.map((row) => row.token as string);
      if (!tokens.length) {
        await tenantTransaction(tenantId, (client) => client.query("UPDATE notifications SET push_status = 'skipped' WHERE id = $1 AND institution_id = $2 AND push_status = 'processing'", [item.id, tenantId]));
        continue;
      }
      const route = item.resource_type === 'conversation' && item.resource_id ? `/messages/${item.resource_id}`
        : item.resource_type === 'post' && item.resource_id ? `/posts/${item.resource_id}`
        : item.resource_type === 'event' && item.resource_id ? '/campus/events'
        : item.resource_type === 'study_resource' && item.resource_id ? '/study/resources'
        : item.resource_type === 'listing' && item.resource_id ? '/marketplace'
        : '/notifications';
      const payload = tokens.map((to) => ({ to, title: item.title, body: item.body, sound: 'default', data: { route, url: route, notificationId: item.id }, priority: 'default' }));
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json', accept: 'application/json', ...(env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${env.EXPO_ACCESS_TOKEN}` } : {}) },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(8_000)
      });
      if (!response.ok) throw new Error(`Expo push returned HTTP ${response.status}`);
      const ticketData = await response.json() as { data?: Array<{ status?: string; message?: string; details?: { error?: string } }> | { status?: string } };
      const tickets = Array.isArray(ticketData.data) ? ticketData.data : [];
      const failed = tickets.some((ticket) => ticket.status === 'error');
      if (failed) throw new Error(tickets.filter((ticket) => ticket.status === 'error').map((ticket) => ticket.details?.error ?? ticket.message ?? 'Expo push error').join(', '));
      await tenantTransaction(tenantId, (client) => client.query("UPDATE notifications SET push_status = 'sent', push_sent_at = now(), push_last_error = NULL WHERE id = $1 AND institution_id = $2 AND push_status = 'processing'", [item.id, tenantId]));
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 1000) : 'Push delivery error';
      const exhausted = item.push_attempts >= 5;
      await tenantTransaction(tenantId, (client) => client.query(
        `UPDATE notifications SET push_status = $1, push_last_error = $2,
           push_available_at = now() + (LEAST(1800, power(2, LEAST(push_attempts, 10))::int) * interval '1 second')
         WHERE id = $3 AND institution_id = $4 AND push_status = 'processing'`, [exhausted ? 'failed' : 'pending', message, item.id, tenantId]
      ));
    }
  }
}

async function cleanTenant(tenantId: string) {
  const expiredUploads = uploadsConfigured ? await tenantTransaction(tenantId, (client) => client.query(
    `SELECT id, object_key FROM media_uploads WHERE institution_id = $1 AND status = 'pending' AND expires_at <= now() ORDER BY expires_at LIMIT 20`, [tenantId]
  )) : { rows: [] as Array<{ id: string; object_key: string }> };
  for (const upload of expiredUploads.rows) {
    try {
      if (uploadsConfigured) await deleteObject(upload.object_key);
      await tenantTransaction(tenantId, async (client) => {
        const changed = await client.query("UPDATE media_uploads SET status = 'expired' WHERE id = $1 AND institution_id = $2 AND status = 'pending' RETURNING membership_id, expected_bytes", [upload.id, tenantId]);
        if (changed.rows[0]) await client.query('UPDATE media_usage SET reserved_bytes = GREATEST(0, reserved_bytes - $1), updated_at = now() WHERE membership_id = $2', [changed.rows[0].expected_bytes, changed.rows[0].membership_id]);
      });
    } catch (error) {
      console.error('Unable to clean expired upload', { uploadId: upload.id, error: error instanceof Error ? error.message : 'unknown' });
    }
  }

  const deletionCandidates = uploadsConfigured ? await tenantTransaction(tenantId, (client) => client.query(
    `SELECT id, object_key FROM media_assets ma WHERE ma.institution_id = $1 AND ma.status = 'pending_delete' AND ma.delete_after <= now() LIMIT 20`, [tenantId]
  )) : { rows: [] as Array<{ id: string; object_key: string }> };
  for (const candidate of deletionCandidates.rows) {
    try {
      if (uploadsConfigured) await deleteObject(candidate.object_key);
      await tenantTransaction(tenantId, async (client) => {
        const deleted = await client.query("UPDATE media_assets SET status = 'deleted' WHERE id = $1 AND institution_id = $2 AND status = 'pending_delete' RETURNING membership_id, byte_size", [candidate.id, tenantId]);
        if (deleted.rows[0]) await client.query('UPDATE media_usage SET used_bytes = GREATEST(0, used_bytes - $1), updated_at = now() WHERE membership_id = $2', [deleted.rows[0].byte_size, deleted.rows[0].membership_id]);
      });
    } catch (error) {
      console.error('Unable to purge deleted media', { mediaId: candidate.id, error: error instanceof Error ? error.message : 'unknown' });
    }
  }

  await tenantTransaction(tenantId, async (client) => {
    await client.query("UPDATE posts SET deleted_at = COALESCE(deleted_at, now()) WHERE institution_id = $1 AND story_expires_at <= now() AND deleted_at IS NULL", [tenantId]);
    await client.query("DELETE FROM posts WHERE institution_id = $1 AND deleted_at < now() - interval '24 hours'", [tenantId]);
    await client.query("UPDATE marketplace_listings SET status = 'expired', updated_at = now() WHERE institution_id = $1 AND status = 'active' AND expires_at <= now()", [tenantId]);
    await client.query("DELETE FROM marketplace_listings WHERE institution_id = $1 AND status IN ('expired','removed','sold') AND updated_at < now() - interval '30 days'", [tenantId]);
    await client.query("DELETE FROM study_resources WHERE institution_id = $1 AND status IN ('removed','rejected') AND updated_at < now() - interval '30 days'", [tenantId]);
    await client.query('DELETE FROM notifications WHERE institution_id = $1 AND expires_at <= now()', [tenantId]);
    await client.query(
      `UPDATE media_assets ma SET status = 'pending_delete', delete_after = now() + ($2::int * interval '1 hour')
        WHERE ma.institution_id = $1 AND ma.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM post_media pm WHERE pm.media_id = ma.id)
          AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.avatar_media_id = ma.id)
          AND NOT EXISTS (SELECT 1 FROM messages msg WHERE msg.attachment_media_id = ma.id)
          AND NOT EXISTS (SELECT 1 FROM study_resources sr WHERE sr.media_id = ma.id)
          AND NOT EXISTS (SELECT 1 FROM marketplace_listings ml WHERE ml.media_id = ma.id)
          AND ma.created_at < now() - interval '24 hours'`, [tenantId, env.MEDIA_DELETE_GRACE_HOURS]
    );
  });
}

async function runOnce() {
  const institutions = await pool.query("SELECT id FROM institutions WHERE status = 'active' ORDER BY id LIMIT 200");
  for (const row of institutions.rows) {
    const id = row.id as string;
    try {
      await dispatchOutbox(id);
      await dispatchPush(id);
      await cleanTenant(id);
    } catch (error) {
      console.error('Tenant worker cycle failed', { institutionId: id, error: error instanceof Error ? error.message : 'unknown' });
    }
  }
}

let stopping = false;
process.once('SIGTERM', () => { stopping = true; });
process.once('SIGINT', () => { stopping = true; });
console.info('UniFrendly worker started');
while (!stopping) {
  try { await runOnce(); } catch (error) { console.error('Worker cycle failed', error); }
  if (!stopping) await sleep(5_000);
}
await pool.end();
console.info('UniFrendly worker stopped');
