-- Dev seed data for FleetOS

-- Zones
INSERT INTO zones (id, name, city, is_active) VALUES
  ('a1b2c3d4-0001-0001-0001-000000000001', 'Zone A - Central', 'Delhi', true),
  ('a1b2c3d4-0002-0002-0002-000000000002', 'Zone B - North', 'Delhi', true),
  ('a1b2c3d4-0003-0003-0003-000000000003', 'Zone C - South', 'Delhi', true)
ON CONFLICT DO NOTHING;

-- Admin user (password: Admin@1234)
INSERT INTO users (id, role, name, email, password_hash, is_active) VALUES
  ('u0000001-0000-0000-0000-000000000001', 'admin', 'Super Admin', 'admin@fleetos.io',
   '$2b$10$rBqEbN5cVzKxJD0PzBNH8.kV1j5K2vNq3X9y8L4mZtPwGHNiC7UbC', true)
ON CONFLICT (email) DO NOTHING;

-- Manager user (password: Manager@1234)
INSERT INTO users (id, role, name, email, password_hash, is_active) VALUES
  ('u0000002-0000-0000-0000-000000000002', 'manager', 'Ops Manager', 'manager@fleetos.io',
   '$2b$10$rBqEbN5cVzKxJD0PzBNH8.kV1j5K2vNq3X9y8L4mZtPwGHNiC7UbC', true)
ON CONFLICT (email) DO NOTHING;

-- Control Tower (password: CT@1234)
INSERT INTO users (id, role, name, email, password_hash, is_active) VALUES
  ('u0000003-0000-0000-0000-000000000003', 'control_tower', 'Control Tower 1', 'ct@fleetos.io',
   '$2b$10$rBqEbN5cVzKxJD0PzBNH8.kV1j5K2vNq3X9y8L4mZtPwGHNiC7UbC', true)
ON CONFLICT (email) DO NOTHING;

-- Sample client (Zomato)
INSERT INTO clients (id, name, email, sla_minutes, is_active) VALUES
  ('c0000001-0000-0000-0000-000000000001', 'Zomato', 'ops@zomato.com', 30, true)
ON CONFLICT DO NOTHING;

-- Client user (password: Client@1234)
INSERT INTO users (id, client_id, role, name, email, password_hash, is_active) VALUES
  ('u0000004-0000-0000-0000-000000000004', 'c0000001-0000-0000-0000-000000000001',
   'client', 'Zomato Ops', 'client@fleetos.io',
   '$2b$10$rBqEbN5cVzKxJD0PzBNH8.kV1j5K2vNq3X9y8L4mZtPwGHNiC7UbC', true)
ON CONFLICT (email) DO NOTHING;

-- Sample riders
INSERT INTO riders (id, zone_id, name, phone, vehicle_type, status, rating, is_active) VALUES
  ('r0000001-0000-0000-0000-000000000001', 'a1b2c3d4-0001-0001-0001-000000000001', 'Ravi Kumar', '+919811111111', 'bike', 'offline', 4.8, true),
  ('r0000002-0000-0000-0000-000000000002', 'a1b2c3d4-0002-0002-0002-000000000002', 'Priya Mehta', '+919822222222', 'bike', 'offline', 4.7, true),
  ('r0000003-0000-0000-0000-000000000003', 'a1b2c3d4-0003-0003-0003-000000000003', 'Amit Sharma', '+919833333333', 'bike', 'offline', 4.2, true)
ON CONFLICT DO NOTHING;

SELECT 'Seed complete ✅' as status;
