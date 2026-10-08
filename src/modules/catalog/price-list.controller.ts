import { Controller, Get, Header } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/auth.decorators';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Public price list for the website (gdkites.in/products/): what any shopper may see —
 * name, category, size, unit, price, minimum quantity and stock. No cost price, no
 * customer data. Payment gateways require prices to be visible on the merchant's site.
 */
@ApiTags('Catalogue')
@Controller('catalog')
export class PriceListController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Header('Cache-Control', 'public, max-age=300')
  @Get('price-list')
  async priceList() {
    const products = await this.prisma.product.findMany({
      where: { isActive: true, isDamaged: false, category: { isActive: true } },
      select: {
        name: true,
        price: true,
        unit: true,
        minQty: true,
        inStock: true,
        isCombo: true,
        size: { select: { name: true } },
        category: { select: { name: true, sortOrder: true } },
      },
      orderBy: [{ category: { sortOrder: 'asc' } }, { name: 'asc' }, { price: 'asc' }],
    });
    return {
      products: products.map((p) => ({
        name: p.size ? `${p.name} (${p.size.name})` : p.name,
        category: p.isCombo ? 'Combos' : p.category.name,
        price: Number(p.price),
        unit: p.unit,
        minQty: p.minQty,
        inStock: p.inStock,
      })),
      updatedAt: new Date().toISOString(),
    };
  }
}
