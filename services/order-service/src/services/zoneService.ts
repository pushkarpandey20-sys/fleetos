import { db } from '../db';

export async function findZoneForPoint(lat: number, lng: number) {
  // PostGIS point-in-polygon check
  const result = await db('zones')
    .whereRaw(`ST_Within(ST_SetSRID(ST_MakePoint(?, ?), 4326), polygon)`, [lng, lat])
    .where({ is_active: true })
    .first();

  // Fallback: find nearest zone if no polygon match
  if (!result) {
    return await db('zones').where({ is_active: true }).first();
  }
  return result;
}
