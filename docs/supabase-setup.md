# Connect UniFrendly to Supabase

Use a **separate Supabase project for UniFrendly**. Do not point this app at the ACADLYX production database or reuse its credentials.

## 1. Create the project

Create a Supabase project, set a strong database password, and keep it private. Open **SQL Editor** in that project. Run the role setup below as the project database administrator. Replace both password placeholders with different, strong, unique passwords before executing. Do not commit either password or place database connection strings in the mobile app.

## 2. Prepare dedicated database roles

The API refuses to start if its runtime database role is a superuser or has `BYPASSRLS`. It must also not own application tables. Use one role for migrations and a separate, restricted role at runtime.

Run this once in the Supabase SQL Editor:

```sql
-- Supabase projects generally already have pgcrypto available. Ensure it exists
-- before running the application migration under the restricted migrator.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE ROLE unifrendly_migrator
  LOGIN PASSWORD 'REPLACE_WITH_A_UNIQUE_MIGRATOR_PASSWORD'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

CREATE ROLE unifrendly_app
  LOGIN PASSWORD 'REPLACE_WITH_A_DIFFERENT_UNIQUE_APP_PASSWORD'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

GRANT CONNECT ON DATABASE postgres TO unifrendly_migrator, unifrendly_app;
GRANT USAGE, CREATE ON SCHEMA public TO unifrendly_migrator;
GRANT USAGE ON SCHEMA public TO unifrendly_app;

-- These defaults let the runtime role use tables and sequences created by
-- the migrator in future migrations, without making the runtime role an owner.
ALTER DEFAULT PRIVILEGES FOR ROLE unifrendly_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO unifrendly_app;
ALTER DEFAULT PRIVILEGES FOR ROLE unifrendly_migrator IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO unifrendly_app;
```

Keep both credentials private. The SQL editor may retain query history; remove or edit the saved query after setup if it contains passwords. Never grant `unifrendly_app` membership in `postgres` or `service_role`, and never use the Supabase `service_role` key as the API's database password.

If the extension statement reports that pgcrypto cannot be installed, install/enable it through the Supabase dashboard as the project database administrator, then continue. Do not give the runtime role superuser or `BYPASSRLS` rights to work around an error.

## 3. Get the connection string

In the Supabase dashboard, open **Connect** and select **Session pooler**. Copy its host and port exactly. Session mode is suitable for a long-lived Node API and is IPv4-friendly; migrations can also use it. Where direct database connectivity is available, Supabase recommends the direct connection for migrations.

For the shared session pooler, the username format is `ROLE.PROJECT_REF`. Change only the role prefix from the copied default to `unifrendly_migrator` for migrations or `unifrendly_app` for application runtime. Use the matching role password. Do not guess the pooler host or project reference. Percent-encode special characters in passwords before placing them in a URL.

## 4. Configure the API environment

In the repository root and the `apps/api` workspace, keep a local `.env` file (both are ignored by Git). In `apps/api/.env`, set the runtime application role:

```dotenv
NODE_ENV=development
PORT=8080
HOST=0.0.0.0
DATABASE_URL=postgresql://unifrendly_app.PROJECT_REF:URL_ENCODED_APP_PASSWORD@YOUR_SESSION_POOLER_HOST:5432/postgres?sslmode=require
DATABASE_SSL=true
JWT_SECRET=REPLACE_WITH_AT_LEAST_32_RANDOM_CHARACTERS
```

Replace `PROJECT_REF`, `URL_ENCODED_APP_PASSWORD`, and `YOUR_SESSION_POOLER_HOST` with the values from your project. Keep all other existing environment settings from `.env.example` as needed. Never put `DATABASE_URL` in `apps/mobile`, Expo public environment variables, source control, or screenshots.

## 5. Run the migration

From the repository root, temporarily supply the migrator connection for the migration command (the rest of `apps/api/.env` remains loaded):

```bash
DATABASE_URL='postgresql://unifrendly_migrator.PROJECT_REF:URL_ENCODED_MIGRATOR_PASSWORD@YOUR_SESSION_POOLER_HOST:5432/postgres?sslmode=require' npm run migrate
```

Replace the placeholders with your real values. This creates the UniFrendly tables and tenant row-level security policies. The runtime process should continue using the `unifrendly_app` connection from `apps/api/.env`.

If the migration fails, stop and read the first PostgreSQL error before retrying. Do not drop tables or reset a populated project to fix a permissions error.

## 6. Seed a development admin and start

Set a development-only password of at least 16 characters:

```bash
NODE_ENV=development DEV_ADMIN_PASSWORD='ReplaceWithYourOwnLongDevelopmentPassword123' npm run seed:dev
npm run api:dev
```

Run the worker in another terminal from the repository root:

```bash
npm run worker
```

Check `http://localhost:8080/health/ready`. Then run the mobile UI separately:

```bash
cd apps/mobile
EXPO_PUBLIC_API_URL=http://localhost:8080/v1 npm run start:go
```

Use `northstar-college` and `admin@northstar.example` for the local development account, with the development password you chose. On a physical phone, use your Mac's LAN IP in `EXPO_PUBLIC_API_URL`; `localhost` on the phone means the phone itself.

## Troubleshooting

- **Password authentication failed:** verify the role password, pooler username format, host and URL-encoding.
- **Permission denied:** migrations must use `unifrendly_migrator`; API and worker must use `unifrendly_app`. Verify schema grants and default privileges.
- **Runtime refuses the DB role:** the runtime URL is likely still using `postgres`, `service_role`, or another role with superuser/`BYPASSRLS` status. Use `unifrendly_app`.
- **Direct host cannot resolve/connect from the Mac:** use the session pooler shown by Supabase Connect, not a guessed hostname.
- **Uploads do not work:** Supabase Postgres does not configure the app's S3-compatible private media storage. Configure a private S3-compatible bucket separately; do not make private student media public to get uploads working.

See the [official Supabase connection guide](https://supabase.com/docs/guides/database/connecting-to-postgres) for connection modes and SSL details.
