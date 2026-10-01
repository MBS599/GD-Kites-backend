import { Prisma } from '@prisma/client';

type Priced = { price: Prisma.Decimal; slabQty: number | null; slabPrice: Prisma.Decimal | null };

/** Unit price for a quantity, applying the wholesale slab (> slabQty). */
export function unitPrice(p: Priced, qty: number): Prisma.Decimal {
  if (p.slabQty != null && p.slabPrice != null && qty > p.slabQty) return p.slabPrice;
  return p.price;
}

export function lineTotal(p: Priced, qty: number): Prisma.Decimal {
  return unitPrice(p, qty).mul(qty);
}
