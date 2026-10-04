import type { OrderStatus, Role } from '@prisma/client';

export type OrderAction = 'confirm' | 'assign' | 'reject' | 'cancel' | 'start' | 'complete';

interface Rule {
  from: OrderStatus[];
  to: OrderStatus;
  roles: Role[];
}

/**
 * Single source of truth for order transitions, shared by every role.
 *
 * [AWAITING_PAYMENT →] PENDING → CONFIRMED → ASSIGNED → OUT_FOR_DELIVERY → DELIVERED
 * AWAITING_PAYMENT → PENDING happens when the online delivery-charge payment succeeds.
 * Admin may reject before dispatch; a customer may cancel while unpaid or PENDING.
 * `assign` on an ASSIGNED order re-assigns the driver.
 */
export const ORDER_RULES: Record<OrderAction, Rule> = {
  confirm: { from: ['PENDING'], to: 'CONFIRMED', roles: ['ADMIN'] },
  assign: { from: ['CONFIRMED', 'ASSIGNED'], to: 'ASSIGNED', roles: ['ADMIN'] },
  reject: { from: ['PENDING', 'CONFIRMED', 'ASSIGNED'], to: 'CANCELLED', roles: ['ADMIN'] },
  cancel: { from: ['AWAITING_PAYMENT', 'PENDING'], to: 'CANCELLED', roles: ['CUSTOMER'] },
  start: { from: ['ASSIGNED'], to: 'OUT_FOR_DELIVERY', roles: ['DRIVER'] },
  complete: { from: ['OUT_FOR_DELIVERY'], to: 'DELIVERED', roles: ['DRIVER'] },
};

export const STATUS_LABELS: Record<OrderStatus, string> = {
  AWAITING_PAYMENT: 'Awaiting payment',
  PENDING: 'Pending',
  CONFIRMED: 'Confirmed',
  ASSIGNED: 'Assigned',
  OUT_FOR_DELIVERY: 'Out for Delivery',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
};

export type TransitionCheck = { ok: true; to: OrderStatus } | { ok: false; reason: string };

export function checkTransition(action: OrderAction, current: OrderStatus, role: Role): TransitionCheck {
  const rule = ORDER_RULES[action];
  if (!rule.roles.includes(role)) {
    return { ok: false, reason: `Only ${rule.roles.join('/').toLowerCase()} can ${action} an order.` };
  }
  if (!rule.from.includes(current)) {
    return {
      ok: false,
      reason: `Cannot ${action} an order that is ${STATUS_LABELS[current].toLowerCase()}.`,
    };
  }
  return { ok: true, to: rule.to };
}

