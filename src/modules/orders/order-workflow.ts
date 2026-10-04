import { ConflictException } from '@nestjs/common';
import type { OrderStatus, PaymentMethod, Prisma, Role } from '@prisma/client';
import { checkTransition, type OrderAction } from '../../domain/orderStateMachine';
import { driverInclude } from '../../common/serializers';
import type { Tx } from '../../prisma/prisma.service';

/** Throws 409 when the action is not allowed for this role/status. */
export function assertTransition(action: OrderAction, status: OrderStatus, role: Role): OrderStatus {
  const check = checkTransition(action, status, role);
  if (!check.ok) throw new ConflictException(check.reason);
  return check.to;
}

/**
 * Moves an order from `from` to `to` only if nobody changed it meanwhile
 * (optimistic concurrency), and records the history entry.
 */
export async function moveOrder(
  tx: Tx,
  orderId: string,
  from: OrderStatus,
  to: OrderStatus,
  actorId: string | null,
  note?: string | null,
  extra: { rejectionReason?: string; deliveredAt?: Date; paidOnline?: Prisma.Decimal; paymentMethod?: PaymentMethod } = {},
) {
  const res = await tx.order.updateMany({ where: { id: orderId, status: from }, data: { status: to, ...extra } });
  if (res.count === 0) throw new ConflictException('This order was just updated by someone else. Refresh and try again.');
  await tx.orderStatusHistory.create({ data: { orderId, status: to, actorId, note: note ?? null } });
}

/** Sets a driver AVAILABLE/ON_DELIVERY from their in-transit deliveries (OFFLINE is left alone). */
export async function refreshDriverAvailability(tx: Tx, driverId: string) {
  const onRoad = await tx.delivery.count({ where: { driverId, status: 'IN_TRANSIT' } });
  const driver = await tx.driverProfile.findUniqueOrThrow({ where: { id: driverId }, include: driverInclude });
  if (driver.availability === 'OFFLINE') return driver;
  const next = onRoad > 0 ? 'ON_DELIVERY' : 'AVAILABLE';
  if (driver.availability === next) return driver;
  return tx.driverProfile.update({ where: { id: driverId }, data: { availability: next }, include: driverInclude });
}
