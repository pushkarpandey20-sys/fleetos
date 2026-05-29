import { Router } from 'express';
import { db } from '../db';
import { redis } from '../redis';

export const healthRouter = Router();

healthRouter.get('/', async (_req, res) => {
  try {
    await db.raw('SELECT 1');
    await redis.ping();
    res.json({ status: 'ok', service: 'order-service', ts: new Date().toISOString() });
  } catch (err: any) {
    res.status(503).json({ status: 'error', error: err.message });
  }
});
