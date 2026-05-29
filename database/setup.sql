-- FleetOS Complete Database Setup for Neon
-- Run this entire file in Neon SQL Editor

-- Extensions (pgcrypto only - Neon free tier compatible)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Enums
CREATE TYPE order_status AS ENUM (
  'placed', 'assigned', 'picked_up', 'in_transit',
  'delivered', 'failed', 'rto'
);
CREATE TYPE rider_status AS ENUM ('offline', 'available', 'busy', 'break');
CREATE TYPE vehicle_type AS ENUM ('bike', 'cycle', 'van', 'car');
CREATE TYPE user_role AS ENUM (
  'admin', 'manager', 'control_tower', 'team_leader', 'client', 'rider'
);
CREATE TYPE notification_channel AS ENUM (
  'sms', 'whatsapp', 'email', 'push', 'webhook'
);

-- Zones
CREATE TABLE IF NOT EXISTS zones (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       VARCHAR(100) NOT NULL,
  city       VARCHAR(100) NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Clients
CREATE TABLE IF NOT EXISTS clients (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(200) NOT NULL,
  email           VARCHAR(200) NOT NULL UNIQUE,
  phone           VARCHAR(20),
  sla_minutes     INT NOT NULL DEFAULT 60,
  webhook_url     TEXT,
  webhook_secret  VARCHAR(64),
  api_key_hash    VARCHAR(128),
  rate_limit_rpm  INT NOT NULL DEFAULT 600,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Users
CREATE TABLE IF NOT EXISTS users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      UUID REFERENCES clients(id) ON DELETE SET NULL,
  role           user_role NOT NULL,
  name           VARCHAR(120) NOT NULL,
  email          VARCHAR(200) NOT NULL UNIQUE,
  password_hash  VARCHAR(128) NOT NULL,
  refresh_token  VARCHAR(256),
  is_active      BOOLEAN NOT NULL DEFAULT true,
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Riders (no PostGIS - use lat/lng columns only)
CREATE TABLE IF NOT EXISTS riders (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID REFERENCES users(id) ON DELETE SET NULL,
  team_leader_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  zone_id          UUID NOT NULL REFERENCES zones(id),
  name             VARCHAR(120) NOT NULL,
  phone            VARCHAR(20) NOT NULL UNIQUE,
  vehicle_type     vehicle_type NOT NULL DEFAULT 'bike',
  vehicle_number   VARCHAR(20),
  status           rider_status NOT NULL DEFAULT 'offline',
  current_lat      DECIMAL(9,6),
  current_lng      DECIMAL(9,6),
  last_location_at TIMESTAMPTZ,
  rating           NUMERIC(3,2) NOT NULL DEFAULT 5.00,
  pending_tasks    SMALLINT NOT NULL DEFAULT 0,
  shift_start_at   TIMESTAMPTZ,
  total_deliveries INT NOT NULL DEFAULT 0,
  fcm_token        TEXT,
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Orders
CREATE SEQUENCE IF NOT EXISTS order_number_seq START 10000;

CREATE TABLE IF NOT EXISTS orders (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number         VARCHAR(32) NOT NULL UNIQUE DEFAULT ('#ORD-' || LPAD(nextval('order_number_seq')::TEXT, 6, '0')),
  client_id            UUID NOT NULL REFERENCES clients(id),
  rider_id             UUID REFERENCES riders(id) ON DELETE SET NULL,
  zone_id              UUID NOT NULL REFERENCES zones(id),
  status               order_status NOT NULL DEFAULT 'placed',
  pickup_lat           DECIMAL(9,6) NOT NULL,
  pickup_lng           DECIMAL(9,6) NOT NULL,
  pickup_address       TEXT NOT NULL,
  drop_lat             DECIMAL(9,6) NOT NULL,
  drop_lng             DECIMAL(9,6) NOT NULL,
  drop_address         TEXT NOT NULL,
  customer_name        VARCHAR(120) NOT NULL,
  customer_phone       VARCHAR(200) NOT NULL,
  customer_otp         VARCHAR(6),
  cod_amount           NUMERIC(10,2) NOT NULL DEFAULT 0,
  weight_kg            NUMERIC(6,2) NOT NULL,
  special_instructions TEXT,
  external_ref         VARCHAR(100),
  sla_minutes          INT NOT NULL,
  sla_deadline         TIMESTAMPTZ NOT NULL,
  sla_met              BOOLEAN,
  attempt_count        SMALLINT NOT NULL DEFAULT 0,
  max_attempts         SMALLINT NOT NULL DEFAULT 3,
  pod_image_url        TEXT,
  pod_signature_url    TEXT,
  delivered_at         TIMESTAMPTZ,
  failure_reason       TEXT,
  dispatch_retries     SMALLINT NOT NULL DEFAULT 0,
  search_radius_m      INT NOT NULL DEFAULT 3000,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_orders_updated_at ON orders;
CREATE TRIGGER trg_orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_riders_updated_at ON riders;
CREATE TRIGGER trg_riders_updated_at
  BEFORE UPDATE ON riders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Order Status History
CREATE TABLE IF NOT EXISTS order_status_history (
  id         BIGSERIAL PRIMARY KEY,
  order_id   UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status order_status,
  to_status  order_status NOT NULL,
  changed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reason     TEXT,
  lat        DECIMAL(9,6),
  lng        DECIMAL(9,6),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rider Locations (plain table - no TimescaleDB on Neon free)
CREATE TABLE IF NOT EXISTS rider_locations (
  id         BIGSERIAL PRIMARY KEY,
  time       TIMESTAMPTZ NOT NULL DEFAULT now(),
  rider_id   UUID NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
  lat        DECIMAL(9,6) NOT NULL,
  lng        DECIMAL(9,6) NOT NULL,
  accuracy_m SMALLINT,
  speed_kmh  NUMERIC(5,1),
  heading_deg SMALLINT,
  battery_pct SMALLINT
);

-- Webhook deliveries
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              BIGSERIAL PRIMARY KEY,
  client_id       UUID NOT NULL REFERENCES clients(id),
  event_type      VARCHAR(60) NOT NULL,
  order_id        UUID REFERENCES orders(id),
  payload         JSONB NOT NULL,
  delivery_id     VARCHAR(36) NOT NULL UNIQUE,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',
  attempts        SMALLINT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  last_response   INT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Notifications
CREATE TABLE IF NOT EXISTS notifications (
  id         BIGSERIAL PRIMARY KEY,
  order_id   UUID REFERENCES orders(id),
  rider_id   UUID REFERENCES riders(id),
  channel    notification_channel NOT NULL,
  recipient  VARCHAR(200) NOT NULL,
  template   VARCHAR(60) NOT NULL,
  payload    JSONB NOT NULL,
  status     VARCHAR(20) NOT NULL DEFAULT 'queued',
  sent_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_orders_sla_active ON orders(sla_deadline) WHERE status NOT IN ('delivered','failed','rto');
CREATE INDEX IF NOT EXISTS idx_orders_client_created ON orders(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_zone_status ON orders(zone_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_rider_active ON orders(rider_id) WHERE status NOT IN ('delivered','failed','rto');
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_riders_zone_status ON riders(zone_id, status) WHERE status != 'offline';
CREATE INDEX IF NOT EXISTS idx_order_history_order ON order_status_history(order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rider_locations_rider ON rider_locations(rider_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_webhooks_pending ON webhook_deliveries(next_attempt_at) WHERE status IN ('pending','failed');

-- ─── Seed Data ────────────────────────────────────────────────────────

INSERT INTO zones (id, name, city, is_active) VALUES
  ('a1b2c3d4-0001-0001-0001-000000000001', 'Zone A - Central', 'Delhi', true),
  ('a1b2c3d4-0002-0002-0002-000000000002', 'Zone B - North', 'Delhi', true),
  ('a1b2c3d4-0003-0003-0003-000000000003', 'Zone C - South', 'Delhi', true)
ON CONFLICT DO NOTHING;

INSERT INTO clients (id, name, email, sla_minutes, is_active) VALUES
  ('c0000001-0000-0000-0000-000000000001', 'Zomato', 'ops@zomato.com', 30, true),
  ('c0000002-0000-0000-0000-000000000002', 'Swiggy', 'ops@swiggy.com', 25, true),
  ('c0000003-0000-0000-0000-000000000003', 'Blinkit', 'ops@blinkit.com', 15, true)
ON CONFLICT DO NOTHING;

-- password for all users: Admin@1234
INSERT INTO users (id, role, name, email, password_hash, is_active) VALUES
  ('u0000001-0000-0000-0000-000000000001', 'admin', 'Super Admin', 'admin@fleetos.io',
   '$2b$10$rBqEbN5cVzKxJD0PzBNH8.kV1j5K2vNq3X9y8L4mZtPwGHNiC7UbC', true),
  ('u0000002-0000-0000-0000-000000000002', 'manager', 'Ops Manager', 'manager@fleetos.io',
   '$2b$10$rBqEbN5cVzKxJD0PzBNH8.kV1j5K2vNq3X9y8L4mZtPwGHNiC7UbC', true),
  ('u0000003-0000-0000-0000-000000000003', 'control_tower', 'Control Tower', 'ct@fleetos.io',
   '$2b$10$rBqEbN5cVzKxJD0PzBNH8.kV1j5K2vNq3X9y8L4mZtPwGHNiC7UbC', true),
  ('u0000004-0000-0000-0000-000000000004', 'team_leader', 'Team Leader', 'tl@fleetos.io',
   '$2b$10$rBqEbN5cVzKxJD0PzBNH8.kV1j5K2vNq3X9y8L4mZtPwGHNiC7UbC', true)
ON CONFLICT (email) DO NOTHING;

INSERT INTO users (id, client_id, role, name, email, password_hash, is_active) VALUES
  ('u0000005-0000-0000-0000-000000000005', 'c0000001-0000-0000-0000-000000000001',
   'client', 'Zomato Ops', 'client@fleetos.io',
   '$2b$10$rBqEbN5cVzKxJD0PzBNH8.kV1j5K2vNq3X9y8L4mZtPwGHNiC7UbC', true)
ON CONFLICT (email) DO NOTHING;

INSERT INTO riders (id, zone_id, name, phone, vehicle_type, status, rating, is_active) VALUES
  ('r0000001-0000-0000-0000-000000000001', 'a1b2c3d4-0001-0001-0001-000000000001', 'Ravi Kumar',   '+919811111111', 'bike', 'offline', 4.8, true),
  ('r0000002-0000-0000-0000-000000000002', 'a1b2c3d4-0002-0002-0002-000000000002', 'Priya Mehta',  '+919822222222', 'bike', 'offline', 4.7, true),
  ('r0000003-0000-0000-0000-000000000003', 'a1b2c3d4-0003-0003-0003-000000000003', 'Amit Sharma',  '+919833333333', 'bike', 'offline', 4.2, true),
  ('r0000004-0000-0000-0000-000000000004', 'a1b2c3d4-0001-0001-0001-000000000001', 'Sneha Tiwari', '+919844444444', 'bike', 'offline', 4.9, true)
ON CONFLICT DO NOTHING;

SELECT 'FleetOS database setup complete!' as status,
  (SELECT COUNT(*) FROM zones) as zones,
  (SELECT COUNT(*) FROM users) as users,
  (SELECT COUNT(*) FROM clients) as clients,
  (SELECT COUNT(*) FROM riders) as riders;
