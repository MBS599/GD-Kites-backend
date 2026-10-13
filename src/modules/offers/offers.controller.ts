import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { Prisma, type Offer } from '@prisma/client';
import { CurrentUser, Roles, type AuthUser } from '../../common/auth.decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { isLive, OffersService } from './offers.service';

export class CreateOfferDto {
  @IsString() @MinLength(3, { message: 'Give the offer a title.' }) @MaxLength(80) title: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(300) description?: string | null;
  @IsIn(['percent', 'flat']) kind: 'percent' | 'flat';
  /** percent: 1–90 (% off the goods); flat: rupees off. */
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(1) @Max(1_000_000) value: number;
  /** percent only: most rupees it takes off (null = no cap). */
  @IsOptional() @ValidateIf((_, v) => v !== null) @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(1) maxDiscount?: number | null;
  /** Goods subtotal needed (0 = any order). */
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) minOrder?: number;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() startsAt?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() endsAt?: string | null;
  /** Orders each customer can use it on. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) usesPerCustomer?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
  /** The only customers who can see and use it. The list replaces the previous one. */
  @IsArray() @ArrayMaxSize(5000) @IsUUID('all', { each: true }) customerIds: string[];
}

export class UpdateOfferDto extends PartialType(CreateOfferDto) {}

export class CustomerSearchQuery {
  /** Name, shop name, mobile or email. Empty: the latest customers. */
  @IsOptional() @IsString() @MaxLength(60) q?: string;
}

const customerSelect = { id: true, name: true, businessName: true, phone: true, phoneVerified: true, email: true } as const;
type CustomerRow = Prisma.UserGetPayload<{ select: typeof customerSelect }>;

const customerOut = (c: CustomerRow) => ({
  id: c.id,
  name: c.name,
  businessName: c.businessName,
  phone: c.phone ?? (c.phoneVerified ? `+${c.phoneVerified}` : null),
  email: c.email,
});

type AdminOffer = Offer & { customers: { user: CustomerRow }[] };

function adminOfferOut(o: AdminOffer, usage: { orders: number; discount: number }) {
  return {
    id: o.id,
    title: o.title,
    description: o.description,
    kind: o.kind === 'PERCENT' ? 'percent' : 'flat',
    value: o.value.toNumber(),
    maxDiscount: o.maxDiscount?.toNumber() ?? null,
    minOrder: o.minOrder.toNumber(),
    startsAt: o.startsAt?.toISOString() ?? null,
    endsAt: o.endsAt?.toISOString() ?? null,
    usesPerCustomer: o.usesPerCustomer,
    isActive: o.isActive,
    /** Switched on and inside its dates. */
    live: isLive(o),
    customers: o.customers.map((c) => customerOut(c.user)),
    /** Orders (not cancelled) that used it, and the rupees it took off them. */
    usedOrders: usage.orders,
    discountGiven: usage.discount,
    createdAt: o.createdAt.toISOString(),
  };
}

/** Customer: the offers the shop enabled for this customer. */
@ApiTags('Offers')
@ApiBearerAuth()
@Roles('CUSTOMER')
@Controller('offers')
export class OffersController {
  constructor(private readonly offers: OffersService) {}

  /** Live offers with uses left, each with what it takes off the current cart. */
  @Get()
  async mine(@CurrentUser() user: AuthUser) {
    return { offers: await this.offers.mine(user.id) };
  }
}

/** Admin: create offers and pick the customers who get them. */
@ApiTags('Admin')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('admin/offers')
export class OffersAdminController {
  constructor(private readonly prisma: PrismaService) {}

  private readonly include = { customers: { include: { user: { select: customerSelect } }, orderBy: { createdAt: 'asc' } } } as const;

  private async usage(ids: string[]) {
    const rows = await this.prisma.order.groupBy({
      by: ['offerId'],
      where: { offerId: { in: ids }, status: { not: 'CANCELLED' } },
      _count: { _all: true },
      _sum: { discount: true },
    });
    return new Map(rows.map((r) => [r.offerId, { orders: r._count._all, discount: r._sum.discount?.toNumber() ?? 0 }]));
  }

  private async out(id: string) {
    const o = await this.prisma.offer.findUnique({ where: { id }, include: this.include });
    if (!o) throw new NotFoundException('Offer not found.');
    return adminOfferOut(o, (await this.usage([id])).get(id) ?? { orders: 0, discount: 0 });
  }

