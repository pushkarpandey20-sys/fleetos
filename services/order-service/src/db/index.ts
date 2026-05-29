import knex from 'knex';
import dotenv from 'dotenv';
dotenv.config({ path: '../../../.env' });

const DATABASE_URL = process.env.DATABASE_URL || '';
const isNeon = DATABASE_URL.includes('neon.tech');

export const db = knex({
  client: 'pg',
  connection: {
    connectionString: DATABASE_URL,
    ssl: isNeon ? { rejectUnauthorized: false } : false,
  },
  pool: { min: 0, max: 10 },
});
