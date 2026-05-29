import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import knex from 'knex';
import { Kafka, logLevel } from 'kafkajs';
import { ulid } from 'ulid';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
dotenv.config({ path: '../../../.env' });

// ─── Inline db/kafka/auth (self-contained for this route) ─────────────
const db = knex({
  client: 'pg',
  connection: process.env.DATABASE_URL || 'postgresql://fleetos:fleetos_dev_pass@localhost:5432/fleetos',
  pool: { min: 2, max: 20 },
});

const kafka = new Kafka({ clientId: 'order-service', brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','), logLevel: logLevel.WARN });
const producer = kafka.producer({ allowAutoTopicCreation: true });
producer.connect().catch(() => console.warn('[Kafka] not connected — events will be skipped'));

async function publish(topic: string, value: object, key?: string) {
  try { await producer.send({ topic, messages: [{ key: key ?? null, value: JSON.stringify(value) }] }); }
  catch { /* non-fatal */ }
}

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';

export const orderRouter = Router();

// ─── Validation ────────────────────────────────────────────────────────
const CreateOrderSchema = z.object({
  client_id: z.string().uuid().optional(),
  pickup: z.object({ lat: z.number(), lng: z.number(), address: z.string().min(5) }),
  dropoff: z.object({ lat: z.number(), lng: z.number(), address: z.string().min(5) }),
  customer: z.object({ name: z.string().min(2), phone: z.string() }),
  cod_amount: z.number().min(0).default(0),
  weight_kg: z.number().min(0.1),
  sla_override_min: z.number().optional().nullable(),
  special_instructions: z.string().max(500).optional(),
  external_ref: z.string().max(100).optional(),
});

function getUser(req: Request) {
  try {
    const token = req.headers.authorization?.slice(7);
    if (!token) return null;
    return jwt.verify(token, JWT_SECRET) as any;
  } catch { return null; }
}

