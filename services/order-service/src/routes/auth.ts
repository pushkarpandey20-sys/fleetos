import { Router, Request, Response } from "express";
import knex from "knex";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import dotenv from "dotenv";
dotenv.config({ path: "../../../.env" });

const router = Router();

const db = knex({
  client: "pg",
  connection: {
    connectionString: process.env.DATABASE_URL || "",
    ssl: (process.env.DATABASE_URL || "").includes("neon.tech")
      ? { rejectUnauthorized: false }
      : false,
  },
  pool: { min: 0, max: 5 },
});

const JWT_SECRET = process.env.JWT_SECRET || "dev_secret";

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post("/login", async (req: Request, res: Response) => {
  try {
    const { email, password } = LoginSchema.parse(req.body);
    console.log("[auth] Login attempt:", email);

    const user = await db("users").where({ email, is_active: true }).first();
    if (!user) {
      console.log("[auth] User not found:", email);
      return res.status(401).json({ error: "Invalid credentials" });
    }

    console.log("[auth] User found, checking password...");
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      console.log("[auth] Wrong password for:", email);
      return res.status(401).json({ error: "Invalid credentials" });
    }

    await db("users").where({ id: user.id }).update({ last_login_at: new Date() });

    const accessToken = jwt.sign(
      { sub: user.id, role: user.role, client_id: user.client_id, name: user.name, email: user.email },
      JWT_SECRET,
      { expiresIn: "24h" }
    );
    const refreshToken = jwt.sign(
      { sub: user.id, type: "refresh" },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    console.log("[auth] Login success:", email, user.role);
    return res.json({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 86400,
      user: { id: user.id, name: user.name, role: user.role, email: user.email },
    });
  } catch (err: any) {
    console.error("[auth] Error:", err.message);
    if (err.name === "ZodError") {
      return res.status(400).json({ error: "Invalid request", issues: err.errors });
    }
    return res.status(500).json({ error: err.message });
  }
});

router.post("/refresh", async (req: Request, res: Response) => {
  try {
    const { refresh_token } = req.body;
    const payload = jwt.verify(refresh_token, JWT_SECRET) as any;
    if (payload.type !== "refresh") return res.status(401).json({ error: "Invalid token" });
    const user = await db("users").where({ id: payload.sub, is_active: true }).first();
    if (!user) return res.status(401).json({ error: "User not found" });
    const accessToken = jwt.sign(
      { sub: user.id, role: user.role, client_id: user.client_id, name: user.name },
      JWT_SECRET, { expiresIn: "24h" }
    );
    return res.json({ access_token: accessToken, expires_in: 86400 });
  } catch {
    return res.status(401).json({ error: "Invalid refresh token" });
  }
});

router.post("/logout", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

export const authRouter = router;
