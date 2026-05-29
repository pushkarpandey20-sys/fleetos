import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { db } from "../db";
import { redis } from "../redis";

export interface AuthUser {
  id: string;
  role: "admin" | "manager" | "control_tower" | "team_leader" | "client" | "rider";
  client_id?: string;
}

declare global {
  namespace Express {
    interface Request { user: AuthUser; }
  }
}

const JWT_SECRET = process.env.JWT_SECRET || "dev_secret";

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
    if (!authHeader?.startsWith("Bearer ")) return res.status(401).json({ error: "No credentials" });
    const payload = jwt.verify(authHeader.slice(7), JWT_SECRET) as any;
    req.user = { id: payload.sub, role: payload.role, client_id: payload.client_id };
    next();
  } catch (err: any) {
    if (err.name === "TokenExpiredError") return res.status(401).json({ error: "Token expired" });
    return res.status(401).json({ error: "Invalid token" });
  }
}

export function requireRoles(roles: AuthUser["role"][]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: "Forbidden" });
    next();
  };
}

async function verifyApiKey(rawKey: string): Promise<any | null> {
  const clients = await db("clients").where({ is_active: true }).select("*");
  for (const client of clients) {
    if (client.api_key_hash && await bcrypt.compare(rawKey, client.api_key_hash)) return client;
  }
  return null;
}

export function issueTokens(user: AuthUser) {
  const accessToken = jwt.sign({ sub: user.id, role: user.role, client_id: user.client_id }, JWT_SECRET, { expiresIn: "15m" });
  const refreshToken = jwt.sign({ sub: user.id, type: "refresh" }, JWT_SECRET, { expiresIn: "30d" });
  return { accessToken, refreshToken };
}
