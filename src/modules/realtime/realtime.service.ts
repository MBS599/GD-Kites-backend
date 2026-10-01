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
    const rooms = ['admins', `user:${order.customerId}`];
    const d = order.delivery;
    if (d && d.status !== 'CANCELLED') rooms.push(`driver:${d.driverId}`);
    this.server?.to(rooms).emit('order:updated', { order: orderOut(order) });
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

  driverLocation(driverId: string, customerIds: string[], payload: { lat: number; lng: number; at: string }) {
    const rooms = ['admins', ...customerIds.map((id) => `user:${id}`)];
    this.server?.to(rooms).emit('driver:location', { driverId, ...payload });
  }
}
