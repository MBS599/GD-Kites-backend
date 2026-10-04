import type {
  Address,
  Category,
  Delivery,
  DriverProfile,
  Order,
  OrderItem,
  OrderStatusHistory,
  Payment,
  Prisma,
  Product,
  ServiceArea,
  Size,
  User,
  VehicleType,
} from '@prisma/client';
import { driverTariffOf } from './rates';
import { contains } from '../domain/geofence';
import { etaMinutes } from '../domain/pricing';

/**
 * API contract. Field names and enum spellings match the Flutter models
 * (lib/shared/models): enums are lowerCamelCase, money is a JSON number
 * in rupees, dates are ISO-8601 UTC.
 */
export const camel = (v: string) => v.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
export const upperSnake = (v: string) => v.replace(/([A-Z])/g, '_$1').toUpperCase();

export const money = (d: Prisma.Decimal | null | undefined): number | null => (d == null ? null : d.toNumber());
const m = (d: Prisma.Decimal) => d.toNumber();

export type UserWithDriver = User & { driverProfile: DriverProfile | null };
export type DriverWithUser = DriverProfile & {
  user: User;
  serviceArea: ServiceArea | null;
  vehicleType: VehicleType | null;
};
export type ProductWithCategory = Product & { category: Category; size: Size | null };
export type FullOrder = Order & {
  items: OrderItem[];
  history: OrderStatusHistory[];
  delivery: (Delivery & { driver: DriverWithUser }) | null;
  serviceArea: ServiceArea | null;
  payments?: Payment[];
};

export const productInclude = { category: true, size: true } as const;

/** What customers see: the name with its size, e.g. "Fighter Kite (Medium)". */
export const productDisplayName = (p: { name: string; size?: { name: string } | null }) =>
  p.size ? `${p.name} (${p.size.name})` : p.name;

export function sizeOut(s: Size) {
  return { id: s.id, name: s.name, sortOrder: s.sortOrder, isActive: s.isActive };
}
export const driverInclude = { user: true, serviceArea: true, vehicleType: true } as const;

export function vehicleTypeOut(v: VehicleType) {
  return { id: v.id, name: v.name, baseFare: m(v.baseFare), perKm: m(v.perKm), isActive: v.isActive };
}
export const orderInclude = {
  items: true,
  history: true,
  serviceArea: true,
  delivery: { include: { driver: { include: driverInclude } } },
  payments: { orderBy: { createdAt: 'desc' } },
} as const;

/** The payment that tells the story: the successful/refunded one, else the latest attempt. */
function paymentOut(payments: Payment[] | undefined) {
  if (!payments?.length) return null;
  const p = payments.find((x) => x.status !== 'CREATED' && x.status !== 'FAILED') ?? payments[0];
  return {
    status: camel(p.status),
    amount: m(p.amount),
    method: p.method,
    reference: p.providerPaymentId,
    paidAt: p.paidAt?.toISOString() ?? null,
    refundedAt: p.refundedAt?.toISOString() ?? null,
    error: p.error,
  };
}

export function serviceAreaOut(a: ServiceArea) {
  return {
    id: a.id,
    name: a.name,
    city: a.city,
    center: { lat: a.centerLat, lng: a.centerLng },
    radiusKm: a.radiusKm,
    hub: { name: a.hubName, lat: a.hubLat, lng: a.hubLng },
    isActive: a.isActive,
    rates: {
      deliveryBaseCharge: m(a.deliveryBaseCharge),
      deliveryPerKm: m(a.deliveryPerKm),
    },
  };
}

/** Compact area reference embedded in addresses, orders and drivers. */
const areaRef = (a: ServiceArea | null | undefined) =>
  a ? { id: a.id, name: a.name, hub: { name: a.hubName, lat: a.hubLat, lng: a.hubLng } } : null;

export const orderCode = (n: number) => `GD${n}`;

export function userOut(u: UserWithDriver) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    phone: u.phone,
    phoneVerified: u.phoneVerified !== null,
    businessName: u.businessName,
    photoUrl: u.photoUrl,
    role: camel(u.role),
    driverId: u.driverProfile?.id ?? null,
    smsEnabled: u.smsEnabled,
  };
}

export function categoryOut(c: Category) {
  return { id: c.id, slug: c.slug, name: c.name, sortOrder: c.sortOrder };
}

/** [cost]: include the cost price — admins only, never customers. */
export function productOut(p: ProductWithCategory, { cost = false }: { cost?: boolean } = {}) {
  return {
    id: p.id,
    name: p.name,
    /** Name with size, for customers and order lines. */
    displayName: productDisplayName(p),
    category: p.category.slug,
    categoryName: p.category.name,
    price: m(p.price),
    ...(cost ? { costPrice: money(p.costPrice) } : {}),
    unit: p.unit,
    inStock: p.inStock,
    isDamaged: p.isDamaged,
    damageNote: p.damageNote,
    description: p.description,
    material: p.material,
    size: p.size ? { id: p.size.id, name: p.size.name } : null,
    slabQty: p.slabQty,
    slabPrice: money(p.slabPrice),
    imageUrl: p.imageUrl,
    rating: p.rating,
    buyerCount: p.buyerCount,
  };
}

