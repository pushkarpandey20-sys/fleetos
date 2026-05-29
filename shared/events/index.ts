// shared/events/index.ts
// Kafka event schemas — single source of truth for all services

export type OrderStatus =
  | 'placed'
  | 'assigned'
  | 'picked_up'
  | 'in_transit'
  | 'delivered'
  | 'failed'
  | 'rto';

export type RiderStatus = 'offline' | 'available' | 'busy' | 'break';

export interface GeoPoint {
  lat: number;
  lng: number;
}

// ─── Order Events ───────────────────────────────────────────────────
export interface OrderCreatedEvent {
  event_id: string;
  event_type: 'order.created';
  schema_ver: '1.0';
  produced_at: string;
  order_id: string;
  client_id: string;
  zone_id: string;
  pickup: GeoPoint & { address: string };
  dropoff: GeoPoint & { address: string };
  customer: { name: string; phone: string };
  cod_amount: number;
  weight_kg: number;
  sla_minutes: number;
  sla_deadline: string;
  external_ref?: string;
}

export interface OrderAssignedEvent {
  event_id: string;
  event_type: 'order.assigned';
  schema_ver: '1.0';
  produced_at: string;
  order_id: string;
  client_id: string;
  rider_id: string;
  zone_id: string;
  sla_deadline: string;
  eta_seconds: number;
}

export interface OrderStatusChangedEvent {
  event_id: string;
  event_type: 'order.status_changed';
  schema_ver: '1.2';
  produced_at: string;
  order_id: string;
  client_id: string;
  rider_id: string | null;
  from_status: OrderStatus;
  to_status: OrderStatus;
  location: GeoPoint | null;
  sla_deadline: string;
  eta_seconds: number | null;
  metadata: {
    reason?: string;
    attempt: number;
    pod_image_url?: string;
    pod_signature_url?: string;
  };
}

export interface OrderDeliveredEvent {
  event_id: string;
  event_type: 'order.delivered';
  schema_ver: '1.0';
  produced_at: string;
  order_id: string;
  client_id: string;
  rider_id: string;
  external_ref?: string;
  delivered_at: string;
  cod_collected: boolean;
  cod_amount: number;
  pod_image_url: string;
  pod_signature_url: string;
  delivery_location: GeoPoint;
  sla_met: boolean;
  attempt_number: number;
}

export interface OrderFailedEvent {
  event_id: string;
  event_type: 'order.failed';
  schema_ver: '1.0';
  produced_at: string;
  order_id: string;
  client_id: string;
  rider_id: string;
  reason: string;
  attempt_number: number;
  rto_initiated: boolean;
}

// ─── Rider Events ───────────────────────────────────────────────────
export interface RiderLocationEvent {
  event_id: string;
  event_type: 'rider.location_update';
  schema_ver: '1.0';
  produced_at: string;
  rider_id: string;
  lat: number;
  lng: number;
  accuracy_m: number;
  speed_kmh: number;
  heading_deg: number;
  battery_pct: number;
}

export interface RiderStatusChangedEvent {
  event_id: string;
  event_type: 'rider.status_changed';
  schema_ver: '1.0';
  produced_at: string;
  rider_id: string;
  zone_id: string;
  from_status: RiderStatus;
  to_status: RiderStatus;
}

// ─── Exception Events ───────────────────────────────────────────────
export interface AutoAssignFailedEvent {
  event_id: string;
  event_type: 'exception.auto_assign_failed';
  schema_ver: '1.0';
  produced_at: string;
  order_id: string;
  client_id: string;
  zone_id: string;
  retries: number;
  last_radius_m: number;
}

export interface SlaBreachRiskEvent {
  event_id: string;
  event_type: 'sla.breach_risk';
  schema_ver: '1.0';
  produced_at: string;
  order_id: string;
  client_id: string;
  rider_id: string;
  sla_deadline: string;
  eta_seconds: number;
  minutes_to_breach: number;
}

// ─── Kafka Topic Map ─────────────────────────────────────────────────
export const TOPICS = {
  ORDERS_CREATED: 'orders.created',
  ORDERS_ASSIGNED: 'orders.assigned',
  ORDERS_STATUS_CHANGED: 'orders.status_changed',
  ORDERS_DELIVERED: 'orders.delivered',
  ORDERS_FAILED: 'orders.failed',
  RIDERS_LOCATION: 'riders.location',
  RIDERS_STATUS_CHANGED: 'riders.status_changed',
  EXCEPTIONS_AUTO_ASSIGN_FAILED: 'exceptions.auto_assign_failed',
  EXCEPTIONS_RAISED: 'exceptions.raised',
  NOTIFICATIONS_OUTBOUND: 'notifications.outbound',
  BILLING_COD_COLLECTED: 'billing.cod_collected',
  ANALYTICS_EVENTS: 'analytics.events',
  SLA_BREACH_RISK: 'sla.breach_risk',
  SLA_BREACHED: 'sla.breached',
} as const;
