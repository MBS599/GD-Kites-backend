import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type Offer } from '@prisma/client';
import { lineTotal } from '../../common/pricing';
import { PrismaService, type Tx } from '../../prisma/prisma.service';

/** Rupees an offer takes off a goods subtotal: never more than the goods, whole rupees for % offers. */
export function discountFor(o: Pick<Offer, 'kind' | 'value' | 'maxDiscount'>, subtotal: Prisma.Decimal): Prisma.Decimal {
  let off =
    o.kind === 'PERCENT' ? subtotal.mul(o.value).div(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_FLOOR) : new Prisma.Decimal(o.value);
  if (o.kind === 'PERCENT' && o.maxDiscount != null && off.gt(o.maxDiscount)) off = new Prisma.Decimal(o.maxDiscount);
  return off.gt(subtotal) ? subtotal : off;
}

/** Live now: switched on and inside its dates. */
export function isLive(o: Pick<Offer, 'isActive' | 'startsAt' | 'endsAt'>, now = new Date()) {
  return o.isActive && (!o.startsAt || o.startsAt <= now) && (!o.endsAt || o.endsAt > now);
}

const m = (d: Prisma.Decimal | null) => (d == null ? null : d.toNumber());

/** An offer as its customer sees it, with what it does for the cart right now. */
function customerOfferOut(o: Offer, usesLeft: number, subtotal: Prisma.Decimal) {
  const short = o.minOrder.sub(subtotal);
  const eligible = subtotal.gt(0) && !short.gt(0);
  return {
    id: o.id,
    title: o.title,
    description: o.description,
    kind: o.kind === 'PERCENT' ? 'percent' : 'flat',
    value: o.value.toNumber(),
    maxDiscount: m(o.maxDiscount),
    minOrder: o.minOrder.toNumber(),
    endsAt: o.endsAt?.toISOString() ?? null,
    usesLeft,
    /** Can be applied to the cart as it is now. */
    eligible,
    /** Rupees more of goods needed (0 when eligible or the cart is empty). */
    shortBy: subtotal.gt(0) && short.gt(0) ? short.toNumber() : 0,
    /** What it takes off the current cart. */
    discount: eligible ? discountFor(o, subtotal).toNumber() : 0,
  };
}

@Injectable()
export class OffersService {
  constructor(private readonly prisma: PrismaService) {}

  /** Orders (not cancelled) on which this customer used the offer. */
  private used(db: Tx | PrismaService, offerId: string, userId: string) {
    return db.order.count({ where: { offerId, customerId: userId, status: { not: 'CANCELLED' } } });
  }

  /** Goods subtotal of the customer's cart, from catalogue prices. */
  private async cartSubtotal(userId: string) {
    const cart = await this.prisma.cart.findUnique({ where: { userId }, include: { items: { include: { product: true } } } });
    return (cart?.items ?? [])
      .filter((i) => i.product.isActive)
      .reduce((s, i) => s.add(lineTotal(i.product, i.qty)), new Prisma.Decimal(0));
  }

  /** The customer's own live offers with uses left, best for the current cart first. */
  async mine(userId: string) {
    const now = new Date();
    const links = await this.prisma.offerCustomer.findMany({ where: { userId }, include: { offer: true } });
    const live = links.map((l) => l.offer).filter((o) => isLive(o, now));
    if (live.length === 0) return [];
    const [subtotal, used] = await Promise.all([
      this.cartSubtotal(userId),
      this.prisma.order.groupBy({
        by: ['offerId'],
        where: { customerId: userId, offerId: { in: live.map((o) => o.id) }, status: { not: 'CANCELLED' } },
        _count: { _all: true },
      }),
    ]);
    const usedBy = new Map(used.map((u) => [u.offerId, u._count._all]));
    return live
      .map((o) => customerOfferOut(o, Math.max(0, o.usesPerCustomer - (usedBy.get(o.id) ?? 0)), subtotal))
      .filter((o) => o.usesLeft > 0)
      .sort((a, b) => b.discount - a.discount || a.title.localeCompare(b.title));
  }

  /**
   * Checkout: the offer must be the customer's, live, with a use left and its minimum met.
   * Locks the customer's link row so two orders placed at once can't both use the last use.
   */
  async applyAtCheckout(tx: Tx, userId: string, offerId: string, subtotal: Prisma.Decimal) {
    const locked = await tx.$queryRaw<{ offerId: string }[]>`
      SELECT "offerId" FROM "OfferCustomer" WHERE "offerId" = ${offerId} AND "userId" = ${userId} FOR UPDATE`;
    const offer = locked.length ? await tx.offer.findUnique({ where: { id: offerId } }) : null;
    if (!offer) throw new NotFoundException('This offer is not available on your account.');
    if (!isLive(offer)) throw new ConflictException(`The offer "${offer.title}" has ended. Place the order without it.`);
    if ((await this.used(tx, offerId, userId)) >= offer.usesPerCustomer) {
      throw new ConflictException(`You have already used the offer "${offer.title}".`);
    }
    if (subtotal.lt(offer.minOrder)) {
      const short = offer.minOrder.sub(subtotal).toNumber().toLocaleString('en-IN');
      throw new ConflictException(`Add ₹${short} more of goods to use "${offer.title}".`);
    }
    return { offer, discount: discountFor(offer, subtotal) };
  }
}
