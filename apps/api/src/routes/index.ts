import type { FastifyInstance } from 'fastify';
import { authRoutes } from './auth.js';
import { adminRoutes } from './admin.js';
import { postRoutes } from './posts.js';
import { discoveryRoutes } from './discovery.js';
import { messageRoutes } from './messages.js';
import { mediaRoutes } from './media.js';
import { studyRoutes } from './study.js';
import { eventRoutes } from './events.js';
import { marketplaceRoutes } from './marketplace.js';
import { notificationRoutes } from './notifications.js';

export async function registerRoutes(app: FastifyInstance) {
  await app.register(async (v1) => {
    await authRoutes(v1);
    await adminRoutes(v1);
    await postRoutes(v1);
    await discoveryRoutes(v1);
    await messageRoutes(v1);
    await mediaRoutes(v1);
    await studyRoutes(v1);
    await eventRoutes(v1);
    await marketplaceRoutes(v1);
    await notificationRoutes(v1);
  }, { prefix: '/v1' });
}
