import { Router, Request, Response } from 'express';
import { db } from '../db';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

export const authRouter = Router();

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';

authRouter.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = LoginSchema.parse(req.body);
    const user = await db('users').where({ email, is_active: true }).first();
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    await db('users').where({ id: user.id }).update({ last_login_at: new Date() });

    const accessToken = jwt.sign(
      { sub: user.id, role: user.role, client_id: user.client_id },
      JWT_SECRET, { expiresIn: '15m' }
    );
    const refreshToken = jwt.sign(
      { sub: user.id, type: 'refresh' },
      JWT_SECRET, { expiresIn: '30d' }
    );

    // Store hashed refresh token
    await db('users').where({ id: user.id }).update({
      refresh_token: await bcrypt.hash(refreshToken, 8),
    });

    res.json({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 900,
      user: { id: user.id, name: user.name, role: user.role, email: user.email },
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

authRouter.post('/refresh', async (req: Request, res: Response) => {
  try {
    const { refresh_token } = req.body;
    const payload = jwt.verify(refresh_token, JWT_SECRET) as any;
    if (payload.type !== 'refresh') return res.status(401).json({ error: 'Invalid token type' });

    const user = await db('users').where({ id: payload.sub, is_active: true }).first();
    if (!user) return res.status(401).json({ error: 'User not found' });

    const valid = await bcrypt.compare(refresh_token, user.refresh_token);
    if (!valid) return res.status(401).json({ error: 'Token revoked' });

    const accessToken = jwt.sign(
      { sub: user.id, role: user.role, client_id: user.client_id },
      JWT_SECRET, { expiresIn: '15m' }
    );

    res.json({ access_token: accessToken, expires_in: 900 });
  } catch {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

authRouter.post('/logout', async (req: Request, res: Response) => {
  const auth = req.headers.authorization?.slice(7);
  if (auth) {
    try {
      const p = jwt.verify(auth, JWT_SECRET) as any;
      await db('users').where({ id: p.sub }).update({ refresh_token: null });
    } catch {}
  }
  res.json({ ok: true });
});
