import dotenv from "dotenv";
dotenv.config({ path: "../../../.env" });
import express from "express";
import knex from "knex";

const app = express();
app.use(express.json());

const DATABASE_URL = process.env.DATABASE_URL || "";
const isNeon = DATABASE_URL.includes("neon.tech");

const db = knex({
  client: "pg",
  connection: { connectionString: DATABASE_URL || "postgresql://fleetos:fleetos_dev_pass@localhost:5432/fleetos", ssl: isNeon ? { rejectUnauthorized: false } : false },
  pool: { min: 0, max: 5 },
});

app.get("/health", (_req, res) => res.json({ status: "ok", service: "billing-service" }));
app.get("/v1/billing/summary/:client_id", async (req, res) => {
  try {
    const [summary] = await db("orders").where({ client_id: req.params.client_id, status: "delivered" })
      .select(db.raw("COUNT(*) as total_orders, COALESCE(SUM(cod_amount),0) as total_cod"));
    res.json({ client_id: req.params.client_id, summary });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.BILLING_SERVICE_PORT || 3004;
app.listen(PORT, () => console.log("Billing Service on :" + PORT));
