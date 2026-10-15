# Privacy and retention defaults

This document describes application defaults; each institution must review it against applicable law, student policy and its contractual obligations before launch.

| Data | Default treatment |
| --- | --- |
| Login credentials | Argon2id password hash only; raw password is never stored or logged. |
| Refresh credentials | Only SHA-256 hashes stored; rotation and revocation supported. |
| Posts, comments, profile attributes | Institution-scoped and authorized by backend visibility, connections and blocks. Student deletes are soft deletes initially; cleanup removes posts after the documented recovery window. |
| Messages | Visible only to active conversation members. Message content is not end-to-end encrypted. Account deletion scrubs the deleting member's sent message content and removes attachment references; do not promise immediate erasure of every recipient's copy. |
| Media objects | Kept in private object storage, no local server filesystem; abandoned uploads expire within 24 hours, and unreferenced objects pass a configurable deletion grace period. |
| Student media storage | 50 MiB allocated quota by default; `used_bytes` tracks confirmed object size and `reserved_bytes` prevents concurrent over-allocation. |
| Stories | Expire after 24 hours and are then queued for cleanup. |
| Marketplace listings | Expire after 30 days unless renewed; expired/removed/sold rows are later purged by the worker. |
| In-app notifications | Expire after 90 days by default. Push delivery state is retained until notification cleanup. |
| Audit records | Security and moderation records are retained according to institution policy and applicable obligations. No universal deletion period is assumed here. |
| Identity documents | The first-release design does not require storing student ID images. Use an authoritative roster, institution SSO, or secure institution-issued invitation. |

## Account deletion

The current endpoint requires the account password and an exact confirmation phrase; it revokes the membership and sessions, anonymizes account/profile identifiers, hides the member's posts/comments, removes connection edges and disables push. Related media is scheduled for cleanup after the recovery window, rather than being deleted synchronously from an API request. Institution policy must specify exceptions for safety reports, legal holds, backups and moderation. Deletion should be tested with real storage and DB backups before launch.

## Data export

The export route returns a bounded JSON snapshot (bounded per record type to prevent unbounded responses). A production deployment should assess larger accounts and use an asynchronous export file for datasets that exceed safe response size; downloads must be authenticated and expire quickly.

## Privacy commitments and limitations

- Admins do not get a general endpoint to read private conversations.
- Discovery is opt-in based on profile visibility/discoverability. Blocks are enforced in discovery and message creation/delivery checks.
- The product does not collect or expose exact live location.
- Private message preview preference defaults to disabled; push message body stays generic.
- Transport must use TLS and object downloads use short-lived signed URLs. E2E encryption is not implemented.
