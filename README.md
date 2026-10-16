# UniFrendly

UniFrendly is a native iOS/Android social app for private, institution-verified student communities. It is a separate product and repository; it does not alter or depend on ACADLYX production code.

## Repository structure

- `apps/mobile` — React Native + Expo Router + TypeScript native client.
- `apps/api` — Fastify/TypeScript modular-monolith API, PostgreSQL schema/migrations, authentication, policy checks, signed private-media upload, moderation, and a separate bounded worker.
- `apps/api/migrations` — versioned database schema; applied by the migration command.
- `apps/api/scripts/provision-institution.ts` — intentionally manual one-time institution/admin provisioning.
- `docs/` — deployment, operational, retention, recovery, and feature notes.
- `.github/workflows/ci.yml` — automated static checks and test execution.

## Current implemented app areas

- Five native main tabs: Home, Discover, Study, Campus, Profile.
- Student text/image posts, comments, reactions, bookmarks, sharing, reports, and 24-hour stories.
- Opt-in discoverability, connection workflows, profile visibility, blocks, and contact preferences.
- Direct/group text conversations, attachment support, idempotent send identifiers, conversation membership enforcement, and explicit direct-message request accept/decline flow.
- Institution-controlled enrollment invitations, Argon2id password hashing, signed short-lived access tokens, rotating refresh tokens, hashed refresh token storage, session revocation, and membership status revalidation.
- Approved PDF study materials, event registration/capacity controls, native calendar handoff, campus marketplace/canteen/lost-and-found listings, in-app notifications, native push registration, data export, account deletion, and moderation queues.
- PostgreSQL row-level security for institution-scoped data, server-side tenant selection derived from the authenticated membership, configurable media quota reservations, private object storage, signed uploads/downloads, outbox processing, and scheduled expiry cleanup.

## What is still required before production launch

External infrastructure must be provisioned and supplied: a PostgreSQL database, a private S3-compatible bucket, TLS/API hosting, Expo/EAS project and APNs/FCM credentials, institutional roster or SSO approval, and a tested backup destination. Malware scanning is not enabled by default; until an institution integrates a scanning service, uploaded PDFs remain pending moderation and the deployment should add a scanner before allowing wider downloads. Self-service password recovery/email delivery is not implemented yet and must be added before public launch. Device builds, hardware permission flows, push delivery, load tests, and cross-tenant integration tests must be run in a configured environment. No production deployment or device test is claimed by this source package.

## Local development

Requirements: Node.js 22 LTS, npm, and PostgreSQL 15+. Run `npm install` on a networked machine first; commit the generated root `package-lock.json` before a release to lock transitive dependency versions.

1. Copy `.env.example` to `.env` at the repository root or export its values in your shell (the dev commands load the root `.env`). Use a unique random `JWT_SECRET` of at least 32 bytes. Set `DATABASE_URL` to a dedicated database.
2. Install dependencies with `npm install`. Apply migrations using the dedicated `unifrendly_migrator` database URL (set it as `DATABASE_URL` only for `npm run migrate`). Do not run migrations as the restricted runtime role. After migrations, set `DATABASE_URL` to the `unifrendly_app` connection string before starting the API or worker. Keep these credentials separate in your secret manager.
3. Set `DEV_ADMIN_PASSWORD` to a development-only password of 16+ characters and run `npm --workspace apps/api run seed:dev` with `NODE_ENV=development`. This seeds only `northstar-college` and `admin@northstar.example`; never run development seeds in production.
4. Run `npm run api:dev` in one terminal and `npm --workspace apps/api run worker` in another.
5. Set `EXPO_PUBLIC_API_URL=http://YOUR-LAN-IP:8080/v1` in the mobile app environment. On a physical device, `localhost` points to the phone, not your computer.
6. Run `npm --workspace apps/mobile run start` for a development build. Expo Go can be used for some UI iteration, but push notifications and calendar/native permissions require a development build and platform credentials.

See [deployment](docs/deployment.md), [operations and security](docs/operations.md), [privacy/retention](docs/privacy-retention.md), and [Supabase setup](docs/supabase-setup.md).
