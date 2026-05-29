// services/notification-service/src/channels/webhook.ts
import crypto from 'crypto';
import { db } from '../db';
import { logger } from '../logger';

interface WebhookOptions {
  clientId: string;
  webhookUrl: string;
  secret: string;
  event: string;
  orderId: string;
  payload: object;
}

const RETRY_DELAYS = [30, 120, 600, 1800, 3600]; // seconds

export async function dispatchWebhook(opts: WebhookOptions): Promise<void> {
  const deliveryId = `dlv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const body = JSON.stringify(opts.payload);
  const signature = signPayload(body, opts.secret);

  // Log delivery attempt
  await db('webhook_deliveries').insert({
    client_id: opts.clientId,
    event_type: opts.event,
    order_id: opts.orderId,
    payload: opts.payload,
    delivery_id: deliveryId,
    status: 'pending',
    next_attempt_at: new Date(),
  });

  await attemptDelivery(deliveryId, opts.webhookUrl, body, signature, opts.event, deliveryId);
}

async function attemptDelivery(
  dbId: string,
  url: string,
  body: string,
  signature: string,
  event: string,
  deliveryId: string,
  attempt = 1
): Promise<void> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-FleetOS-Event': event,
        'X-FleetOS-Signature': `sha256=${signature}`,
        'X-FleetOS-Delivery-ID': deliveryId,
        'X-FleetOS-Timestamp': Date.now().toString(),
      },
      body,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    await db('webhook_deliveries').where({ delivery_id: deliveryId }).update({
      status: res.ok ? 'delivered' : 'failed',
      attempts: attempt,
      last_response: res.status,
    });

    if (!res.ok && attempt < RETRY_DELAYS.length) {
      const nextAttemptAt = new Date(Date.now() + RETRY_DELAYS[attempt - 1] * 1000);
      await db('webhook_deliveries').where({ delivery_id: deliveryId }).update({
        status: 'pending',
        next_attempt_at: nextAttemptAt,
      });
      logger.warn(`Webhook ${deliveryId} failed (HTTP ${res.status}), retry ${attempt} scheduled`);
    }
  } catch (err: any) {
    logger.error(`Webhook ${deliveryId} error: ${err.message}`);
    if (attempt < RETRY_DELAYS.length) {
      const nextAttemptAt = new Date(Date.now() + RETRY_DELAYS[attempt - 1] * 1000);
      await db('webhook_deliveries').where({ delivery_id: deliveryId }).update({
        status: 'pending',
        attempts: attempt,
        next_attempt_at: nextAttemptAt,
      });
    } else {
      await db('webhook_deliveries').where({ delivery_id: deliveryId }).update({
        status: 'abandoned',
        attempts: attempt,
      });
    }
  }
}

function signPayload(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

// ─── Retry worker — runs every 30s ────────────────────────────────────
export async function runRetryWorker(): Promise<void> {
  setInterval(async () => {
    const due = await db('webhook_deliveries')
      .where('status', 'pending')
      .where('next_attempt_at', '<=', new Date())
      .limit(50);

    for (const delivery of due) {
      const client = await db('clients').where({ id: delivery.client_id }).first();
      if (!client?.webhook_url) continue;

      const body = JSON.stringify(delivery.payload);
      const signature = signPayload(body, client.webhook_secret);
      await attemptDelivery(
        delivery.id,
        client.webhook_url,
        body,
        signature,
        delivery.event_type,
        delivery.delivery_id,
        delivery.attempts + 1,
      );
    }
  }, 30_000);
}
