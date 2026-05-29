import Redis from 'ioredis';
import dotenv from 'dotenv';
dotenv.config({ path: '../../../.env' });

export const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});
redis.on('error', (err) => console.error('[Redis]', err.message));
