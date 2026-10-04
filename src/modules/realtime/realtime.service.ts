import { Injectable } from '@nestjs/common';
import type { Server } from 'socket.io';
import { driverOut, orderOut, type DriverWithUser, type FullOrder } from '../../common/serializers';

/**
 * Rooms: `user:<userId>`, `driver:<driverProfileId>`, `admins`.
 * Server → client events: order:updated, order:revoked, catalog:updated,
 * driver:updated, driver:location.
 */
@Injectable()
export class RealtimeService {
  private server: Server | null = null;

  attach(server: Server) {
    this.server = server;
  }

  orderUpdated(order: FullOrder) {
    // Only admins get the driver's position; the customer and driver get the order without it.
    this.server?.to('admins').emit('order:updated', { order: orderOut(order, { driverLocation: true }) });
    const rooms = [`user:${order.customerId}`];
    const d = order.delivery;
    if (d && d.status !== 'CANCELLED') rooms.push(`driver:${d.driverId}`);
    this.server?.to(rooms).except('admins').emit('order:updated', { order: orderOut(order) });
  }

  /** Tell a previously assigned driver the order is no longer theirs. */
  orderRevoked(driverId: string, orderId: string) {
    this.server?.to(`driver:${driverId}`).emit('order:revoked', { orderId });
  }

  catalogUpdated(productId: string) {
    this.server?.emit('catalog:updated', { productId });
  }

  driverUpdated(driver: DriverWithUser) {
    this.server?.to(['admins', `driver:${driver.id}`]).emit('driver:updated', { driver: driverOut(driver) });
  }

  /** Live positions go to admins only (and back to the driver's own devices). */
  driverLocation(driverId: string, payload: { lat: number; lng: number; at: string }) {
    this.server?.to(['admins', `driver:${driverId}`]).emit('driver:location', { driverId, ...payload });
  }
}
