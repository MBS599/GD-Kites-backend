import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, MinLength, NotEquals } from 'class-validator';
import { CurrentUser, Roles, type AuthUser } from '../../common/auth.decorators';
import { productInclude, productOut } from '../../common/serializers';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';

export class AdjustStockDto {
  /** Positive to add stock (new delivery from supplier), negative to remove (damage, count correction). */
  @IsInt() @NotEquals(0) delta: number;
  @IsString() @MinLength(3) @MaxLength(200) reason: string;
}

export class InventoryQuery {
  @IsOptional() @Transform(({ value }) => value === 'true' || value === true) @IsBoolean() lowOnly?: boolean;
}

@ApiTags('Inventory')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('inventory')
export class InventoryController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Stock levels; `lowOnly=true` returns products at or below their threshold. */
  @Get()
  async list(@Query() q: InventoryQuery) {
    const products = await this.prisma.product.findMany({
      where: { isActive: true },
      include: productInclude,
      orderBy: { stock: 'asc' },
    });
    const rows = products
      .map(productOut)
      .filter((p) => !q.lowOnly || p.stock <= p.lowStockThreshold)
      .map((p) => ({ ...p, isLowStock: p.stock <= p.lowStockThreshold }));
    return { products: rows };
  }

  /** Atomic stock adjustment with an audit entry. */
  @Post(':productId/adjust')
  async adjust(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: AdjustStockDto,
    @CurrentUser() user: AuthUser,
  ) {
    const product = await this.prisma.tx(async (tx) => {
      const res = await tx.product.updateMany({
        where: { id: productId, isActive: true, ...(dto.delta < 0 ? { stock: { gte: -dto.delta } } : {}) },
        data: { stock: { increment: dto.delta } },
      });
      if (res.count === 0) {
        const exists = await tx.product.findFirst({ where: { id: productId, isActive: true } });
        if (!exists) throw new NotFoundException('Product not found.');
        throw new BadRequestException(`Only ${exists.stock} in stock; cannot remove ${-dto.delta}.`);
      }
      const p = await tx.product.findUniqueOrThrow({ where: { id: productId }, include: productInclude });
      await tx.inventoryMovement.create({
        data: {
          productId,
          delta: dto.delta,
          stockAfter: p.stock,
          reason: 'ADMIN_ADJUSTMENT',
          actorId: user.id,
          note: dto.reason.trim(),
        },
      });
      return p;
    });
    this.realtime.catalogUpdated(productId);
    return { product: productOut(product) };
  }

  /** Last 100 stock movements for a product. */
  @Get(':productId/movements')
  async movements(@Param('productId', ParseUUIDPipe) productId: string) {
    const rows = await this.prisma.inventoryMovement.findMany({
      where: { productId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return {
      movements: rows.map((r) => ({
        id: r.id,
        delta: r.delta,
        stockAfter: r.stockAfter,
        reason: r.reason,
        orderId: r.orderId,
        note: r.note,
        at: r.createdAt.toISOString(),
      })),
    };
  }
}
