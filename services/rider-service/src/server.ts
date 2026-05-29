import dotenv from 'dotenv';
dotenv.config({ path: "../../../.env" });
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import knex from "knex";
import Redis from "ioredis";
import { Kafka, logLevel } from "kafkajs";
import { ulid } from "ulid";
import jwt from "jsonwebtoken";

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());

const DATABASE_URL = process.env.DATABASE_URL || "";
const isNeon = DATABASE_URL.includes("neon.tech");

const db = knex({
  client: "pg",
  connection: {
    connectionString: DATABASE_URL || "postgresql://fleetos:fleetos_dev_pass@localhost:5432/fleetos",
    ssl: isNeon ? { rejectUnauthorized: false } : false,
  },
  pool: { min: 0, max: 10 },
});

let redis: Redis | null = null;
try {
  redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    enableOfflineQueue: false,
  });
  redis.on("error", () => { redis = null; });
} catch { redis = null; }

let producer: any = null;
try {
  const kafka = new Kafka({
    clientId: "rider-service",
    brokers: (process.env.KAFKA_BROKERS || "localhost:9092").split(",").filter(Boolean),
    logLevel: logLevel.ERROR,
  });
  producer = kafka.producer({ allowAutoTopicCreation: true });
  producer.connect().catch(() => { producer = null; });
} catch { producer = null; }

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
const connections = new Map<string, { ws: WebSocket; riderId: string; lastPing: number }>();
const sseClients = new Set<express.Response>();

// ── WebSocket: Rider GPS ─────────────────────────────────────────────
wss.on("connection", async (ws: WebSocket, req: any) => {
  const url = new URL(req.url!, `ws://localhost`);
  const token = url.searchParams.get("token");
  if (!token) { ws.close(4001, "No token"); return; }

  let riderId: string;
  try {
    const p = jwt.verify(token, process.env.JWT_SECRET || "dev") as any;
    riderId = p.rider_id || p.sub;
  } catch { ws.close(4003, "Invalid token"); return; }

  connections.set(riderId, { ws, riderId, lastPing: Date.now() });
  if (redis) await redis.hset(`rider:${riderId}`, "status", "available", "ws_connected", "1").catch(() => {});
  console.log(`[WS] Rider ${riderId} connected. Total: ${connections.size}`);

  ws.on("message", async (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      const conn = connections.get(riderId);
      if (conn) conn.lastPing = Date.now();

      if (msg.type === "location") {
        const { lat, lng, accuracy_m = 10, speed_kmh = 0, heading_deg = 0, battery_pct = 100 } = msg;
        if (redis) {
          await redis.geoadd("riders:geo", lng, lat, riderId).catch(() => {});
          await redis.hset(`rider:${riderId}`, "lat", String(lat), "lng", String(lng),
            "speed", String(speed_kmh), "battery", String(battery_pct),
            "updated_at", String(Date.now())).catch(() => {});
        }
        await db("riders").where({ id: riderId }).update({
          current_lat: lat, current_lng: lng, last_location_at: new Date(),
        }).catch(() => {});

        if (producer) {
          await producer.send({ topic: "riders.location", messages: [{
            key: riderId,
            value: JSON.stringify({ event_id: ulid(), event_type: "rider.location_update",
              rider_id: riderId, lat, lng, accuracy_m, speed_kmh, heading_deg, battery_pct,
              produced_at: new Date().toISOString() })
          }]}).catch(() => {});
        }

        const payload = JSON.stringify({ type: "rider_location", rider_id: riderId, lat, lng, speed_kmh, battery_pct, ts: Date.now() });
        sseClients.forEach((res) => { try { res.write(`data: ${payload}\n\n`); } catch { sseClients.delete(res); } });
      } else if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
      }
    } catch (e) { console.error("[WS] Error:", e); }
  });

  ws.on("close", async () => {
    connections.delete(riderId);
    if (redis) await redis.hset(`rider:${riderId}`, "status", "offline").catch(() => {});
    console.log(`[WS] Rider ${riderId} disconnected`);
  });
});

// ── SSE: Live map feed ───────────────────────────────────────────────
app.get("/v1/live/stream", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
  sseClients.add(res);
  res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
  const hb = setInterval(() => res.write(": heartbeat\n\n"), 25000);
  req.on("close", () => { clearInterval(hb); sseClients.delete(res); });
});

// ── REST ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok", service: "rider-service", connections: connections.size }));

app.get("/v1/riders", async (_req, res) => {
  try {
    const riders = await db("riders").leftJoin("zones", "riders.zone_id", "zones.id")
      .select("riders.*", "zones.name as zone_name").where("riders.is_active", true);
    res.json({ data: riders });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.get("/v1/riders/:id/location", async (req, res) => {
  try {
    if (redis) {
      const data = await redis.hgetall(`rider:${req.params.id}`);
      if (data?.lat) return res.json({ rider_id: req.params.id, lat: parseFloat(data.lat), lng: parseFloat(data.lng), updated_at: parseInt(data.updated_at || "0") });
    }
    const rider = await db("riders").where({ id: req.params.id }).first();
    res.json({ rider_id: req.params.id, lat: rider?.current_lat, lng: rider?.current_lng });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post("/v1/riders/:id/location", async (req, res) => {
  const { lat, lng } = req.body;
  if (redis) await redis.geoadd("riders:geo", lng, lat, req.params.id).catch(() => {});
  await db("riders").where({ id: req.params.id }).update({ current_lat: lat, current_lng: lng, last_location_at: new Date() }).catch(() => {});
  res.json({ ok: true });
});

// ── Boot ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || process.env.RIDER_SERVICE_PORT || 3002;
httpServer.listen(PORT, () => {
  console.log(`\n🏍️  Rider Service running on :${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}/ws?token=<jwt>`);
  console.log(`   SSE:       http://localhost:${PORT}/v1/live/stream\n`);
});

process.on("SIGTERM", () => httpServer.close(() => process.exit(0)));
