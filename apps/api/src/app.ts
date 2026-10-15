import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { env } from './config/env.js';
import { pool } from './db/pool.js';
import { registerRoutes } from './routes/index.js';
import { AppError } from './utils/errors.js';

export async function buildApp(): Promise<FastifyInstance> {
  const databaseRole = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
  );
  const runtimeRole = databaseRole.rows[0];
  if (!runtimeRole || runtimeRole.rolsuper || runtimeRole.rolbypassrls) {
    throw new Error('UniFrendly runtime DATABASE_URL must use a non-superuser PostgreSQL role without BYPASSRLS.');
  }

  const app = Fastify({
    logger: {
      level: env.NODE_ENV === 'production' ? 'info' : 'debug',
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.body.password', 'req.body.refreshToken', 'req.body.invitationToken', 'req.body.token'],
      serializers: { req: (req) => ({ method: req.method, url: req.url, host: req.host, remoteAddress: req.ip }) }
    },
    trustProxy: env.NODE_ENV === 'production',
    bodyLimit: 256 * 1024,
    requestTimeout: 15_000,
    connectionTimeout: 10_000,
    keepAliveTimeout: 5_000,
    maxRequestsPerSocket: 1000
  });
  app.decorateRequest('auth', null);
  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } });
  await app.register(cors, { origin: env.NODE_ENV === 'production' ? false : true, credentials: false, methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'] });
  await app.register(rateLimit, { max: env.RATE_LIMIT_MAX, timeWindow: env.RATE_LIMIT_WINDOW, ban: 2, allowList: (request) => request.url === '/health/live' });

  app.get('/health/live', async () => ({ status: 'ok', service: 'unifrendly-api' }));
  app.get('/health/ready', async (_request, reply) => {
    try {
      const started = Date.now();
      await pool.query('SELECT 1');
      return { status: 'ready', database: 'ok', databaseLatencyMs: Date.now() - started };
    } catch {
      return reply.code(503).send({ status: 'not_ready', database: 'unavailable' });
    }
  });
  await registerRoutes(app);

  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'API route not found' } }));
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', fields: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) } });
    }
    if (error instanceof AppError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    const status = typeof (error as { statusCode?: unknown }).statusCode === 'number' ? (error as { statusCode: number }).statusCode : 500;
    if (status === 429) return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again shortly.' } });
    if (status >= 500) request.log.error({ err: error }, 'Unhandled API error');
    const safeMessage = error instanceof Error ? error.message : 'Request failed';
    return reply.code(status >= 400 && status < 500 ? status : 500).send({ error: { code: status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED', message: status >= 500 ? 'An unexpected error occurred' : safeMessage } });
  });
  return app;
}
