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
        ...(q.damaged !== undefined ? { isDamaged: q.damaged } : {}),
        ...(q.outOfStock ? { inStock: false } : {}),
        ...(q.category ? { category: { slug: q.category } } : {}),
        ...(q.q
          ? {
              OR: [
                { name: { contains: q.q, mode: 'insensitive' } },
                { material: { contains: q.q, mode: 'insensitive' } },
                { size: { name: { contains: q.q, mode: 'insensitive' } } },
                { category: { name: { contains: q.q, mode: 'insensitive' } } },
              ],
            }
          : {}),
      },
      include: productInclude,
      // In-stock products first.
      orderBy: [{ inStock: 'desc' }, { buyerCount: 'desc' }, { name: 'asc' }, { id: 'asc' }],
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

  private async sizeId(id: string | null | undefined) {
    if (id == null) return id;
    const s = await this.prisma.size.findUnique({ where: { id } });
    if (!s || !s.isActive) throw new BadRequestException('Unknown size.');
    return s.id;
  }

  private checkSlab(price: number, slabQty?: number | null, slabPrice?: number | null) {
    if ((slabQty == null) !== (slabPrice == null)) {
      throw new BadRequestException('Slab quantity and slab price must be set together.');
    }
    if (slabPrice != null && slabPrice >= price) throw new BadRequestException('Slab price must be lower than the base price.');
  }

  async create(dto: CreateProductDto) {
    this.checkSlab(dto.price, dto.slabQty, dto.slabPrice);
    const p = await this.prisma.product.create({
      data: {
        name: dto.name.trim(),
        categoryId: await this.categoryId(dto.category),
        sizeId: (await this.sizeId(dto.sizeId)) ?? null,
        price: new Prisma.Decimal(dto.price),
        unit: dto.unit?.trim() || 'piece',
        inStock: dto.inStock ?? true,
        isDamaged: dto.isDamaged ?? false,
        damageNote: dto.isDamaged ? dto.damageNote?.trim() || null : null,
        description: dto.description?.trim() ?? '',
        material: dto.material?.trim() || null,
        slabQty: dto.slabQty ?? null,
        slabPrice: dto.slabPrice == null ? null : new Prisma.Decimal(dto.slabPrice),
        imageUrl: dto.imageUrl ?? null,
      },
      include: productInclude,
    });
    this.realtime.catalogUpdated(p.id);
    return productOut(p);
  }

  /** Updates only the fields given. */
  async update(id: string, dto: UpdateProductDto) {
    const existing = await this.prisma.product.findFirst({ where: { id, isActive: true } });
    if (!existing) throw new NotFoundException('Product not found.');
    const price = dto.price ?? existing.price.toNumber();
    const slabQty = dto.slabQty !== undefined ? dto.slabQty : existing.slabQty;
    const slabPrice = dto.slabPrice !== undefined ? dto.slabPrice : existing.slabPrice?.toNumber() ?? null;
    this.checkSlab(price, slabQty, slabPrice);

    const isDamaged = dto.isDamaged ?? existing.isDamaged;
    const p = await this.prisma.product.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        categoryId: dto.category ? await this.categoryId(dto.category) : undefined,
        sizeId: dto.sizeId === undefined || dto.sizeId === existing.sizeId ? undefined : await this.sizeId(dto.sizeId),
        price: dto.price !== undefined ? new Prisma.Decimal(dto.price) : undefined,
        unit: dto.unit?.trim(),
        inStock: dto.inStock,
        isDamaged: dto.isDamaged,
        damageNote: !isDamaged ? null : dto.damageNote === undefined ? undefined : dto.damageNote?.trim() || null,
        description: dto.description?.trim(),
        material: dto.material === undefined ? undefined : dto.material?.trim() || null,
        slabQty,
        slabPrice: slabPrice == null ? null : new Prisma.Decimal(slabPrice),
        imageUrl: dto.imageUrl,
      },
      include: productInclude,
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
