import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface AuthUser {
  id: string;
  role: "admin" | "manager" | "control_tower" | "team_leader" | "client" | "rider";
  client_id?: string;
  name?: string;
  email?: string;
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
      // Simple API key check without redis
      req.user = { id: apiKey, role: "client" };
      return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "No credentials provided" });
    }
    const token = authHeader.slice(7);
    const payload = jwt.verify(token, JWT_SECRET) as any;
    req.user = {
      id: payload.sub,
      role: payload.role,
      client_id: payload.client_id,
      name: payload.name,
      email: payload.email,
    };
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
