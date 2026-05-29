# FleetOS — Last Mile Delivery Platform

End-to-end last mile delivery management system with real-time rider tracking, live map, heat maps, role-based access control, and full API integration.

## 🚀 Quick Start (One Command)

```bash
# Clone
git clone https://github.com/YOUR_USERNAME/fleetos.git
cd fleetos

# Run everything
bash scripts/setup.sh
```

That's it. The script installs deps, starts Docker infra, runs migrations, seeds dev data, and boots all services.

## 📋 Manual Setup

### Prerequisites
- Node.js ≥ 20 → https://nodejs.org
- Docker Desktop → https://www.docker.com/products/docker-desktop/
- Go ≥ 1.21 (for dispatch engine) → https://go.dev

### Steps
```bash
# 1. Install dependencies
npm install --prefix services/order-service
npm install --prefix services/rider-service
npm install --prefix services/notification-service
npm install --prefix services/billing-service

# 2. Start infrastructure
docker compose -f infra/docker/docker-compose.dev.yml up -d

# 3. Run migrations (wait ~20s for postgres to start)
docker compose -f infra/docker/docker-compose.dev.yml exec postgres \
  psql -U fleetos -d fleetos -f /docker-entrypoint-initdb.d/001_initial_schema.sql

# 4. Start services
cd services/order-service && npm run dev   # :3001
cd services/rider-service && npm run dev   # :3002
cd services/billing-service && npm run dev # :3004
```

## 🌐 No Docker? Use Free Cloud Services

| Service  | Free Provider         | URL                    |
|----------|-----------------------|------------------------|
| Postgres | Neon.tech             | https://neon.tech      |
| Redis    | Upstash               | https://upstash.com    |
| Kafka    | Confluent Cloud       | https://confluent.io   |

Update `.env` with connection strings from those providers, then just run the services directly:
```bash
cd services/order-service && npm run dev
```

## 🔑 Dev Login Credentials

| Role          | Email                  | Password      |
|---------------|------------------------|---------------|
| Admin         | admin@fleetos.io       | Admin@1234    |
| Manager       | manager@fleetos.io     | Admin@1234    |
| Control Tower | ct@fleetos.io          | Admin@1234    |
| Client        | client@fleetos.io      | Admin@1234    |

## 📡 API Endpoints

```
POST   /v1/auth/login              Login
POST   /v1/auth/refresh            Refresh token
GET    /v1/orders                  List orders
POST   /v1/orders                  Create order
GET    /v1/orders/:id              Get order
PUT    /v1/orders/:id/status       Update status
GET    /v1/track/:id               Public tracking (no auth)
GET    /v1/riders                  List riders
GET    /v1/riders/:id/location     Live location
GET    /v1/live/stream             SSE live map feed
WS     /ws?token=<jwt>             Rider GPS WebSocket
```

## 🏗️ Architecture

```
┌─────────────────────────────────────────┐
│           Client Apps                    │
│  Web Dashboard · Rider App · Client API  │
└──────────────────┬──────────────────────┘
                   │
┌──────────────────▼──────────────────────┐
│         API Gateway (Kong)               │
│    JWT Auth · RBAC · Rate Limiting       │
└──────────────────┬──────────────────────┘
                   │
┌──────────────────▼──────────────────────┐
│            Microservices                 │
│  Order · Rider · Notification · Billing  │
│         Dispatch Engine (Go)             │
└──────┬───────────┬───────────┬──────────┘
       │           │           │
   Kafka        Redis       Postgres
  (events)   (live state)  (data)
```

## 📁 Project Structure

```
fleetos/
├── services/
│   ├── order-service/        Node.js — orders, auth, tracking
│   ├── rider-service/        Node.js — riders, GPS WebSocket, SSE
│   ├── notification-service/ Node.js — SMS, WhatsApp, push, webhooks
│   ├── billing-service/      Node.js — COD, invoices
│   └── dispatch-engine/      Go — auto-assign riders
├── apps/
│   └── rider-app/            React Native — iOS & Android
├── database/
│   ├── migrations/           PostgreSQL schema
│   └── seeds/                Dev seed data
├── infra/
│   ├── docker/               Docker Compose
│   └── k8s/                  Kubernetes manifests
├── shared/
│   └── events/               Kafka event types
├── scripts/
│   ├── setup.sh              One-command setup
│   └── start-dev.sh          Start dev environment
└── .github/workflows/        CI/CD
```

## 🚢 Deploy to Cloud

### Railway (easiest)
```bash
npm install -g @railway/cli
railway login
railway up
```

### Render
Push to GitHub → connect repo at https://render.com → deploy with render.yaml

### Kubernetes (production)
```bash
kubectl apply -f infra/k8s/
```
