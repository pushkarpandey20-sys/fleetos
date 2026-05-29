import dotenv from "dotenv";
dotenv.config({ path: "../../../.env" });
import express from "express";
import { Kafka, logLevel } from "kafkajs";
import knex from "knex";

const app = express();
const DATABASE_URL = process.env.DATABASE_URL || "";
const isNeon = DATABASE_URL.includes("neon.tech");

const db = knex({
  client: "pg",
  connection: { connectionString: DATABASE_URL || "postgresql://fleetos:fleetos_dev_pass@localhost:5432/fleetos", ssl: isNeon ? { rejectUnauthorized: false } : false },
  pool: { min: 0, max: 5 },
});

const kafka = new Kafka({
  clientId: "notification-service",
  brokers: (process.env.KAFKA_BROKERS || "localhost:9092").split(",").filter(Boolean),
  logLevel: logLevel.ERROR,
});

async function startConsumer() {
  const consumer = kafka.consumer({ groupId: "notification-svc" });
  try {
    await consumer.connect();
    await consumer.subscribe({ topics: ["orders.status_changed", "orders.delivered", "orders.failed"], fromBeginning: false });
    await consumer.run({
      eachMessage: async ({ topic, message }) => {
        if (!message.value) return;
        const event = JSON.parse(message.value.toString());
        console.log("[notify]", topic, event.order_id, event.to_status || "");
      },
    });
    console.log("Notification service consuming Kafka topics");
  } catch {
    console.warn("[notify] Kafka not available - passive mode");
  }
}

app.get("/health", (_req, res) => res.json({ status: "ok", service: "notification-service" }));
const PORT = process.env.NOTIFICATION_SERVICE_PORT || 3003;
app.listen(PORT, () => console.log("Notification Service on :" + PORT));
startConsumer().catch(console.error);
