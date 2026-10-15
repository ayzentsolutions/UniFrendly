# Deployment and rollback

## Runtime shape

Deploy two processes from `apps/api`: the stateless API (`node dist/src/server.js`) and one bounded background worker (`node dist/src/worker.js`). Start with one API instance and one worker, a managed PostgreSQL instance, and private S3-compatible object storage. Scale only after observing pool pressure, latency and queue age. The worker should not run as a public API process.

## Environment variables

Use `.env.example` as a template only; never commit real values. Minimum API settings:

- `NODE_ENV=production`, `PORT`, `HOST`
- `DATABASE_URL` (TLS-enabled managed PostgreSQL URL) and `DATABASE_SSL=true` when using a provider certificate trusted by Node
- `JWT_SECRET` (random, at least 32 bytes; rotate deliberately because rotation invalidates current access tokens)
- `ACCESS_TOKEN_TTL_SECONDS`, `REFRESH_TOKEN_TTL_DAYS`, `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW`
- `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `SIGNED_UPLOAD_TTL_SECONDS`, `MEDIA_DELETE_GRACE_HOURS`
- `EXPO_PUSH_ENABLED=true` and optionally `EXPO_ACCESS_TOKEN` after the Expo project and native credentials are configured
- `DB_POOL_MAX`, adjusted for total application instances and the database connection limit

`S3_BUCKET` must be private, block public access, encrypt objects at rest, allow the API role only the required object actions, and have a lifecycle policy that does not bypass UniFrendly's database recovery window. Use a separate bucket or prefix for each environment. Do not use local disk for uploads.

## Fresh database and institution bootstrap

1. Create a dedicated database role with only the required database/schema/table permissions. Migration privileges (`CREATE EXTENSION pgcrypto`, DDL and policy creation) may need a separate migration identity; do not run the runtime API as a superuser.
2. Run `npm install`, `npm run api:build`, and `npm run migrate` in a controlled release step. Commit and use the generated root `package-lock.json` for release builds so dependency versions remain reproducible. The source package was prepared in an environment unable to reach the npm registry, so its first dependency lockfile must be generated and committed from a networked development/CI environment before treating builds as reproducible.
3. Provision the first institution admin through an approved one-time command, not a public API. Supply `PROVISION_INSTITUTION_SLUG`, `PROVISION_INSTITUTION_NAME`, `PROVISION_ADMIN_EMAIL`, `PROVISION_ADMIN_NAME`, and a 16+ character `PROVISION_ADMIN_PASSWORD`; set `CONFIRM_PRODUCTION_PROVISIONING=YES` explicitly for the reviewed production bootstrap, then run `npm --workspace apps/api run provision:institution`. Keep terminal logs restricted because the command prints institution and account metadata. The password is never printed.
4. Remove provisioning environment variables after the process exits. Verify the admin login and then issue short-lived student invitations to a roster-validated list.
5. Configure private media storage and test the upload/download path with a non-sensitive test PDF/photo before inviting students.
6. Configure EAS Build, bundle IDs, APNs/FCM credentials, and `EXPO_PUBLIC_API_URL`. Build a native development client; run internal distribution builds before store signing.

## Rollback

- Keep the previous API and worker image/build artifacts. Roll the API and worker back together when a release changes schema behavior.
- Prefer backward-compatible migrations (additive column/table, deploy compatible code, backfill, switch reads, then remove obsolete columns in a later release). Never remove a column needed by the rollback binary in the same release.
- Before a destructive migration, take a database snapshot and verify it is restorable. If data corruption occurs, stop writes, record the incident window, restore to a separate database, validate row counts/constraints and tenant isolation, then cut over using the provider's documented process.
- Do not automatically roll back a database after a code deploy. Preserve audit logs and record which migration, code SHA and backup were used.

## Native release reproducibility

Use the committed `apps/mobile/eas.json` profiles and pin the generated npm lockfile once dependencies have been installed in a networked environment. Run `npx expo-doctor`, mobile typecheck, and EAS development/preview builds from a CI runner with the required Android/iOS credentials. Store signing keys in EAS/CI secrets, not in this repo. iOS device/simulator build validation requires macOS/Xcode or EAS cloud build; Android SDK/emulator tests require Android tooling or EAS. Do not describe a bundle export as a successful device build.
