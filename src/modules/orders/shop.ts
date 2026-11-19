import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Prisma, type Product } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import { toBuffer } from 'qrcode';
import { CurrentUser, Public, Roles, type AuthUser } from '../../common/auth.decorators';
import { lineTotal, unitPrice } from '../../common/pricing';
import { comboContents, comboCost, isAvailable, orderInclude, orderOut, productDisplayName, productInclude, type FullOrder } from '../../common/serializers';
import { AppConfig } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { PushService } from '../sms/push.service';
import { normalizeIndianMobile } from '../sms/sms.service';
import { BillService } from './bills';
import { renderQrPoster } from './qr-poster';

export class ShopLineDto {
  @IsUUID() productId: string;
  @IsInt() @Min(1) @Max(100_000) qty: number;
}

export class ShopRequestDto {
  @IsString() @MinLength(2) @MaxLength(60) name: string;
  /** The customer's WhatsApp number (Indian mobile); the bill is sent there. */
  @IsString() @MaxLength(20) phone: string;
  @ValidateNested({ each: true }) @Type(() => ShopLineDto) @ArrayMinSize(1) @ArrayMaxSize(60) items: ShopLineDto[];
}

export class ShopBillDto extends ShopRequestDto {
  /** Billing a customer's QR order: it is marked billed. */
  @IsOptional() @IsUUID() requestId?: string;
}

export class ShopRequestListQuery {
  @IsOptional() @IsIn(['waiting', 'all']) status?: 'waiting' | 'all';
}

/** Products sell at the counter in the same packs as the app: their minimum, else 50; combos singly. */
const packOf = (p: Pick<Product, 'isCombo' | 'minQty'>) => (p.isCombo ? 1 : (p.minQty ?? 50));
const display = (n: string) => `+91 ${n.slice(2, 7)} ${n.slice(7)}`;
const imageOf = (p: Pick<Product, 'imageUrl' | 'media'>) => {
  const media = Array.isArray(p.media) ? (p.media as { url?: string; type?: string }[]) : [];
  return p.imageUrl ?? media.find((m) => m?.url && m.type !== 'video')?.url ?? null;
};
type Line = { productId: string; qty: number };

/**
 * Shop counter: the owner bills walk-in customers (no delivery, paid in cash at the shop), and
 * customers can scan the shop QR, enter their name and WhatsApp number and choose products on
 * their own phone; the owner then bills that order. Either way the bill PDF goes to the
 * customer's WhatsApp, the customer is saved by number and the sale counts like any delivered order.
 */
