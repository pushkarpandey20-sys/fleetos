// services/rider-service/src/realtime/trackingServer.ts
// WebSocket server: receives GPS from Rider App
// SSE server: broadcasts live positions to Control Tower / Web Dashboard

import { WebSocketServer, WebSocket } from 'ws';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { kafka } from '../kafka';
import { redis } from '../redis';
import { TOPICS } from '../../../shared/events';
import { ulid } from 'ulid';
import { verifyRiderToken } from '../auth';
import { logger } from '../logger';

interface RiderConnection {
  ws: WebSocket;
  riderId: string;
  lastPing: number;
}

interface SSEClient {
  res: ServerResponse;
  userId: string;
  role: string;
  zoneFilter?: string;
}

const riderConnections = new Map<string, RiderConnection>();
const sseClients = new Set<SSEClient>();

// ─── WebSocket server (Rider App → Server) ────────────────────────────
export function startWebSocketServer(port = 3005) {
  const wss = new WebSocketServer({ port });

  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    const token = new URL(req.url!, `ws://localhost`).searchParams.get('token');
    if (!token) { ws.close(4001, 'No token'); return; }

    const rider = await verifyRiderToken(token);
    if (!rider) { ws.close(4003, 'Unauthorized'); return; }

    const conn: RiderConnection = { ws, riderId: rider.id, lastPing: Date.now() };
    riderConnections.set(rider.id, conn);

    // Update rider online status in Redis
    await redis.hSet(`rider:${rider.id}`, { status: 'available', ws_connected: '1' });
    await publishRiderStatus(rider.id, 'offline', 'available');

    logger.info(`Rider ${rider.id} connected via WebSocket`);

    ws.on('message', async (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        conn.lastPing = Date.now();

        if (msg.type === 'location') {
          await handleLocationUpdate(rider.id, msg);
        } else if (msg.type === 'status') {
          await handleStatusUpdate(rider.id, msg);
        } else if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        }
      } catch (err) {
        logger.error(`WS message parse error for rider ${rider.id}:`, err);
      }
    });

    ws.on('close', async () => {
      riderConnections.delete(rider.id);
      await redis.hSet(`rider:${rider.id}`, { status: 'offline', ws_connected: '0' });
      await publishRiderStatus(rider.id, 'available', 'offline');
      logger.info(`Rider ${rider.id} disconnected`);
    });

    ws.on('error', (err) => logger.error(`WS error rider ${rider.id}:`, err));
  });

  // Stale connection cleanup every 60s
  setInterval(() => {
    const cutoff = Date.now() - 90_000; // 90s no ping = stale
    for (const [riderId, conn] of riderConnections.entries()) {
      if (conn.lastPing < cutoff) {
        conn.ws.terminate();
        riderConnections.delete(riderId);
        logger.warn(`Terminated stale WS for rider ${riderId}`);
      }
    }
  }, 60_000);

  logger.info(`WebSocket server listening on :${port}`);
  return wss;
}

// ─── Handle GPS location push ─────────────────────────────────────────
async function handleLocationUpdate(riderId: string, msg: any) {
  const { lat, lng, accuracy_m, speed_kmh, heading_deg, battery_pct } = msg;

  // Minimum movement filter: ignore if < 5m from last position
  const lastPos = await redis.hGetAll(`rider:${riderId}`);
  if (lastPos.lat && lastPos.lng) {
    const dist = haversineM(parseFloat(lastPos.lat), parseFloat(lastPos.lng), lat, lng);
    if (dist < 5) return;
  }

  // Update Redis GeoIndex + hash
  await redis.geoAdd('riders:geo', { longitude: lng, latitude: lat, member: riderId });
  await redis.hSet(`rider:${riderId}`, {
    lat: lat.toString(),
    lng: lng.toString(),
    speed_kmh: (speed_kmh || 0).toString(),
    heading_deg: (heading_deg || 0).toString(),
    battery_pct: (battery_pct || 100).toString(),
    updated_at: Date.now().toString(),
  });

  // Broadcast to all SSE clients (Control Tower / web)
  const ssePayload = JSON.stringify({
    type: 'rider_location',
    rider_id: riderId,
    lat,
    lng,
    speed_kmh,
    heading_deg,
    battery_pct,
    ts: Date.now(),
  });
  broadcastSSE(ssePayload, riderId);

  // Publish to Kafka for TimescaleDB write + analytics
  await kafka.publish(TOPICS.RIDERS_LOCATION, {
    event_id: ulid(),
    event_type: 'rider.location_update',
    schema_ver: '1.0',
    produced_at: new Date().toISOString(),
    rider_id: riderId,
    lat, lng,
    accuracy_m: accuracy_m ?? 10,
    speed_kmh: speed_kmh ?? 0,
    heading_deg: heading_deg ?? 0,
    battery_pct: battery_pct ?? 100,
  }, riderId);

  // Trigger ETA recomputation for all active orders of this rider
  await triggerEtaRecompute(riderId, lat, lng);
}

