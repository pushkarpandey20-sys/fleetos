import dotenv from 'dotenv';
dotenv.config({ path: '../../../.env' });
import app from './app';

const PORT = process.env.ORDER_SERVICE_PORT || 3001;

app.listen(PORT, () => {
  console.log(`\n🚀 Order Service running on http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Orders: http://localhost:${PORT}/v1/orders`);
  console.log(`   Track:  http://localhost:${PORT}/v1/track/:id\n`);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  process.exit(1);
});