  @Get()
  async list() {
    const offers = await this.prisma.offer.findMany({ include: this.include, orderBy: { createdAt: 'desc' } });
    const usage = await this.usage(offers.map((o) => o.id));
    return { offers: offers.map((o) => adminOfferOut(o, usage.get(o.id) ?? { orders: 0, discount: 0 })) };
  }

  /** Customers to pick from (active customer accounts only). */
  @Get('customers')
  async customers(@Query() q: CustomerSearchQuery) {
    const text = q.q?.trim();
    const like = (v: string) => ({ contains: v, mode: 'insensitive' as const });
    const digits = text?.replace(/\D/g, '') ?? '';
    const rows = await this.prisma.user.findMany({
      where: {
        role: 'CUSTOMER',
        isActive: true,
        ...(text
          ? {
              OR: [
                { name: like(text) },
                { businessName: like(text) },
                { email: like(text) },
                ...(digits.length >= 3 ? [{ phone: { contains: digits } }, { phoneVerified: { contains: digits } }] : []),
              ],
            }
          : {}),
      },
      select: customerSelect,
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { customers: rows.map(customerOut) };
  }

  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return { offer: await this.out(id) };
  }

  @Post()
  async create(@Body() dto: CreateOfferDto) {
    const data = (await this.data(dto, null)) as Prisma.OfferCreateInput;
    const id = await this.prisma.$transaction(async (tx) => {
      const o = await tx.offer.create({ data });
      await this.setCustomers(o.id, dto.customerIds, tx);
      return o.id;
    });
    return { offer: await this.out(id) };
  }

  @Patch(':id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateOfferDto) {
    const existing = await this.prisma.offer.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Offer not found.');
    const data = await this.data(dto, existing);
    await this.prisma.$transaction(async (tx) => {
      await tx.offer.update({ where: { id }, data });
      if (dto.customerIds) await this.setCustomers(id, dto.customerIds, tx);
    });
    return { offer: await this.out(id) };
  }

  /** Orders that used it keep their discount and the offer's title. */
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    const res = await this.prisma.offer.deleteMany({ where: { id } });
    if (res.count === 0) throw new NotFoundException('Offer not found.');
  }

  /** Validated fields merged over the stored offer. */
  private async data(dto: UpdateOfferDto, existing: Offer | null): Promise<Prisma.OfferUpdateInput> {
    const kind = dto.kind ? (dto.kind === 'percent' ? 'PERCENT' : 'FLAT') : (existing?.kind ?? null);
    if (!kind) throw new BadRequestException('Choose % off or ₹ off.');
    const value = dto.value ?? existing?.value.toNumber();
    if (value == null) throw new BadRequestException('Enter how much the offer takes off.');
    if (kind === 'PERCENT' && value > 90) throw new BadRequestException('A % offer can be at most 90% off.');
    const startsAt = dto.startsAt === undefined ? (existing?.startsAt ?? null) : dto.startsAt ? new Date(dto.startsAt) : null;
    const endsAt = dto.endsAt === undefined ? (existing?.endsAt ?? null) : dto.endsAt ? new Date(dto.endsAt) : null;
    if (startsAt && endsAt && endsAt <= startsAt) throw new BadRequestException('The end date must be after the start date.');
    return {
      ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
      ...(dto.description !== undefined ? { description: dto.description?.trim() || null } : {}),
      kind,
      value,
      // A cap only means something for % offers.
      maxDiscount: kind === 'PERCENT' ? (dto.maxDiscount === undefined ? (existing?.maxDiscount ?? null) : dto.maxDiscount) : null,
      ...(dto.minOrder !== undefined ? { minOrder: dto.minOrder } : {}),
      startsAt,
      endsAt,
      ...(dto.usesPerCustomer !== undefined ? { usesPerCustomer: dto.usesPerCustomer } : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
    };
  }

  /** Replaces who can use the offer; only active customer accounts are kept. */
  private async setCustomers(offerId: string, ids: string[], tx: Prisma.TransactionClient = this.prisma) {
    const unique = [...new Set(ids)];
    const valid = unique.length
      ? await tx.user.findMany({ where: { id: { in: unique }, role: 'CUSTOMER', isActive: true }, select: { id: true } })
      : [];
    if (valid.length !== unique.length) throw new BadRequestException('Some of the chosen customers no longer exist. Refresh and pick again.');
    await tx.offerCustomer.deleteMany({ where: { offerId, userId: { notIn: unique } } });
    await tx.offerCustomer.createMany({ data: unique.map((userId) => ({ offerId, userId })), skipDuplicates: true });
  }
}