/**
 * `serviceable` is re-evaluated on every read: an address saved while an area
 * was active becomes unserviceable if the admin later deactivates or shrinks it.
 */
export function addressOut(a: Address & { serviceArea?: ServiceArea | null }) {
  const area = a.serviceArea ?? null;
  return {
    id: a.id,
    label: a.label,
    area: a.area,
    line: a.line,
    city: a.city,
    pincode: a.pincode,
    location: { lat: a.lat, lng: a.lng },
    distanceKm: a.distanceKm,
    contactName: a.contactName,
    contactPhone: a.contactPhone,
    serviceArea: areaRef(area),
    serviceable: !!area && area.isActive && contains(area, a.lat, a.lng),
  };
}

export function driverOut(d: DriverWithUser, counts?: { activeDeliveries?: number; deliveriesToday?: number }) {
  return {
    id: d.id,
    userId: d.userId,
    name: d.user.name,
    phone: d.user.phone ?? '',
    email: d.user.email,
    type: camel(d.type),
    availability: camel(d.availability),
    vehicleNumber: d.vehicleNumber,
    vehicleType: d.vehicleType ? vehicleTypeOut(d.vehicleType) : null,
    customFare:
      d.customBaseFare != null && d.customPerKm != null
        ? { baseFare: m(d.customBaseFare), perKm: m(d.customPerKm) }
        : null,
    /** The rate actually used for this driver's fares. */
    fare: (() => {
      const { tariff, source } = driverTariffOf(d);
      return { baseFare: tariff.base, perKm: tariff.perKm, source };
    })(),
    hub: d.serviceArea?.hubName ?? d.hub,
    serviceArea: areaRef(d.serviceArea),
    lastLocation:
      d.lastLat != null && d.lastLng != null
        ? { lat: d.lastLat, lng: d.lastLng, at: d.lastLocationAt?.toISOString() ?? null }
        : null,
    activeDeliveries: counts?.activeDeliveries ?? 0,
    deliveriesToday: counts?.deliveriesToday ?? 0,
  };
}

/**
 * [driverLocation]: include the delivery person's last position — for admins only.
 * Customers follow their order by status; drivers do bulk runs with many stops.
 */
export function orderOut(o: FullOrder, { driverLocation = false }: { driverLocation?: boolean } = {}) {
  const d = o.delivery;
  const activeDelivery = d && d.status !== 'CANCELLED' ? d : null;
  return {
    id: o.id,
    code: orderCode(o.number),
    serviceArea: areaRef(o.serviceArea),
    customerId: o.customerId,
    customerName: o.contactName,
    customerPhone: o.contactPhone,
    status: camel(o.status),
    paymentMethod: camel(o.paymentMethod),
    items: o.items.map((i) => ({
      productId: i.productId,
      name: i.productName,
      unit: i.unit,
      qty: i.qty,
      unitPrice: m(i.unitPrice),
      lineTotal: m(i.lineTotal),
    })),
    subtotal: m(o.subtotal),
    deliveryCharge: m(o.deliveryCharge),
    /** Online payment only: GST on the delivery charge and the gateway fee (both included in total). */
    deliveryTax: m(o.deliveryTax),
    paymentFee: m(o.paymentFee),
    total: m(o.total),
    /** Paid online (the delivery charge); the rest is cash on delivery. */
    paidOnline: m(o.paidOnline),
    dueOnDelivery: m(o.total.sub(o.paidOnline)),
    paymentDueBy: o.paymentDueBy?.toISOString() ?? null,
    payment: paymentOut(o.payments),
    address: {
      id: o.addressId ?? `order-${o.id}`,
      label: o.addrLabel,
      area: o.addrArea,
      line: o.addrLine,
      city: o.addrCity,
      pincode: o.addrPincode,
      location: { lat: o.addrLat, lng: o.addrLng },
      distanceKm: o.distanceKm,
      contactName: o.contactName,
      contactPhone: o.contactPhone,
    },
    etaMinutes: etaMinutes(o.distanceKm),
    driver: activeDelivery
      ? { ...driverOut(activeDelivery.driver), ...(driverLocation ? {} : { lastLocation: null }) }
      : null,
    driverFare: activeDelivery ? m(activeDelivery.fare) : null,
    deliveryStatus: d ? camel(d.status) : null,
    rejectionReason: o.rejectionReason,
    placedAt: o.placedAt.toISOString(),
    deliveredAt: o.deliveredAt?.toISOString() ?? null,
    history: [...o.history]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((e) => ({ status: camel(e.status), at: e.createdAt.toISOString(), note: e.note })),
    proof:
      d && d.status === 'DELIVERED'
        ? {
            photoUrls: d.proofPhotoUrls,
            customerReceived: d.customerReceived ?? false,
            cashCollected: d.cashCollected ?? false,
            at: (d.completedAt ?? o.updatedAt).toISOString(),
          }
        : null,
  };
}
