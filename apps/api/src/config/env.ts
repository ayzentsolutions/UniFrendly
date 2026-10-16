import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: z.string().default('false').transform((v) => v === 'true'),
  DATABASE_SSL_CA: z.string().optional(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  APP_ORIGIN: z.string().default('unifrendly://'),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10000).default(120),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  BOOTSTRAP_ADMIN_KEY: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.string().default('true').transform((v) => v === 'true'),
  SIGNED_UPLOAD_TTL_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
  MEDIA_DELETE_GRACE_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  EXPO_ACCESS_TOKEN: z.string().optional(),
  EXPO_PUSH_ENABLED: z.string().default('false').transform((v) => v === 'true')
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid API environment configuration:', parsed.error.flatten().fieldErrors);
  throw new Error('API environment configuration is invalid');
}
export const env = parsed.data;
export const uploadsConfigured = Boolean(env.S3_ENDPOINT && env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY);
