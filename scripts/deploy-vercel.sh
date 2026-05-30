#!/bin/bash
# FleetOS Vercel Deploy Script
cd ~/Desktop/fleetos/services/order-service

echo "Installing Vercel CLI..."
npx vercel@latest --version > /dev/null 2>&1

echo "Logging into Vercel (browser will open)..."
npx vercel@latest login

echo "Deploying to Vercel..."
npx vercel@latest deploy --prod   --env DATABASE_URL="postgresql://neondb_owner:npg_yTczHjle5V4F@ep-nameless-lake-ao0ngfmt-pooler.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require"   --env JWT_SECRET="fleetos_jwt_prod_secret_2026_changeme_now"   --env ENCRYPTION_KEY="fleetos_enc_32chars_prod!!2026ok"   --env NODE_ENV="production"   --env KAFKA_BROKERS=""   --yes 2>&1 | tee /tmp/vercel_deploy.log

echo ""
echo "Your Vercel URL:"
grep "https://" /tmp/vercel_deploy.log | grep "vercel.app" | tail -1
