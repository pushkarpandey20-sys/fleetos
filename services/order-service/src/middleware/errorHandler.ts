import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger } from './logger';

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'Validation failed', issues: err.errors });
  }
  logger.error(err.message, { stack: err.stack, path: req.path });
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
}
