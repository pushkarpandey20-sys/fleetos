import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { json } from 'body-parser';
import { orderRouter } from './routes/orders';
import { trackRouter } from './routes/track';
import { healthRouter } from './routes/health';
import { authRouter } from './routes/auth';
import { errorHandler } from './middleware/errorHandler';
import { authMiddleware } from './middleware/auth';
import { rateLimiter } from './middleware/rateLimiter';
import { requestLogger } from './middleware/logger';

const app = express();

app.use(helmet());
app.use(cors({ origin: (process.env.ALLOWED_ORIGINS || '').split(',') }));
app.use(json({ limit: '5mb' }));
app.use(requestLogger);

// Public routes
app.use('/health', healthRouter);
app.use('/v1/track', trackRouter);
app.use('/v1/auth', authRouter);

// Protected routes
app.use('/v1', rateLimiter, authMiddleware);
app.use('/v1/orders', orderRouter);

app.use(errorHandler);

export default app;
