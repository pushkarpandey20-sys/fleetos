// services/notification-service/src/index.ts
import { kafka } from './kafka';
import { TOPICS } from '../../shared/events';
import { sendSMS } from './channels/sms';
import { sendWhatsApp } from './channels/whatsapp';
import { sendPush } from './channels/push';
import { dispatchWebhook } from './channels/webhook';
import { db } from './db';
import { logger } from './logger';

const TEMPLATES = {
  order_assigned: (data: any) => ({
    sms: `FleetOS: Your order ${data.order_number} is assigned. Rider ${data.rider_name} is on the way. Track: ${data.tracking_url}`,
    whatsapp: `Your *${data.order_number}* has been assigned to ${data.rider_name}.\nTrack live: ${data.tracking_url}`,
  }),
  order_picked_up: (data: any) => ({
    sms: `FleetOS: ${data.rider_name} has picked up your order ${data.order_number}. ETA: ~${data.eta_min} min. Track: ${data.tracking_url}`,
    whatsapp: `📦 *${data.order_number}* is on its way!\nETA: ~${data.eta_min} minutes\nTrack live: ${data.tracking_url}`,
  }),
  order_delivered: (data: any) => ({
    sms: `FleetOS: Your order ${data.order_number} has been delivered. Thank you!`,
    whatsapp: `✅ *${data.order_number}* delivered successfully. Thank you for using FleetOS!`,
  }),
  order_failed: (data: any) => ({
    sms: `FleetOS: Delivery attempted for ${data.order_number}. Reason: ${data.reason}. We'll retry. Contact: ${data.support_phone}`,
    whatsapp: `⚠️ Delivery attempt for *${data.order_number}* was unsuccessful.\nReason: ${data.reason}\nWe will retry or contact you shortly.`,
  }),
  sla_breach: (data: any) => ({
    push: `⚠️ SLA BREACH: Order ${data.order_number} in Zone ${data.zone} — ${data.minutes_left} min left!`,
  }),
  rider_assigned_push: (data: any) => ({
    push: `New delivery! #${data.order_number} — ${data.address}. COD: ₹${data.cod}. Accept within 45s.`,
  }),
};

async function getOrderContext(orderId: string) {
  return db('orders')
    .join('clients', 'orders.client_id', 'clients.id')
    .leftJoin('riders', 'orders.rider_id', 'riders.id')
    .leftJoin('zones', 'orders.zone_id', 'zones.id')
    .select(
      'orders.*',
      'clients.name as client_name',
      'clients.webhook_url',
      'clients.webhook_secret',
      'riders.name as rider_name',
      'riders.phone as rider_phone',
      'zones.name as zone_name',
    )
    .where('orders.id', orderId)
    .first();
}

