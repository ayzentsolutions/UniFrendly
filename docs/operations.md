# Operations, security and release checklist

## Service boundaries

- API: HTTP JSON under `/v1`; all authenticated routes derive institution and membership IDs from a validated server-side session, not a client-provided tenant ID.
- Worker: claims small `SKIP LOCKED` batches, uses outbox idempotency keys, retries with bounded exponential delays, and moves exhausted outbox work to a terminal failed state. It expires stories/listings/notifications, releases abandoned upload reservations and purges orphan media after the recovery window.
- Database: PostgreSQL indexes support feed, cursor, discovery, conversation and outbox access patterns. Tenant-owned tables use RLS policies based on transaction-local `app.institution_id`; every tenant transaction must set that value before accessing them.
- Media: private object storage with short-lived signed upload/download URLs; MIME is sniffed from object bytes on finalize; object size and user quota are checked server-side.

## Monitoring

At minimum monitor API 4xx/5xx rates, p50/p95/p99 route latency, health/readiness, process CPU/RAM, database connection usage, query timeouts, disk and database growth, storage bytes per institution, reserved-vs-used bytes, failed uploads, oldest pending outbox event age, worker cycle duration, push retries/failures, expired upload count, and report queue age. Alert on elevated 5xx, repeated readiness failures, exhausted outbox events and quota counter inconsistencies.

Do not log access tokens, refresh tokens, passwords, message bodies, signed media URLs, invitation tokens, or identity documents. API logs redact common credential fields. Restrict operational logs, audit records and backups to authorized operators.

## Push notifications

Configure an Expo project and real APNs/FCM credentials, build a development client, and confirm `expo-notifications` permission flow on iOS and Android. Set `EXPO_PUSH_ENABLED=true` only after a test push works. Private message notifications use generic text; they do not include message content by default. Push is best-effort and in-app notifications remain authoritative. Provider receipt inspection and invalid device-token pruning should be added/verified before a high-reliability launch.

## Security launch checklist

- [ ] Dedicated non-superuser runtime database role; TLS and least-privilege storage IAM.
- [ ] All secrets configured via environment or secret manager; no production credentials in git.
- [ ] Institution roster/invitation controls reviewed with each campus. Email or an uploaded card alone is not verification.
- [ ] Test cross-campus reads and writes for every tenant table, discovery route, report route, object key and background event.
- [ ] Test expired/suspended/revoked membership and refresh-token revocation.
- [ ] Test message group membership, message request accept/decline, blocks both directions, and content visibility.
- [ ] Test concurrent quota reservations and verify `used_bytes + reserved_bytes <= quota_bytes` under parallel uploads.
- [ ] Add a malware scanner or quarantine process for uploaded PDFs before broad access; validate actual object content and size.
- [ ] Confirm account export/deletion against applicable privacy and campus policy; preserve only legally required/moderation records.
- [ ] Test backups and restore into a separate environment. Document RPO/RTO.
- [ ] Run load and soak tests with realistic distribution, feed size, messages, database rows and peak simultaneous users.
- [ ] Run Android and iOS builds/tests, accessibility checks, privacy-permission checks and push deep-link checks.

## Limits and fail-safe behavior

Default server-side configuration lives on the institution row and can be changed without publishing a new mobile app: image maximum 1 MiB, four images per post, PDF maximum 10 MiB, 50 MiB media quota per membership, stories 24 hours, marketplace listings 30 days, and in-app notifications 90 days. Change through a reviewed migration/admin process and enforce lower values server-side. No video uploads or payment processing are implemented for the first release.

The API refuses uploads when object storage is unconfigured, and approved study PDFs require a valid PDF signature. Until malware scanning is integrated, a file extension or MIME signature alone must not be considered proof that a PDF is safe.

## Institution and individual media limits

An institution administrator can review/update server-enforced defaults from the native Profile tab (or the authenticated API): `GET /v1/admin/settings` and `PATCH /v1/admin/settings`. Configurable values include image/PDF byte ceilings, images per post (maximum four), the default member quota, story lifetime, listing lifetime, notification retention and temporary-upload lifetime. Each change is audited. New member storage rows take the institution's configured default; existing members retain their individual allocation.

To change an individual member allocation, an institution admin uses `PATCH /v1/admin/memberships/:membershipId/storage-quota` with `{ "quotaBytes": 52428800 }` (50 MiB). The server locks the quota row and refuses to reduce the ceiling below used plus in-flight reserved bytes. This operation is also audited. Limits are expressed in bytes except the TTL settings, which use hours or days as named.
