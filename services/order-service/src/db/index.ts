import knex from 'knex';
import dotenv from 'dotenv';
dotenv.config({ path: '../../../.env' });

export const db = knex({
  client: 'pg',
  connection: process.env.DATABASE_URL || 'postgresql://fleetos:fleetos_dev_pass@localhost:5432/fleetos',
  pool: { min: 2, max: 20 },
});
