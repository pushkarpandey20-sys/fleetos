import dotenv from 'dotenv';
dotenv.config({ path: '../../../.env' });
import app from './app';

const PORT = process.env.PORT || process.env.ORDER_SERVICE_PORT || 3001;

const server = app.listen(PORT, () => {
  console.log(`\n🚀 FleetOS Order Service`);
  console.log(`   Port:    ${PORT}`);
  console.log(`   Health:  /health`);
  console.log(`   Orders:  /v1/orders`);
  console.log(`   Auth:    /v1/auth/login`);
  console.log(`   Track:   /v1/track/:id\n`);
});

process.on('unhandledRejection', (err: any) => {
  console.error('Unhandled rejection:', err?.message || err);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  server.close(() => process.exit(0));
});

export default server;
