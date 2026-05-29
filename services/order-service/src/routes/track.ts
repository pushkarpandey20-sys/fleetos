import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../db';

export const trackRouter = Router();

// Public tracking — no auth required
trackRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const order = await db('orders')
      .leftJoin('riders', 'orders.rider_id', 'riders.id')
      .select(
        'orders.id', 'orders.order_number', 'orders.status',
        'orders.drop_address', 'orders.sla_deadline',
        'orders.delivered_at', 'orders.cod_amount',
        'riders.name as rider_name',
        'riders.current_lat as rider_lat',
        'riders.current_lng as rider_lng',
        'riders.last_location_at as rider_location_updated'
      )
      .where('orders.id', req.params.id)
      .orWhere('orders.order_number', req.params.id)
      .first();

    if (!order) return res.status(404).json({ error: 'Order not found' });

    const history = await db('order_status_history')
      .where({ order_id: order.id })
      .select('to_status as status', 'created_at as at')
      .orderBy('created_at', 'asc');

    const etaSeconds = order.rider_lat && order.status === 'in_transit'
      ? estimateEta(order.rider_lat, order.rider_lng, order.drop_lat, order.drop_lng)
      : null;

    res.json({
      order_number: order.order_number,
      status: order.status,
      status_label: statusLabel(order.status),
      rider: order.rider_name ? {
        name: order.rider_name,
        lat: order.rider_lat,
        lng: order.rider_lng,
        last_updated: order.rider_location_updated,
      } : null,
      eta_seconds: etaSeconds,
      eta_label: etaSeconds ? `~${Math.ceil(etaSeconds / 60)} minutes` : null,
      drop_address: order.drop_address,
      sla_deadline: order.sla_deadline,
      delivered_at: order.delivered_at,
      status_history: history,
      _links: { sse_stream: `/v1/live/order/${order.id}` },
    });
  } catch (err) { next(err); }
});

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    placed: 'Order received',
    assigned: 'Rider assigned, heading to pickup',
    picked_up: 'Order picked up',
    in_transit: 'Your order is on the way',
    delivered: 'Delivered successfully',
    failed: 'Delivery attempted',
    rto: 'Returning to origin',
  };
  return labels[status] || status;
}

function estimateEta(fromLat: number, fromLng: number, toLat: number, toLng: number): number {
  const R = 6371000;
  const dLat = (toLat - fromLat) * Math.PI / 180;
  const dLng = (toLng - fromLng) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(fromLat*Math.PI/180)*Math.cos(toLat*Math.PI/180)*Math.sin(dLng/2)**2;
  const distM = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return Math.round((distM / 1000 / 25) * 3600);
}
