import dotenv from "dotenv";
dotenv.config({ path: "../../../.env" });
import { Kafka, logLevel } from "kafkajs";
import knex from "knex";

const DATABASE_URL = process.env.DATABASE_URL || "";
const isNeon = DATABASE_URL.includes("neon.tech");

const db = knex({
  client: "pg",
  connection: {
    connectionString: DATABASE_URL || "postgresql://fleetos:fleetos_dev_pass@localhost:5432/fleetos",
    ssl: isNeon ? { rejectUnauthorized: false } : false,
  },
  pool: { min: 0, max: 5 },
});

const kafka = new Kafka({
  clientId: "notification-service",
  brokers: (process.env.KAFKA_BROKERS || "localhost:9092").split(",").filter(Boolean),
  logLevel: logLevel.ERROR,
});

async function sendSMS(phone: string, message: string) {
  console.log(`[SMS] To: ${phone} | ${message.slice(0, 60)}...`);
  // TODO: integrate Twilio: const client = require("twilio")(SID, TOKEN); client.messages.create(...)
}

async function sendWebhook(url: string, secret: string, event: string, payload: object) {
  try {
    const body = JSON.stringify(payload);
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-FleetOS-Event": event },
      body,
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) { console.error("[Webhook] failed:", e); }
}

async function handleStatusChanged(event: any) {
  try {
    const order = await db("orders")
      .leftJoin("clients", "orders.client_id", "clients.id")
      .leftJoin("riders", "orders.rider_id", "riders.id")
      .select("orders.*", "clients.name as client_name", "clients.webhook_url", "clients.webhook_secret", "riders.name as rider_name")
      .where("orders.id", event.order_id)
      .first();

    if (!order) return;

    const trackingUrl = `${process.env.TRACKING_BASE_URL || "https://fleetos-api.onrender.com/v1/track"}/${event.order_id}`;

    if (event.to_status === "picked_up") {
      await sendSMS(order.customer_phone, `FleetOS: Your order ${order.order_number} is on the way! Track: ${trackingUrl}`);
    } else if (event.to_status === "delivered") {
      await sendSMS(order.customer_phone, `FleetOS: Order ${order.order_number} delivered. Thank you!`);
    } else if (event.to_status === "failed") {
      await sendSMS(order.customer_phone, `FleetOS: Delivery attempt for ${order.order_number} failed. Reason: ${event.metadata?.reason || "Customer unavailable"}`);
    }

    if (order.webhook_url) {
      await sendWebhook(order.webhook_url, order.webhook_secret, `order.${event.to_status}`, {
        event: `order.${event.to_status}`, order_id: event.order_id,
        order_number: order.order_number, status: event.to_status,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (e) { console.error("[Notify] error:", e); }
}

async function main() {
  if (!process.env.KAFKA_BROKERS) {
    console.log("[Notification] No Kafka configured — running in stub mode");
    console.log("[Notification] Service ready (webhook/SMS will fire when Kafka is connected)");
    return;
  }

  const consumer = kafka.consumer({ groupId: "notification-svc" });
  await consumer.connect();
  await consumer.subscribe({ topics: ["orders.status_changed", "orders.delivered", "orders.failed"], fromBeginning: false });

  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      try { await handleStatusChanged(JSON.parse(message.value.toString())); }
      catch (e) { console.error("[Notify] message error:", e); }
    },
  });

  console.log("[Notification] Service listening on Kafka...");
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
