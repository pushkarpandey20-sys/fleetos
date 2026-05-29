#!/bin/bash
# FleetOS — One command setup
# Works on Mac, Linux, Windows (WSL)
# Usage: bash scripts/setup.sh

set -e
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo "╔══════════════════════════════════════╗"
echo "║   FleetOS — Automated Setup          ║"
echo "╚══════════════════════════════════════╝"
echo ""

# Check Node
if ! command -v node &>/dev/null; then
  echo -e "${RED}❌ Node.js not found. Install from https://nodejs.org${NC}"
  exit 1
fi
echo -e "${GREEN}✅ Node.js $(node -v)${NC}"

# Check npm
echo -e "${GREEN}✅ npm $(npm -v)${NC}"

# Install deps for all services
echo ""
echo "📦 Installing dependencies..."
for svc in order-service rider-service notification-service billing-service; do
  echo "   Installing $svc..."
  (cd services/$svc && npm install --ignore-scripts --silent) && \
    echo -e "   ${GREEN}✅ $svc${NC}" || \
    echo -e "   ${YELLOW}⚠️  $svc (check manually)${NC}"
done

# Check Docker
echo ""
if docker info &>/dev/null 2>&1; then
  echo -e "${GREEN}✅ Docker is running${NC}"
  echo "🐳 Starting infrastructure..."
  docker compose -f infra/docker/docker-compose.dev.yml up -d postgres redis zookeeper kafka
  echo "⏳ Waiting for services..."
  sleep 20
  echo "📦 Running migrations..."
  docker compose -f infra/docker/docker-compose.dev.yml exec -T postgres \
    psql -U fleetos -d fleetos -f /docker-entrypoint-initdb.d/001_initial_schema.sql 2>&1 | tail -3 || true
  docker compose -f infra/docker/docker-compose.dev.yml exec -T postgres \
    psql -U fleetos -d fleetos -f /docker-entrypoint-initdb.d/../seeds/001_dev_seed.sql 2>&1 | tail -3 || true
  INFRA="docker"
else
  echo -e "${YELLOW}⚠️  Docker not running — using cloud DB instead${NC}"
  echo ""
  echo "You have two options:"
  echo "  A) Install Docker Desktop: https://www.docker.com/products/docker-desktop/"
  echo "  B) Use a free cloud DB (Neon.tech for Postgres, Upstash for Redis)"
  echo ""
  echo "For option B, get your connection strings and update .env:"
  echo "  DATABASE_URL=postgresql://..."
  echo "  REDIS_URL=redis://..."
  INFRA="cloud"
fi

# Start services
if [ "$INFRA" = "docker" ]; then
  echo ""
  echo "🏃 Starting services..."
  for port in 3001 3002 3003 3004; do
    lsof -ti :$port | xargs kill -9 2>/dev/null || true
  done
  (cd services/order-service && npm run dev > /tmp/fleetos-order.log 2>&1) &
  (cd services/rider-service && npm run dev > /tmp/fleetos-rider.log 2>&1) &
  (cd services/billing-service && npm run dev > /tmp/fleetos-billing.log 2>&1) &
  sleep 8
fi

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  ✅  FleetOS Setup Complete!                  ║"
echo "╠══════════════════════════════════════════════╣"
echo "║  Health   → http://localhost:3001/health     ║"
echo "║  Orders   → http://localhost:3001/v1/orders  ║"
echo "║  Riders   → http://localhost:3002/v1/riders  ║"
echo "║  Kafka UI → http://localhost:8090            ║"
echo "╠══════════════════════════════════════════════╣"
echo "║  Dev logins:                                 ║"
echo "║  admin@fleetos.io / Admin@1234               ║"
echo "║  manager@fleetos.io / Admin@1234             ║"
echo "║  ct@fleetos.io / Admin@1234                  ║"
echo "╠══════════════════════════════════════════════╣"
echo "║  Logs:                                       ║"
echo "║  tail -f /tmp/fleetos-order.log              ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
wait
