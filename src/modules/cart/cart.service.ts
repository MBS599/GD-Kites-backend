import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { lineTotal, unitPrice } from '../../common/pricing';
import { productInclude, productOut } from '../../common/serializers';
import { PrismaService } from '../../prisma/prisma.service';

const cartInclude = { items: { include: { product: { include: productInclude } }, orderBy: { addedAt: 'asc' } } } as const;
type CartWithItems = Prisma.CartGetPayload<{ include: typeof cartInclude }>;

@Injectable()
export class CartService {
  constructor(private readonly prisma: PrismaService) {}

  private async cartFor(userId: string): Promise<CartWithItems> {
    return this.prisma.cart.upsert({
      where: { userId },
      create: { userId },
      update: {},
      include: cartInclude,
    });
  }

  /** Current prices are always recomputed from the catalogue — nothing is trusted from the client. */
  private view(cart: CartWithItems) {
    const items = cart.items
      .filter((i) => i.product.isActive)
      .map((i) => ({
        product: productOut(i.product),
        qty: i.qty,
        unitPrice: unitPrice(i.product, i.qty).toNumber(),
        lineTotal: lineTotal(i.product, i.qty).toNumber(),
        outOfStock: !i.product.inStock,
      }));
    const subtotal = items.reduce((s, i) => s + i.lineTotal, 0);
    return {
      cart: {
        items,
        itemCount: items.length,
        subtotal,
        isValid: items.length > 0 && items.every((i) => !i.outOfStock),
      },
    };
  }

  async get(userId: string) {
    return this.view(await this.cartFor(userId));
  }

  /** Quantities are free (the minimum order value covers small carts); the product must be in stock. */
  private async validQty(productId: string, qty: number) {
    const p = await this.prisma.product.findFirst({ where: { id: productId, isActive: true } });
    if (!p) throw new NotFoundException('Product not found.');
    if (!p.inStock) throw new BadRequestException(`${p.name} is out of stock right now.`);
    if (qty < 1) throw new BadRequestException('Quantity must be at least 1.');
  }

  /** Adds [qty] to the existing line (or creates it). */
  async add(userId: string, productId: string, qty: number) {
    const cart = await this.cartFor(userId);
    const current = cart.items.find((i) => i.productId === productId)?.qty ?? 0;
    await this.validQty(productId, current + qty);
    await this.prisma.cartItem.upsert({
      where: { cartId_productId: { cartId: cart.id, productId } },
      create: { cartId: cart.id, productId, qty },
      update: { qty: { increment: qty } },
    });
    return this.get(userId);
  }

  /** Sets the line quantity exactly. */
  async set(userId: string, productId: string, qty: number) {
    const cart = await this.cartFor(userId);
    await this.validQty(productId, qty);
    await this.prisma.cartItem.upsert({
      where: { cartId_productId: { cartId: cart.id, productId } },
      create: { cartId: cart.id, productId, qty },
      update: { qty },
    });
    return this.get(userId);
  }

  async remove(userId: string, productId: string) {
    const cart = await this.cartFor(userId);
    await this.prisma.cartItem.deleteMany({ where: { cartId: cart.id, productId } });
    return this.get(userId);
  }

  async clear(userId: string) {
    const cart = await this.cartFor(userId);
    await this.prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
    return this.get(userId);
  }
}
