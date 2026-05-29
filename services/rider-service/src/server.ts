import dotenv from 'dotenv';
dotenv.config({ path: '../../../.env' });
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import knex from 'knex';
import Redis from 'ioredis';
import { Kafka, logLevel } from 'kafkajs';
import { ulid } from 'ulid';
import jwt from 'jsonwebtoken';

const app = express();
app.use(helmet()); app.use(cors()); app.use(express.json());

const db = knex({ client: 'pg', connection: process.env.DATABASE_URL });
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
const kafka = new Kafka({ clientId: 'rider-service', brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','), logLevel: logLevel.WARN });
const producer = kafka.producer({ allowAutoTopicCreation: true });

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

interface RiderConn { ws: WebSocket; riderId: string; lastPing: number; }
const connections = new Map<string, RiderConn>();

// ── WebSocket: Rider GPS ──────────────────────────────────────────────
wss.on('connection', async (ws, req) => {
  const token = new URL(req.url!, `ws://localhost`).searchParams.get('token');
  if (!token) { ws.close(4001, 'No token'); return; }

  let riderId: string;
  try {
    const p = jwt.verify(token, process.env.JWT_SECRET || 'dev') as any;
    riderId = p.rider_id || p.sub;
  } catch { ws.close(4003, 'Invalid token'); return; }

  connections.set(riderId, { ws, riderId, lastPing: Date.now() });
  await redis.hset(`rider:${riderId}`, 'ws_connected', '1', 'status', 'available');
  console.log(`[WS] Rider ${riderId} connected`);

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const conn = connections.get(riderId);
      if (conn) conn.lastPing = Date.now();

      if (msg.type === 'location') {
        const { lat, lng, accuracy_m = 10, speed_kmh = 0, heading_deg = 0, battery_pct = 100 } = msg;
        await redis.geoadd('riders:geo', lng, lat, riderId);
        await redis.hset(`rider:${riderId}`, 'lat', lat, 'lng', lng, 'speed', speed_kmh, 'heading', heading_deg, 'battery', battery_pct, 'updated_at', Date.now());
        await db('riders').where({ id: riderId }).update({ current_lat: lat, current_lng: lng, last_location_at: new Date() });
        await producer.send({ topic: 'riders.location', messages: [{ key: riderId, value: JSON.stringify({ event_id: ulid(), event_type: 'rider.location_update', schema_ver: '1.0', produced_at: new Date().toISOString(), rider_id: riderId, lat, lng, accuracy_m, speed_kmh, heading_deg, battery_pct }) }] });

        // Broadcast to SSE clients
        sseClients.forEach(c => c.write(`data: ${JSON.stringify({ type: 'rider_location', rider_id: riderId, lat, lng, speed_kmh, battery_pct, ts: Date.now() })}\n\n`));
      } else if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      }
    } catch (e) { console.error('[WS] msg error:', e); }
  });

  ws.on('close', async () => {
    connections.delete(riderId);
    await redis.hset(`rider:${riderId}`, 'status', 'offline', 'ws_connected', '0');
    console.log(`[WS] Rider ${riderId} disconnected`);
  });
});

// ── SSE: Live map feed ───────────────────────────────────────────────
const sseClients = new Set<any>();

app.get('/v1/live/stream', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  sseClients.add(res);
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
  const hb = setInterval(() => res.write(': heartbeat\n\n'), 25000);
  req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
});

// ── REST routes ──────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'rider-service', connections: connections.size }));

app.get('/v1/riders', async (_req, res) => {
  try {
    const riders = await db('riders').join('zones', 'riders.zone_id', 'zones.id').select('riders.*', 'zones.name as zone_name').where('riders.is_active', true);
    res.json({ data: riders });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.get('/v1/riders/:id/location', async (req, res) => {
  try {
    const data = await redis.hgetall(`rider:${req.params.id}`);
    res.json({ rider_id: req.params.id, lat: parseFloat(data.lat), lng: parseFloat(data.lng), speed_kmh: parseFloat(data.speed), battery_pct: parseInt(data.battery), updated_at: parseInt(data.updated_at) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post('/v1/riders/:id/location', async (req, res) => {
  const { lat, lng, accuracy_m, speed_kmh, heading_deg, battery_pct } = req.body;
  await redis.geoadd('riders:geo', lng, lat, req.params.id);
  await redis.hset(`rider:${req.params.id}`, 'lat', lat, 'lng', lng, 'updated_at', Date.now());
  res.json({ ok: true });
});

// ── Boot ─────────────────────────────────────────────────────────────
const HTTP_PORT = process.env.RIDER_SERVICE_PORT || 3002;
producer.connect().then(() => {
  httpServer.listen(HTTP_PORT, () => {
    console.log(`\n🏍️  Rider Service running on http://localhost:${HTTP_PORT}`);
    console.log(`   WebSocket: ws://localhost:${HTTP_PORT}/ws?token=<jwt>`);
    console.log(`   Live SSE:  http://localhost:${HTTP_PORT}/v1/live/stream\n`);
  });
});
