// Vercel serverless entry point
const path = require('path');

// Register ts-node for TypeScript support
require('ts-node').register({
  project: path.join(__dirname, '../services/order-service/tsconfig.json'),
  transpileOnly: true,
  skipLibCheck: true,
});

// Import the Express app
const app = require('../services/order-service/src/app').default;

module.exports = app;