// ─── GET /orders ────────────────────────────────────────────────────────
orderRouter.get('/', async (req: Request, res: Response) => {
  try {
    const user = getUser(req);
    const { status, zone_id, rider_id, page = '1', limit = '50' } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);

    let query = db('orders')
      .leftJoin('clients', 'orders.client_id', 'clients.id')
      .leftJoin('riders', 'orders.rider_id', 'riders.id')
      .leftJoin('zones', 'orders.zone_id', 'zones.id')
      .select('orders.*', 'clients.name as client_name', 'riders.name as rider_name', 'zones.name as zone_name')
      .orderBy('orders.created_at', 'desc')
      .limit(parseInt(limit as string)).offset(offset);

    if (user?.role === 'client') query = query.where('orders.client_id', user.client_id);
    if (status) query = query.where('orders.status', status as string);
    if (zone_id) query = query.where('orders.zone_id', zone_id as string);
    if (rider_id) query = query.where('orders.rider_id', rider_id as string);

    const orders = await query;
    res.json({ data: orders, meta: { page: parseInt(page as string), limit: parseInt(limit as string) } });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ─── POST /orders ──────────────────────────────────────────────────────
orderRouter.post('/', async (req: Request, res: Response) => {
  try {
    const body = CreateOrderSchema.parse(req.body);
    const user = getUser(req);

    const clientId = body.client_id || user?.client_id;
    if (!clientId) return res.status(400).json({ error: 'client_id required' });

    const client = await db('clients').where({ id: clientId, is_active: true }).first();
    if (!client) return res.status(403).json({ error: 'Client not found' });

    // Find zone (simple nearest fallback)
    const zone = await db('zones').where({ is_active: true }).first();
    if (!zone) return res.status(422).json({ error: 'No active zones configured' });

    const slaMinutes = body.sla_override_min ?? client.sla_minutes ?? 60;
    const slaDeadline = new Date(Date.now() + slaMinutes * 60000);
    const customerOtp = String(Math.floor(1000 + Math.random() * 9000));

    const [order] = await db('orders').insert({
      client_id: clientId,
      zone_id: zone.id,
      pickup_lat: body.pickup.lat,
      pickup_lng: body.pickup.lng,
      pickup_address: body.pickup.address,
      drop_lat: body.dropoff.lat,
      drop_lng: body.dropoff.lng,
      drop_address: body.dropoff.address,
      customer_name: body.customer.name,
      customer_phone: body.customer.phone,
      customer_otp: customerOtp,
      cod_amount: body.cod_amount,
      weight_kg: body.weight_kg,
      sla_minutes: slaMinutes,
      sla_deadline: slaDeadline,
      special_instructions: body.special_instructions,
      external_ref: body.external_ref,
    }).returning('*');

    await publish('orders.created', {
      event_id: ulid(), event_type: 'order.created', schema_ver: '1.0',
      produced_at: new Date().toISOString(),
      order_id: order.id, client_id: clientId, zone_id: zone.id,
      pickup: body.pickup, dropoff: body.dropoff, customer: body.customer,
      cod_amount: body.cod_amount, weight_kg: body.weight_kg,
      sla_minutes: slaMinutes, sla_deadline: slaDeadline.toISOString(),
    }, order.id);

    res.status(201).json({
      id: order.id, order_number: order.order_number, status: order.status,
      sla_deadline: order.sla_deadline,
      tracking_url: `${process.env.TRACKING_BASE_URL || 'http://localhost:3001/v1/track'}/${order.id}`,
      created_at: order.created_at,
    });
  } catch (err: any) {
    if (err.name === 'ZodError') return res.status(400).json({ error: 'Validation failed', issues: err.errors });
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /orders/:id ───────────────────────────────────────────────────
orderRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const order = await db('orders')
      .leftJoin('clients', 'orders.client_id', 'clients.id')
      .leftJoin('riders', 'orders.rider_id', 'riders.id')
      .select('orders.*', 'clients.name as client_name', 'riders.name as rider_name')
      .where('orders.id', req.params.id)
      .orWhere('orders.order_number', req.params.id)
      .first();

    if (!order) return res.status(404).json({ error: 'Order not found' });

    const history = await db('order_status_history').where({ order_id: order.id }).orderBy('created_at', 'asc');
    res.json({ ...order, status_history: history });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ─── PUT /orders/:id/status ────────────────────────────────────────────
orderRouter.put('/:id/status', async (req: Request, res: Response) => {
  try {
    const { status, reason, lat, lng, pod_image_url, pod_signature_url } = req.body;
    const order = await db('orders').where({ id: req.params.id }).first();
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const allowed: Record<string, string[]> = {
      placed: ['assigned'], assigned: ['picked_up', 'failed'],
      picked_up: ['in_transit', 'failed'], in_transit: ['delivered', 'failed'], failed: ['rto'],
    };
    if (!allowed[order.status]?.includes(status)) {
      return res.status(422).json({ error: `Cannot move from ${order.status} to ${status}` });
    }

    const updates: Record<string, any> = { status };
    if (status === 'delivered') {
      updates.delivered_at = new Date();
      updates.sla_met = new Date() <= new Date(order.sla_deadline);
      updates.pod_image_url = pod_image_url;
      updates.pod_signature_url = pod_signature_url;
    }
    if (status === 'failed') updates.failure_reason = reason;

    await db('orders').where({ id: order.id }).update(updates);
    await db('order_status_history').insert({
      order_id: order.id, from_status: order.status, to_status: status,
      reason, lat, lng,
    });

    await publish('orders.status_changed', {
      event_id: ulid(), event_type: 'order.status_changed', schema_ver: '1.2',
      produced_at: new Date().toISOString(),
      order_id: order.id, client_id: order.client_id, rider_id: order.rider_id,
      from_status: order.status, to_status: status,
      location: lat && lng ? { lat, lng } : null,
      sla_deadline: order.sla_deadline,
      metadata: { reason, attempt: order.attempt_count, pod_image_url, pod_signature_url },
    }, order.id);

    res.json({ id: order.id, status, updated_at: new Date() });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ─── DELETE /orders/:id ────────────────────────────────────────────────
orderRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const order = await db('orders').where({ id: req.params.id }).first();
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!['placed', 'assigned'].includes(order.status)) {
      return res.status(422).json({ error: 'Can only cancel before pickup' });
    }
    await db('orders').where({ id: req.params.id }).update({ status: 'failed', failure_reason: 'Cancelled' });
    res.status(204).send();
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});
