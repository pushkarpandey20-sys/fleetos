import dotenv from 'dotenv';
dotenv.config({ path: '../../../.env' });
import express from 'express';
import { Kafka, logLevel } from 'kafkajs';
import knex from 'knex';
import { ulid } from 'ulid';

const app = express();
app.use(express.json());

const db = knex({
  client: 'pg',
  connection: process.env.DATABASE_URL || 'postgresql://fleetos:fleetos_dev_pass@localhost:5432/fleetos',
  pool: { min: 2, max: 10 },
});

const kafka = new Kafka({
  clientId: 'billing-service',
  brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
  logLevel: logLevel.WARN,
});

// ── COD reconciliation consumer ──────────────────────────────────────
async function startConsumer() {
  const consumer = kafka.consumer({ groupId: 'billing-svc' });
  await consumer.connect();
  await consumer.subscribe({ topics: ['orders.delivered', 'billing.cod_collected'], fromBeginning: false });

  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      if (!message.value) return;
      const event = JSON.parse(message.value.toString());

      if (topic === 'orders.delivered' && event.cod_collected) {
        // Record COD collection
        await db('cod_transactions').insert({
          order_id: event.order_id,
          client_id: event.client_id,
          rider_id: event.rider_id,
          amount: event.cod_amount,
          collected_at: event.delivered_at,
          status: 'collected',
        }).onConflict('order_id').ignore();
        console.log(`[billing] COD recorded: ₹${event.cod_amount} for order ${event.order_id}`);
      }
    },
  });
}

// ── Routes ───────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'billing-service' }));

app.get('/v1/billing/summary/:client_id', async (req, res) => {
  try {
    const { date_from, date_to } = req.query;
    let query = db('orders')
      .where({ client_id: req.params.client_id, status: 'delivered' })
      .select(
        db.raw('COUNT(*) as total_orders'),
        db.raw('SUM(cod_amount) as total_cod'),
        db.raw('COUNT(CASE WHEN sla_met = true THEN 1 END) as sla_met'),
        db.raw('COUNT(CASE WHEN sla_met = false THEN 1 END) as sla_breached')
      );
    if (date_from) query = query.where('delivered_at', '>=', date_from as string);
    if (date_to) query = query.where('delivered_at', '<=', date_to as string);
    const [summary] = await query;
    res.json({ client_id: req.params.client_id, summary });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.BILLING_SERVICE_PORT || 3004;
app.listen(PORT, () => console.log(`💰 Billing Service running on :${PORT}`));
startConsumer().catch(console.error);
