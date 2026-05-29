import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { db } from "../db";
import Redis from "ioredis";

export interface AuthUser {
  id: string;
  role: "admin" | "manager" | "control_tower" | "team_leader" | "client" | "rider";
  client_id?: string;
  zone_id?: string;
  rider_id?: string;
}

declare global {
  namespace Express {
    interface Request { user: AuthUser; }
  }
}

const JWT_SECRET = process.env.JWT_SECRET || "dev_secret";

let redis: Redis | null = null;
try {
  redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
    maxRetriesPerRequest: 1, lazyConnect: true, enableOfflineQueue: false,
  });
  redis.on("error", () => { redis = null; });
} catch { redis = null; }

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const apiKey = req.headers["x-api-key"] as string;
    if (apiKey) {
      const client = await verifyApiKey(apiKey);
      if (!client) return res.status(401).json({ error: "Invalid API key" });
      req.user = { id: client.id, role: "client", client_id: client.id };
      return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "No credentials provided" });
    }

    const token = authHeader.slice(7);
    const payload = jwt.verify(token, JWT_SECRET) as any;
    req.user = { id: payload.sub, role: payload.role, client_id: payload.client_id,
      zone_id: payload.zone_id, rider_id: payload.rider_id };
    next();
  } catch (err: any) {
    if (err.name === "TokenExpiredError") return res.status(401).json({ error: "Token expired" });
    return res.status(401).json({ error: "Invalid token" });
  }
}

export function requireRoles(roles: AuthUser["role"][]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Forbidden", required_roles: roles, your_role: req.user.role });
    }
    next();
  };
}

async function verifyApiKey(rawKey: string): Promise<any | null> {
  try {
    const clients = await db("clients").where({ is_active: true }).select("*");
    for (const client of clients) {
      if (client.api_key_hash && await bcrypt.compare(rawKey, client.api_key_hash)) {
        if (redis) {
          const key = `rl:client:${client.id}`;
          const count = await redis.incr(key).catch(() => 1);
          if (count === 1) await redis.expire(key, 60).catch(() => {});
          if (count > (client.rate_limit_rpm || 600)) return null;
        }
        return client;
      }
    }
  } catch { return null; }
  return null;
}

export function issueTokens(user: AuthUser) {
  const accessToken = jwt.sign(
    { sub: user.id, role: user.role, client_id: user.client_id },
    JWT_SECRET, { expiresIn: "15m" }
  );
  const refreshToken = jwt.sign(
    { sub: user.id, type: "refresh" }, JWT_SECRET, { expiresIn: "30d" }
  );
  return { accessToken, refreshToken };
}
