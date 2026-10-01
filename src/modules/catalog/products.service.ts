import { pageArgs, toPage } from '../../common/paging';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { productInclude, productOut } from '../../common/serializers';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import type { CreateProductDto, ProductQuery, UpdateProductDto } from './products.dto';

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  async list(q: ProductQuery) {
    const { limit, args } = pageArgs(q);
    const products = await this.prisma.product.findMany({
      where: {
        isActive: true,
        ...(q.lowStock ? { stock: { lte: this.prisma.product.fields.lowStockThreshold } } : {}),
        ...(q.category ? { category: { slug: q.category } } : {}),
        ...(q.q
          ? {
              OR: [
                { name: { contains: q.q, mode: 'insensitive' } },
                { material: { contains: q.q, mode: 'insensitive' } },
                { category: { name: { contains: q.q, mode: 'insensitive' } } },
              ],
            }
          : {}),
      },
      include: productInclude,
      orderBy: [{ buyerCount: 'desc' }, { name: 'asc' }, { id: 'asc' }],
      ...args,
    });
    const page = toPage(products, limit);
    return { items: page.items.map(productOut), nextCursor: page.nextCursor };
  }

  async get(id: string) {
    const p = await this.prisma.product.findFirst({ where: { id, isActive: true }, include: productInclude });
    if (!p) throw new NotFoundException('Product not found.');
    return productOut(p);
  }

  private async categoryId(slug: string) {
    const c = await this.prisma.category.findUnique({ where: { slug } });
    if (!c || !c.isActive) throw new BadRequestException('Unknown category.');
    return c.id;
  }

  private checkSlab(price: number, slabQty?: number | null, slabPrice?: number | null) {
    if ((slabQty == null) !== (slabPrice == null)) {
      throw new BadRequestException('Slab quantity and slab price must be set together.');
    }
    if (slabPrice != null && slabPrice >= price) throw new BadRequestException('Slab price must be lower than the base price.');
  }

  async create(dto: CreateProductDto, actorId: string) {
    this.checkSlab(dto.price, dto.slabQty, dto.slabPrice);
    const categoryId = await this.categoryId(dto.category);
    const p = await this.prisma.tx(async (tx) => {
      const created = await tx.product.create({
        data: {
          name: dto.name.trim(),
          categoryId,
          price: new Prisma.Decimal(dto.price),
          unit: dto.unit?.trim() || 'piece',
          minOrderQty: dto.minOrderQty,
          stock: dto.stock,
          lowStockThreshold: dto.lowStockThreshold ?? 200,
          description: dto.description?.trim() ?? '',
          material: dto.material?.trim() || null,
          size: dto.size?.trim() || null,
          slabQty: dto.slabQty ?? null,
          slabPrice: dto.slabPrice == null ? null : new Prisma.Decimal(dto.slabPrice),
          imageUrl: dto.imageUrl ?? null,
        },
        include: productInclude,
      });
      await tx.inventoryMovement.create({
        data: { productId: created.id, delta: dto.stock, stockAfter: dto.stock, reason: 'INITIAL', actorId },
      });
      return created;
    });
    this.realtime.catalogUpdated(p.id);
    return productOut(p);
  }

  /**
   * Updates catalogue fields. A `stock` value here is applied as an inventory
   * adjustment (logged) so the movement history stays complete.
   */
  async update(id: string, dto: UpdateProductDto, actorId: string) {
    const existing = await this.prisma.product.findFirst({ where: { id, isActive: true } });
    if (!existing) throw new NotFoundException('Product not found.');
    const price = dto.price ?? existing.price.toNumber();
    const slabQty = dto.slabQty !== undefined ? dto.slabQty : existing.slabQty;
    const slabPrice = dto.slabPrice !== undefined ? dto.slabPrice : existing.slabPrice?.toNumber() ?? null;
    this.checkSlab(price, slabQty, slabPrice);

    const p = await this.prisma.tx(async (tx) => {
      if (dto.stock !== undefined && dto.stock !== existing.stock) {
        const delta = dto.stock - existing.stock;
        await tx.product.update({ where: { id }, data: { stock: { increment: delta } } });
        const after = await tx.product.findUniqueOrThrow({ where: { id }, select: { stock: true } });
        if (after.stock < 0) throw new BadRequestException('Stock cannot be negative.');
        await tx.inventoryMovement.create({
          data: { productId: id, delta, stockAfter: after.stock, reason: 'ADMIN_ADJUSTMENT', actorId, note: 'Product edit' },
        });
      }
      return tx.product.update({
        where: { id },
        data: {
          name: dto.name?.trim(),
          categoryId: dto.category ? await this.categoryId(dto.category) : undefined,
          price: dto.price !== undefined ? new Prisma.Decimal(dto.price) : undefined,
          unit: dto.unit?.trim(),
          minOrderQty: dto.minOrderQty,
          lowStockThreshold: dto.lowStockThreshold,
          description: dto.description?.trim(),
          material: dto.material === undefined ? undefined : dto.material?.trim() || null,
          size: dto.size === undefined ? undefined : dto.size?.trim() || null,
          slabQty,
          slabPrice: slabPrice == null ? null : new Prisma.Decimal(slabPrice),
          imageUrl: dto.imageUrl,
        },
        include: productInclude,
      });
    });
    this.realtime.catalogUpdated(p.id);
    return productOut(p);
  }

  /** Soft delete; also removes it from every cart. */
  async remove(id: string) {
    const res = await this.prisma.product.updateMany({ where: { id, isActive: true }, data: { isActive: false } });
    if (res.count === 0) throw new NotFoundException('Product not found.');
    await this.prisma.cartItem.deleteMany({ where: { productId: id } });
    this.realtime.catalogUpdated(id);
  }
}
