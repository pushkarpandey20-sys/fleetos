// services/order-service/src/middleware/auth.ts
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { db } from '../db';

export interface AuthUser {
  id: string;
  role: 'admin' | 'manager' | 'control_tower' | 'team_leader' | 'client' | 'rider';
  client_id?: string;
  zone_id?: string;
  rider_id?: string;
}

declare global {
  namespace Express {
    interface Request {
      user: AuthUser;
    }
  }
}

const API_KEY_HEADER = 'x-api-key';
const JWT_SECRET = process.env.JWT_SECRET!;

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    // Try API key first (for client integrations)
    const apiKey = req.headers[API_KEY_HEADER] as string;
    if (apiKey) {
      const client = await verifyApiKey(apiKey);
      if (!client) return res.status(401).json({ error: 'Invalid API key' });
      req.user = { id: client.id, role: 'client', client_id: client.id };
      return next();
    }

    // Try JWT bearer token
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No credentials provided' });
    }

    const token = authHeader.slice(7);
    const payload = jwt.verify(token, JWT_SECRET) as any;

    req.user = {
      id: payload.sub,
      role: payload.role,
      client_id: payload.client_id,
      zone_id: payload.zone_id,
      rider_id: payload.rider_id,
    };

    next();
  } catch (err: any) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

export function requireRoles(roles: AuthUser['role'][]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: 'Forbidden',
        required_roles: roles,
        your_role: req.user.role,
      });
    }
    next();
  };
}

async function verifyApiKey(rawKey: string): Promise<any | null> {
  // API keys are stored as bcrypt hashes — we use a prefix lookup for performance
  // Format: fleetos_live_<32_random_chars>
  const prefix = rawKey.slice(0, 16);
  const clients = await db('clients')
    .where({ is_active: true })
    .whereRaw("api_key_hash LIKE ?", [`${prefix}%`])
    .select('*');

  const bcrypt = await import('bcrypt');
  for (const client of clients) {
    if (await bcrypt.compare(rawKey, client.api_key_hash)) {
      // Rate limit check
      const rateLimitKey = `rl:client:${client.id}`;
      const redis = await import('../redis').then(m => m.redis);
      const count = await redis.incr(rateLimitKey);
      if (count === 1) await redis.expire(rateLimitKey, 60);
      if (count > client.rate_limit_rpm) return null;
      return client;
    }
  }
  return null;
}

// ─── Token issuance ───────────────────────────────────────────────────
export function issueTokens(user: AuthUser) {
  const accessToken = jwt.sign(
    {
      sub: user.id,
      role: user.role,
      client_id: user.client_id,
      zone_id: user.zone_id,
      rider_id: user.rider_id,
    },
    JWT_SECRET,
    { expiresIn: '15m' }
  );

  const refreshToken = jwt.sign(
    { sub: user.id, type: 'refresh' },
    JWT_SECRET,
    { expiresIn: '30d' }
  );

  return { accessToken, refreshToken };
}