@Injectable()
export class ShopService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bills: BillService,
    private readonly realtime: RealtimeService,
    private readonly push: PushService,
    private readonly config: AppConfig,
  ) {}

  private phone(raw: string) {
    const p = normalizeIndianMobile(raw);
    if (!p) throw new BadRequestException('Enter a valid 10-digit WhatsApp number.');
    return p;
  }

  /** Products on sale now, for the QR page and the owner's bill screen. */
  async catalog() {
    const products = await this.prisma.product.findMany({
      where: { isActive: true, isDamaged: false, category: { isActive: true } },
      include: productInclude,
      orderBy: [{ category: { sortOrder: 'asc' } }, { name: 'asc' }, { price: 'asc' }],
    });
    return {
      products: products
        .filter((p) => isAvailable(p))
        .map((p) => ({
          id: p.id,
          name: productDisplayName(p),
          category: p.isCombo ? 'Combos' : p.category.name,
          price: Number(p.price),
          unit: p.unit,
          pack: packOf(p),
          minQty: p.minQty,
          imageUrl: imageOf(p),
        })),
    };
  }

  /** Prices and checks every line like checkout does (current catalogue price, stock, minimums). */
  private async price(tx: Prisma.TransactionClient, lines: Line[]) {
    const merged = new Map<string, number>();
    for (const l of lines) merged.set(l.productId, (merged.get(l.productId) ?? 0) + l.qty);
    const products = await tx.product.findMany({ where: { id: { in: [...merged.keys()] } }, include: productInclude });
    const byId = new Map(products.map((p) => [p.id, p]));
    let subtotal = new Prisma.Decimal(0);
    const rows: Prisma.OrderItemCreateManyOrderInput[] = [];
    for (const [productId, qty] of merged) {
      const p = byId.get(productId);
      if (!p || !p.isActive) throw new BadRequestException('A product on this bill is no longer sold. Remove it and try again.');
      const name = productDisplayName(p);
      if (!isAvailable(p)) throw new BadRequestException(`${name} is out of stock. Remove it and try again.`);
      if (p.minQty && qty < p.minQty) throw new BadRequestException(`The minimum for ${name} is ${p.minQty}.`);
      const total = lineTotal(p, qty);
      subtotal = subtotal.add(total);
      rows.push({
        productId: p.id,
        productName: name,
        unit: p.unit,
        qty,
        unitPrice: unitPrice(p, qty),
        lineTotal: total,
        unitCost: p.isCombo ? comboCost(p) : p.costPrice,
        contents: p.isCombo ? comboContents(p.comboItems) : null,
      });
    }
    return { subtotal, rows };
  }

  // ------------------------------------------------------------ customer (QR page)

  async createRequest(dto: ShopRequestDto) {
    const phone = this.phone(dto.phone);
    // Checked now so the customer hears about out-of-stock items before walking to the counter.
    await this.prisma.tx((tx) => this.price(tx, dto.items));
    const waiting = await this.prisma.shopRequest.count({ where: { phone, status: 'WAITING' } });
    if (waiting >= 3) throw new BadRequestException('You already have orders waiting at the counter. Please ask the shop to bill them first.');
    const r = await this.prisma.shopRequest.create({
      data: {
        name: dto.name.trim().replace(/\s+/g, ' '),
        phone,
        items: dto.items.map((i) => ({ productId: i.productId, qty: i.qty })),
        token: randomBytes(18).toString('base64url'),
      },
    });
    // Shop staff: a ping on their phones; the counter screen also refreshes by itself.
    const admins = await this.prisma.user.findMany({ where: { role: 'ADMIN', isActive: true }, select: { id: true } });
    for (const a of admins) {
      this.push.notifyUser(a.id, {
        title: 'New counter order',
        body: `${r.name} placed an order from the shop QR.`,
        data: { type: 'shopRequest', requestId: r.id },
      });
    }
    return { id: r.id, token: r.token, status: 'waiting' };
  }

  async requestStatus(id: string, token: string) {
    const r = await this.prisma.shopRequest.findUnique({ where: { id } });
    if (!r || r.token !== token) throw new NotFoundException('Order not found.');
    return { status: r.status.toLowerCase(), orderCode: r.orderId ? await this.codeOf(r.orderId) : null };
  }

  private async codeOf(orderId: string) {
    const o = await this.prisma.order.findUnique({ where: { id: orderId }, select: { number: true } });
    return o ? `GD${o.number}` : null;
  }

  // ------------------------------------------------------------ owner

  async listRequests(status: 'waiting' | 'all' = 'waiting') {
    const list = await this.prisma.shopRequest.findMany({
      where: status === 'waiting' ? { status: 'WAITING' } : {},
      orderBy: { createdAt: status === 'waiting' ? 'asc' : 'desc' },
      take: 100,
    });
    const ids = [...new Set(list.flatMap((r) => (r.items as Line[]).map((i) => i.productId)))];
    const products = await this.prisma.product.findMany({ where: { id: { in: ids } }, include: productInclude });
    const byId = new Map(products.map((p) => [p.id, p]));
    return {
      requests: list.map((r) => {
        const items = (r.items as Line[]).map((i) => {
          const p = byId.get(i.productId);
          return {
            productId: i.productId,
            qty: i.qty,
            name: p ? productDisplayName(p) : 'Product no longer sold',
            price: p ? Number(unitPrice(p, i.qty)) : 0,
            unit: p?.unit ?? 'piece',
            pack: p ? packOf(p) : 1,
            available: !!p && p.isActive && isAvailable(p),
          };
        });
        return {
          id: r.id,
          name: r.name,
          phone: display(r.phone),
          status: r.status.toLowerCase(),
          items,
          total: items.reduce((s, i) => s + i.price * i.qty, 0),
          createdAt: r.createdAt.toISOString(),
        };
      }),
    };
  }

  async reject(id: string) {
    const r = await this.prisma.shopRequest.updateMany({ where: { id, status: 'WAITING' }, data: { status: 'REJECTED' } });
    if (r.count === 0) throw new NotFoundException('This order is no longer waiting.');
    return { ok: true };
  }

  /** The saved customer for a number, so the owner doesn't retype the name. */
  async lookup(raw: string) {
    const phone = normalizeIndianMobile(raw);
    if (!phone) return { customer: null };
    const u = await this.findCustomer(phone);
    return { customer: u ? { id: u.id, name: u.businessName ?? u.name, orders: await this.prisma.order.count({ where: { customerId: u.id } }) } : null };
  }

  private async findCustomer(phone: string) {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "User"
      WHERE role = 'CUSTOMER' AND "isActive" = true
        AND ("phoneVerified" = ${phone} OR right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) = ${phone.slice(2)})
      ORDER BY ("phoneVerified" IS NOT NULL) DESC, "createdAt" ASC
      LIMIT 1`;
    return rows[0] ? this.prisma.user.findUnique({ where: { id: rows[0].id } }) : null;
  }

  /** Owner: bill a walk-in customer (or a QR order). Paid in cash at the shop; the PDF goes on WhatsApp. */
  async createBill(admin: AuthUser, dto: ShopBillDto) {
    const phone = this.phone(dto.phone);
    const name = dto.name.trim().replace(/\s+/g, ' ');
    const hub = await this.prisma.serviceArea.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'asc' } });
    const orderId = await this.prisma.tx(async (tx) => {
      if (dto.requestId) {
        const done = await tx.shopRequest.updateMany({ where: { id: dto.requestId, status: 'WAITING' }, data: { status: 'BILLED' } });
        if (done.count === 0) throw new BadRequestException('This QR order was already billed or turned down.');
      }
      const { subtotal, rows } = await this.price(tx, dto.items);
      const existing = await this.findCustomer(phone);
      const customer =
        existing ??
        (await tx.user.create({
          data: { name, phone: display(phone), role: 'CUSTOMER', cart: { create: {} } },
        }));
      const now = new Date();
      const order = await tx.order.create({
        data: {
          status: 'DELIVERED',
          deliveredAt: now,
          customerId: customer.id,
          paymentMethod: 'CASH_ON_DELIVERY',
          deliveryMode: 'COUNTER',
          subtotal,
          deliveryCharge: 0,
          total: subtotal,
          addrLabel: 'Shop counter',
          addrArea: 'Kondhwa Budruk',
          addrLine: 'GD Kite Center',
          addrCity: 'Pune',
          addrPincode: '411046',
          addrLat: hub?.hubLat ?? 0,
          addrLng: hub?.hubLng ?? 0,
          distanceKm: 0,
          contactName: name,
          contactPhone: display(phone),
          items: { createMany: { data: rows } },
          history: { create: { status: 'DELIVERED', actorId: admin.id, note: 'Sold at the shop counter' } },
        },
      });
      for (const productId of new Set(rows.map((r) => r.productId))) {
        await tx.product.update({ where: { id: productId }, data: { buyerCount: { increment: 1 } } });
      }
      if (dto.requestId) await tx.shopRequest.update({ where: { id: dto.requestId }, data: { orderId: order.id } });
      return order.id;
    });
    const full = (await this.prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: orderInclude })) as FullOrder;
    this.realtime.orderUpdated(full);
    this.bills.sendAfterDelivery(orderId);
    return { order: orderOut(full) };
  }

  /** The shop QR as a PNG (to show on the counter screen or print). */
  qr() {
    return toBuffer(this.config.get('SHOP_PAGE_URL'), { width: 900, margin: 2, errorCorrectionLevel: 'M' });
  }

  /** The shop QR on a ready-to-print A4 poster for the counter. */
  qrPoster() {
    return renderQrPoster(this.config.get('SHOP_PAGE_URL'));
  }

  get pageUrl() {
    return this.config.get('SHOP_PAGE_URL');
  }
}

@ApiTags('Shop counter')
@Controller('shop')
export class ShopController {
  constructor(private readonly shop: ShopService) {}

  /** Public: what can be ordered at the counter. */
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('catalog')
  catalog() {
    return this.shop.catalog();
  }

  /** Public (shop QR page): a walk-in customer's order, waiting for the owner. Customers on the
   * shop's Wi-Fi share one address, so the limit is per minute for the whole counter; each number
   * can also have at most 3 orders waiting. */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('requests')
  createRequest(@Body() dto: ShopRequestDto) {
    return this.shop.createRequest(dto);
  }

  /** Public, with the token from placing it: has the shop billed it yet? */
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('requests/:id/status')
  status(@Param('id', ParseUUIDPipe) id: string, @Query('token') token: string) {
    return this.shop.requestStatus(id, token ?? '');
  }

  @Public()
  @Get('qr.png')
  @Header('Cache-Control', 'public, max-age=3600')
  async qr(@Res() res: Response) {
    res.type('png').send(await this.shop.qr());
  }

  /** Public: the printable counter poster (A4 PDF) with the shop QR. */
  @Public()
  @Get('qr-poster.pdf')
  @Header('Cache-Control', 'public, max-age=3600')
  async qrPoster(@Res() res: Response) {
    res
      .type('pdf')
      .setHeader('Content-Disposition', 'inline; filename="gd-kites-shop-qr.pdf"')
      .send(await this.shop.qrPoster());
  }

  @ApiBearerAuth()
  @Roles('ADMIN')
  @Get('requests')
  list(@Query() q: ShopRequestListQuery) {
    return this.shop.listRequests(q.status);
  }

  @ApiBearerAuth()
  @Roles('ADMIN')
  @Post('requests/:id/reject')
  @HttpCode(200)
  reject(@Param('id', ParseUUIDPipe) id: string) {
    return this.shop.reject(id);
  }

  @ApiBearerAuth()
  @Roles('ADMIN')
  @Get('customer')
  lookup(@Query('phone') phone: string) {
    return this.shop.lookup(phone ?? '');
  }

  @ApiBearerAuth()
  @Roles('ADMIN')
  @Get('page')
  page() {
    return { url: this.shop.pageUrl, qrPath: '/api/v1/shop/qr.png' };
  }

  @ApiBearerAuth()
  @Roles('ADMIN')
  @Post('bills')
  createBill(@CurrentUser() admin: AuthUser, @Body() dto: ShopBillDto) {
    return this.shop.createBill(admin, dto);
  }
}

@Module({ controllers: [ShopController], providers: [ShopService] })
export class ShopModule {}
