#!/bin/bash
set -e
cd "$(dirname "$0")/.."
echo "🚀 Starting FleetOS dev environment..."

# Check Docker is running
if ! docker info &>/dev/null 2>&1; then
  echo "❌ Docker Desktop is not running."
  echo "   Please open Docker Desktop from your Applications folder, wait for it to start, then run this script again."
  exit 1
fi
echo "✅ Docker is running"

# Start infra
echo "⏳ Starting Postgres, Redis, Kafka..."
docker compose -f infra/docker/docker-compose.dev.yml up -d postgres redis zookeeper kafka

echo "⏳ Waiting 20s for services to be healthy..."
sleep 20

# Migrations
echo "📦 Running database migrations..."
docker compose -f infra/docker/docker-compose.dev.yml exec -T postgres \
  psql -U fleetos -d fleetos -f /docker-entrypoint-initdb.d/001_initial_schema.sql \
  2>&1 | grep -E "(CREATE|INSERT|ERROR|already exists)" | head -10 || true

echo "🌱 Seeding dev data..."
docker compose -f infra/docker/docker-compose.dev.yml exec -T postgres \
  psql -U fleetos -d fleetos -c "
    INSERT INTO zones (id, name, city, is_active) VALUES
      ('a1b2c3d4-0001-0001-0001-000000000001','Zone A - Central','Delhi',true),
      ('a1b2c3d4-0002-0002-0002-000000000002','Zone B - North','Delhi',true),
      ('a1b2c3d4-0003-0003-0003-000000000003','Zone C - South','Delhi',true)
    ON CONFLICT DO NOTHING;
    INSERT INTO clients (id, name, email, sla_minutes, is_active) VALUES
      ('c0000001-0000-0000-0000-000000000001','Zomato','ops@zomato.com',30,true)
    ON CONFLICT DO NOTHING;
  " 2>&1 | tail -3 || true

echo ""
echo "🏃 Starting microservices..."

# Kill any existing service processes on these ports
for port in 3001 3002 3003 3004; do
  lsof -ti :$port | xargs kill -9 2>/dev/null || true
done

# Start each service in background
echo "   Starting Order Service on :3001..."
(cd services/order-service && npm run dev > /tmp/fleetos-order.log 2>&1) &
echo "   Starting Rider Service on :3002..."
(cd services/rider-service && npm run dev > /tmp/fleetos-rider.log 2>&1) &
echo "   Starting Notification Service on :3003..."
(cd services/notification-service && npm run dev > /tmp/fleetos-notify.log 2>&1) &
echo "   Starting Billing Service on :3004..."
(cd services/billing-service && npm run dev > /tmp/fleetos-billing.log 2>&1) &

sleep 8

echo ""
echo "═══════════════════════════════════════════"
echo "  ✅ FleetOS is LIVE"
echo "═══════════════════════════════════════════"
echo ""
echo "  Services:"
for port in 3001 3002 3003 3004; do
  if lsof -ti :$port &>/dev/null 2>&1; then
    echo "    ✅  :$port running"
  else
    echo "    ⚠️   :$port still starting (check log below)"
  fi
done
echo ""
echo "  Infrastructure:"
echo "    Postgres  → localhost:5432"
echo "    Redis     → localhost:6379"
echo "    Kafka     → localhost:9092"
echo "    Kafka UI  → http://localhost:8090"
echo ""
echo "  API:"
echo "    Health    → http://localhost:3001/health"
echo "    Orders    → http://localhost:3001/v1/orders"
echo "    Track     → http://localhost:3001/v1/track/:id"
echo "    Riders    → http://localhost:3002/v1/riders"
echo "    Live SSE  → http://localhost:3002/v1/live/stream"
echo ""
echo "  Test login:"
echo '    curl -s -X POST http://localhost:3001/v1/auth/login \'
echo '      -H "Content-Type: application/json" \'
echo '      -d '"'"'{"email":"admin@fleetos.io","password":"Admin@1234"}'"'"' | jq'
echo ""
echo "  Logs: tail -f /tmp/fleetos-order.log"
echo "        tail -f /tmp/fleetos-rider.log"
echo "═══════════════════════════════════════════"
wait
