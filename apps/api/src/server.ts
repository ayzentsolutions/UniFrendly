import { buildApp } from './app.js';
import { env } from './config/env.js';
import { pool } from './db/pool.js';

const app = await buildApp();
try {
  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info({ port: env.PORT, host: env.HOST }, 'UniFrendly API listening');
} catch (error) {
  app.log.error(error, 'Unable to start API');
  process.exitCode = 1;
  await pool.end();
}
const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'Shutting down gracefully');
  await app.close();
  await pool.end();
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
