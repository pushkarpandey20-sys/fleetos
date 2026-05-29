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

const allowedOrigins = [
  'https://pushkarpandey20-sys.github.io',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:8080',
  '*'
];

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({
  origin: (origin, callback) => callback(null, true),
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
  credentials: true,
}));
app.options('*', cors());
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
