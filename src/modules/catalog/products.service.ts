import { pageArgs, toPage } from '../../common/paging';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { productInclude, productOut } from '../../common/serializers';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import type { ComboItemDto, CreateProductDto, ProductMediaDto, ProductQuery, ProductSpecDto, UpdateProductDto } from './products.dto';

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  async list(q: ProductQuery, admin = false) {
    const { limit, args } = pageArgs(q);
    const products = await this.prisma.product.findMany({
      where: {
        isActive: true,
        ...(q.damaged !== undefined ? { isDamaged: q.damaged } : {}),
        ...(q.combo !== undefined ? { isCombo: q.combo } : {}),
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
    return { items: page.items.map((p) => productOut(p, { cost: admin })), nextCursor: page.nextCursor };
  }

  async get(id: string, admin = false) {
    const p = await this.prisma.product.findFirst({ where: { id, isActive: true }, include: productInclude });
    if (!p) throw new NotFoundException('Product not found.');
    return productOut(p, { cost: admin });
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

  /**
   * A combo's lines: existing, active, ordinary products (no combos inside
   * combos), each once, adding up to at least two pieces.
   */
  private async comboLines(items: ComboItemDto[] | undefined, selfId?: string) {
    if (!items?.length) throw new BadRequestException('Add the products this combo contains.');
    const ids = items.map((i) => i.productId);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Each product can be in a combo only once; change its quantity instead.');
    if (selfId && ids.includes(selfId)) throw new BadRequestException('A combo cannot contain itself.');
    const found = await this.prisma.product.findMany({ where: { id: { in: ids }, isActive: true }, select: { id: true, isCombo: true } });
    if (found.length !== ids.length) throw new BadRequestException('Some products in this combo no longer exist.');
    if (found.some((p) => p.isCombo)) throw new BadRequestException('A combo cannot contain another combo.');
    if (items.reduce((s, i) => s + i.qty, 0) < 2) throw new BadRequestException('A combo needs at least two pieces.');
    return items.map((i, sortOrder) => ({ productId: i.productId, qty: i.qty, sortOrder }));
  }

  async create(dto: CreateProductDto) {
    this.checkSlab(dto.price, dto.slabQty, dto.slabPrice);
    const lines = dto.isCombo ? await this.comboLines(dto.comboItems) : [];
    const p = await this.prisma.product.create({
      data: {
        isCombo: dto.isCombo ?? false,
        comboItems: lines.length ? { create: lines } : undefined,
        name: dto.name.trim(),
        categoryId: await this.categoryId(dto.category),
        sizeId: (await this.sizeId(dto.sizeId)) ?? null,
        price: new Prisma.Decimal(dto.price),
        costPrice: dto.costPrice == null ? null : new Prisma.Decimal(dto.costPrice),
        unit: dto.unit?.trim() || 'piece',
        inStock: dto.inStock ?? true,
        isDamaged: dto.isDamaged ?? false,
        damageNote: dto.isDamaged ? dto.damageNote?.trim() || null : null,
        description: dto.description?.trim() ?? '',
        highlights: cleanHighlights(dto.highlights) ?? [],
        specs: cleanSpecs(dto.specs) ?? [],
        media: cleanMedia(dto.media) ?? (dto.imageUrl ? [{ type: 'image', url: dto.imageUrl }] : []),
        material: dto.material?.trim() || null,
        minQty: dto.isCombo ? null : (dto.minQty ?? null),
        slabQty: dto.slabQty ?? null,
        slabPrice: dto.slabPrice == null ? null : new Prisma.Decimal(dto.slabPrice),
        imageUrl: dto.media ? coverOf(dto.media) : (dto.imageUrl ?? null),
      },
      include: productInclude,
    });
    this.realtime.catalogUpdated(p.id);
    return productOut(p, { cost: true });
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
    const isCombo = dto.isCombo ?? existing.isCombo;
    if (isCombo && dto.comboItems === undefined && !existing.isCombo) {
      throw new BadRequestException('Add the products this combo contains.');
    }
    if (isCombo && !existing.isCombo && (await this.prisma.comboItem.count({ where: { productId: id } }))) {
      throw new BadRequestException('This product is part of a combo, so it cannot be a combo itself.');
    }
    const lines = isCombo && dto.comboItems !== undefined ? await this.comboLines(dto.comboItems, id) : null;
    const p = await this.prisma.product.update({
      where: { id },
      data: {
        isCombo,
        // Contents replaced when given; cleared when it stops being a combo.
        comboItems: !isCombo ? { deleteMany: {} } : lines ? { deleteMany: {}, create: lines } : undefined,
        name: dto.name?.trim(),
        categoryId: dto.category ? await this.categoryId(dto.category) : undefined,
        sizeId: dto.sizeId === undefined || dto.sizeId === existing.sizeId ? undefined : await this.sizeId(dto.sizeId),
        price: dto.price !== undefined ? new Prisma.Decimal(dto.price) : undefined,
        costPrice: dto.costPrice === undefined ? undefined : dto.costPrice === null ? null : new Prisma.Decimal(dto.costPrice),
        unit: dto.unit?.trim(),
        inStock: dto.inStock,
        isDamaged: dto.isDamaged,
        damageNote: !isDamaged ? null : dto.damageNote === undefined ? undefined : dto.damageNote?.trim() || null,
        description: dto.description?.trim(),
        highlights: cleanHighlights(dto.highlights),
        specs: cleanSpecs(dto.specs),
        media: cleanMedia(dto.media),
        material: dto.material === undefined ? undefined : dto.material?.trim() || null,
        minQty: isCombo ? null : dto.minQty,
        slabQty,
        slabPrice: slabPrice == null ? null : new Prisma.Decimal(slabPrice),
        // A new gallery sets the cover; an old client sending only imageUrl still works.
        imageUrl: dto.media ? coverOf(dto.media) : dto.imageUrl,
      },
      include: productInclude,
    });
    this.realtime.catalogUpdated(p.id);
    return productOut(p, { cost: true });
  }

  /** Soft delete; also removes it from every cart. */
  async remove(id: string) {
    const res = await this.prisma.product.updateMany({ where: { id, isActive: true }, data: { isActive: false } });
    if (res.count === 0) throw new NotFoundException('Product not found.');
    await this.prisma.cartItem.deleteMany({ where: { productId: id } });
    this.realtime.catalogUpdated(id);
  }
}

/** The cover photo: the first image of the gallery. */
function coverOf(media: ProductMediaDto[]): string | null {
  return media.find((m) => m.type === 'image')?.url ?? null;
}

function cleanHighlights(list?: string[]): string[] | undefined {
  return list?.map((h) => h.trim()).filter((h) => h.length > 0);
}

function cleanSpecs(list?: ProductSpecDto[]): { label: string; value: string }[] | undefined {
  return list
    ?.map((s) => ({ label: s.label.trim(), value: s.value.trim() }))
    .filter((s) => s.label.length > 0 && s.value.length > 0);
}

function cleanMedia(list?: ProductMediaDto[]): { type: 'image' | 'video'; url: string }[] | undefined {
  return list?.map((m) => ({ type: m.type, url: m.url }));
}