// ─── Consumer: order.status_changed ──────────────────────────────────
async function handleStatusChanged(event: any) {
  const order = await getOrderContext(event.order_id);
  if (!order) return;

  const trackingUrl = `${process.env.TRACKING_BASE_URL}/${event.order_id}`;
  const etaMin = event.eta_seconds ? Math.ceil(event.eta_seconds / 60) : null;

  // Customer notifications
  const customerPhone = await decrypt(order.customer_phone);

  if (event.to_status === 'assigned') {
    const msgs = TEMPLATES.order_assigned({ ...order, tracking_url: trackingUrl });
    await Promise.allSettled([
      sendSMS(customerPhone, msgs.sms),
      sendWhatsApp(customerPhone, msgs.whatsapp),
    ]);

    // Rider push notification
    if (order.rider_id) {
      const riderFcmToken = await getRiderFcmToken(order.rider_id);
      if (riderFcmToken) {
        await sendPush(riderFcmToken, TEMPLATES.rider_assigned_push({
          order_number: order.order_number,
          address: order.drop_address,
          cod: order.cod_amount,
        }).push);
      }
    }
  }

  if (event.to_status === 'picked_up') {
    const msgs = TEMPLATES.order_picked_up({ ...order, tracking_url: trackingUrl, eta_min: etaMin });
    await Promise.allSettled([
      sendSMS(customerPhone, msgs.sms),
      sendWhatsApp(customerPhone, msgs.whatsapp),
    ]);
  }

  if (event.to_status === 'delivered') {
    const msgs = TEMPLATES.order_delivered(order);
    await Promise.allSettled([
      sendSMS(customerPhone, msgs.sms),
      sendWhatsApp(customerPhone, msgs.whatsapp),
    ]);
  }

  if (event.to_status === 'failed') {
    const msgs = TEMPLATES.order_failed({ ...order, reason: event.metadata?.reason });
    await Promise.allSettled([
      sendSMS(customerPhone, msgs.sms),
      sendWhatsApp(customerPhone, msgs.whatsapp),
    ]);
  }

  // Webhook dispatch to client
  if (order.webhook_url) {
    await dispatchWebhook({
      clientId: order.client_id,
      webhookUrl: order.webhook_url,
      secret: order.webhook_secret,
      event: `order.${event.to_status}`,
      orderId: event.order_id,
      payload: {
        event: `order.${event.to_status}`,
        order_id: event.order_id,
        order_number: order.order_number,
        external_ref: order.external_ref,
        status: event.to_status,
        rider_id: event.rider_id,
        location: event.location,
        sla_deadline: event.sla_deadline,
        metadata: event.metadata,
        timestamp: new Date().toISOString(),
      },
    });
  }
}

// ─── Consumer: sla.breach_risk ────────────────────────────────────────
async function handleSlaBreachRisk(event: any) {
  const order = await getOrderContext(event.order_id);
  if (!order) return;

  // Push alert to all Control Tower users
  const ctUsers = await db('users').where({ role: 'control_tower', is_active: true });
  await Promise.allSettled(
    ctUsers.map(async (u: any) => {
      const token = await getUserFcmToken(u.id);
      if (token) {
        await sendPush(token, TEMPLATES.sla_breach({
          order_number: order.order_number,
          zone: order.zone_name,
          minutes_left: event.minutes_to_breach,
        }).push);
      }
    })
  );
}

// ─── Consumer: exception.auto_assign_failed ───────────────────────────
async function handleAutoAssignFailed(event: any) {
  const ctUsers = await db('users').where({ role: 'control_tower', is_active: true });
  const tlUsers = await db('users')
    .join('riders', 'users.id', 'riders.team_leader_id')
    .where('riders.zone_id', event.zone_id)
    .where('users.role', 'team_leader')
    .select('users.*');

  const allUsers = [...ctUsers, ...tlUsers];
  const message = `🚨 Auto-assign FAILED: Order ${event.order_id} in zone ${event.zone_id} after ${event.retries} retries. Manual assignment required!`;

  await Promise.allSettled(
    allUsers.map(async (u: any) => {
      const token = await getUserFcmToken(u.id);
      if (token) await sendPush(token, message);
    })
  );
}

// ─── Main ─────────────────────────────────────────────────────────────
async function main() {
  logger.info('Notification service starting...');

  const consumers = [
    kafka.consume(TOPICS.ORDERS_STATUS_CHANGED, 'notification-svc', handleStatusChanged),
    kafka.consume(TOPICS.SLA_BREACH_RISK, 'notification-svc', handleSlaBreachRisk),
    kafka.consume(TOPICS.EXCEPTIONS_AUTO_ASSIGN_FAILED, 'notification-svc', handleAutoAssignFailed),
  ];

  await Promise.all(consumers);
}

async function decrypt(encrypted: string): Promise<string> {
  // AES-256-GCM decryption — key from env
  return encrypted; // placeholder — implement with node:crypto
}

async function getRiderFcmToken(riderId: string): Promise<string | null> {
  const result = await db('riders').where({ id: riderId }).select('fcm_token').first();
  return result?.fcm_token ?? null;
}

async function getUserFcmToken(userId: string): Promise<string | null> {
  const result = await db('users').where({ id: userId }).select('fcm_token').first();
  return result?.fcm_token ?? null;
}

main().catch(err => {
  logger.error('Fatal error:', err);
  process.exit(1);
});
