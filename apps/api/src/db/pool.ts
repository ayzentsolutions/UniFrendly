import pg, { type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { env } from '../config/env.js';

const { Pool } = pg;
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: true } : undefined,
  max: Number(process.env.DB_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 10_000,
  query_timeout: 12_000,
  application_name: 'unifrendly-api'
});
pool.on('error', (error) => console.error('Unexpected PostgreSQL pool error', error));

export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '10s'");
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function tenantTransaction<T>(institutionId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return transaction(async (client) => {
    await client.query("SELECT set_config('app.institution_id', $1, true)", [institutionId]);
    return fn(client);
  });
}

export async function tenantQuery<T extends QueryResultRow = QueryResultRow>(institutionId: string, sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
  return tenantTransaction(institutionId, (client) => client.query<T>(sql, params));
}