async function triggerEtaRecompute(riderId: string, lat: number, lng: number) {
  const activeTasks = await redis.lRange(`rider:${riderId}:tasks`, 0, -1);
  for (const orderId of activeTasks) {
    const orderData = await redis.hGetAll(`order:${orderId}`);
    if (!orderData.drop_lat) continue;

    const eta = estimateEta(lat, lng, parseFloat(orderData.drop_lat), parseFloat(orderData.drop_lng));

    // Check SLA breach risk
    const slaDeadline = parseInt(orderData.sla_deadline_ts || '0');
    const minsToBreath = (slaDeadline - Date.now()) / 60000;
    if (minsToBreath > 0 && minsToBreath <= 10 && eta > minsToBreath * 60) {
      await kafka.publish(TOPICS.SLA_BREACH_RISK, {
        event_id: ulid(),
        event_type: 'sla.breach_risk',
        schema_ver: '1.0',
        produced_at: new Date().toISOString(),
        order_id: orderId,
        client_id: orderData.client_id,
        rider_id: riderId,
        sla_deadline: new Date(slaDeadline).toISOString(),
        eta_seconds: eta,
        minutes_to_breach: Math.round(minsToBreath),
      }, orderId);
    }

    // Broadcast updated ETA to SSE clients
    broadcastSSE(JSON.stringify({
      type: 'eta_update',
      order_id: orderId,
      rider_id: riderId,
      eta_seconds: eta,
    }), riderId);
  }
}

// ─── SSE server (Server → Control Tower / Web) ────────────────────────
export function setupSSERoute(app: any) {
  app.get('/v1/live/stream', async (req: IncomingMessage, res: ServerResponse, next: any) => {
    const token = (req as any).user; // set by auth middleware
    if (!token) { res.writeHead(401); res.end(); return; }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const client: SSEClient = {
      res,
      userId: token.id,
      role: token.role,
      zoneFilter: (req as any).query?.zone_id,
    };

    sseClients.add(client);
    res.write('data: {"type":"connected"}\n\n');

    // Send current snapshot of all riders
    const snapshot = await getAllRiderLocations();
    res.write(`data: ${JSON.stringify({ type: 'snapshot', riders: snapshot })}\n\n`);

    // Heartbeat every 25s
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 25_000);

    (req as any).on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(client);
    });
  });
}

function broadcastSSE(payload: string, riderId?: string) {
  for (const client of sseClients) {
    try {
      client.res.write(`data: ${payload}\n\n`);
    } catch {
      sseClients.delete(client);
    }
  }
}

async function getAllRiderLocations() {
  const members = await redis.zRange('riders:geo', 0, -1);
  const locations = await Promise.all(members.map(async (riderId) => {
    const data = await redis.hGetAll(`rider:${riderId}`);
    return {
      rider_id: riderId,
      lat: parseFloat(data.lat || '0'),
      lng: parseFloat(data.lng || '0'),
      status: data.status,
      speed_kmh: parseFloat(data.speed_kmh || '0'),
      heading_deg: parseInt(data.heading_deg || '0'),
      battery_pct: parseInt(data.battery_pct || '100'),
      updated_at: parseInt(data.updated_at || '0'),
    };
  }));
  return locations.filter(l => l.lat !== 0);
}

async function publishRiderStatus(riderId: string, from: string, to: string) {
  await kafka.publish(TOPICS.RIDERS_STATUS_CHANGED, {
    event_id: ulid(),
    event_type: 'rider.status_changed',
    schema_ver: '1.0',
    produced_at: new Date().toISOString(),
    rider_id: riderId,
    zone_id: await redis.hGet(`rider:${riderId}`, 'zone_id') || '',
    from_status: from,
    to_status: to,
  }, riderId);
}

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function estimateEta(fromLat: number, fromLng: number, toLat: number, toLng: number): number {
  const distM = haversineM(fromLat, fromLng, toLat, toLng);
  return Math.round((distM / 1000 / 25) * 3600); // 25 km/h avg
}

async function handleStatusUpdate(riderId: string, msg: any) {
  const { status } = msg;
  const prev = await redis.hGet(`rider:${riderId}`, 'status') || 'offline';
  await redis.hSet(`rider:${riderId}`, 'status', status);
  await publishRiderStatus(riderId, prev, status);
}
