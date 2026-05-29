-- FleetOS Password Reset
-- Run this in Neon SQL Editor to reset all passwords to Admin@1234
-- Hash below is bcrypt of "Admin@1234" compatible with bcryptjs

UPDATE users 
SET password_hash = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy'
WHERE email IN (
  'admin@fleetos.io',
  'manager@fleetos.io', 
  'ct@fleetos.io',
  'tl@fleetos.io',
  'client@fleetos.io'
);

-- Verify
SELECT email, role, is_active FROM users ORDER BY role;
