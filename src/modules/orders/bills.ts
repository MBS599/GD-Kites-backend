import {
  BadRequestException,
  Controller,
  Get,
  Global,
  HttpCode,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser, Public, Roles, type AuthUser } from '../../common/auth.decorators';
import { orderCode, orderInclude, type FullOrder } from '../../common/serializers';
import { AppConfig } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SmsService } from '../sms/sms.service';
import { renderBill } from './bill.pdf';

/** Download links work this long, so they can be opened in a browser or shared to a printer app. */
const LINK_TTL = '30m';

/**
 * Bills for delivered orders: a PDF sent on WhatsApp after delivery, downloadable by the
 * customer (their own orders) and the admin, who can also resend it.
 */
@Injectable()
export class BillService {
  private readonly logger = new Logger(BillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sms: SmsService,
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
  ) {}

  private async load(orderId: string) {
    const o = (await this.prisma.order.findUnique({ where: { id: orderId }, include: orderInclude })) as FullOrder | null;
    if (!o) throw new NotFoundException('Order not found.');
    return o;
  }

  private delivered(o: FullOrder) {
    if (o.status !== 'DELIVERED') throw new BadRequestException('The bill is ready once the order is delivered.');
    return o;
  }

  async pdf(o: FullOrder) {
    const s = await this.prisma.appSettings.findUnique({ where: { id: 1 }, select: { whatsappNumber: true } });
    const n = s?.whatsappNumber;
    const phone = n && n.length === 12 ? `+${n.slice(0, 2)} ${n.slice(2, 7)} ${n.slice(7)}` : n ? `+${n}` : null;
    return {
      data: await renderBill(o, { phone }),
      filename: `GD Kites bill ${orderCode(o.number)}.pdf`,
      mimetype: 'application/pdf',
    };
  }

  /** After delivery: the bill goes to the customer on WhatsApp. Never fails the delivery. */
  sendAfterDelivery(orderId: string) {
    void (async () => {
      const o = this.delivered(await this.load(orderId));
      await this.sms.orderBill(o, await this.pdf(o));
      // First delivery or shop bill of this customer: ask for a Google review (once).
      await this.sms.askForReview(o.customerId, o.contactPhone);
    })().catch((e) => this.logger.warn(`Bill for ${orderId} not sent: ${String(e)}`));
  }

  /** Admin "Resend on WhatsApp": waits for WhatsApp's answer. */
  async resend(orderId: string) {
    const o = this.delivered(await this.load(orderId));
    const m = await this.sms.orderBill(o, await this.pdf(o), { wait: true });
    return { status: m?.status ?? 'SKIPPED', error: m?.error ?? null, to: m?.to ?? null };
  }

  /** A short-lived link that opens the PDF without signing in (browsers can't send our token). */
  async link(user: AuthUser, orderId: string) {
    const o = await this.load(orderId);
    if (user.role !== 'ADMIN' && !(user.role === 'CUSTOMER' && o.customerId === user.id)) {
      throw new NotFoundException('Order not found.');
    }
    this.delivered(o);
    const token = await this.jwt.signAsync({ sub: o.id }, { secret: this.secret(), expiresIn: LINK_TTL, audience: 'bill' });
    return { path: `/api/v1/bills/${token}`, filename: `GD Kites bill ${orderCode(o.number)}.pdf` };
  }

  async fromLink(token: string) {
    let orderId: string;
    try {
      ({ sub: orderId } = await this.jwt.verifyAsync<{ sub: string }>(token, { secret: this.secret(), audience: 'bill' }));
    } catch {
      throw new NotFoundException('This bill link has expired. Open the order in the GD Kites app and tap "Download bill" again.');
    }
    return this.pdf(this.delivered(await this.load(orderId)));
  }

  /** Separate from sign-in tokens: a bill link can never be used as one. */
  private secret() {
    return `${this.config.get('JWT_ACCESS_SECRET')}:bill`;
  }
}

@ApiTags('Orders')
@ApiBearerAuth()
@Controller()
export class BillsController {
  constructor(private readonly bills: BillService) {}

  /** Customer (own order) or admin: a 30-minute link to the bill PDF of a delivered order. */
  @Roles('CUSTOMER', 'ADMIN')
  @Get('orders/:id/bill-link')
  link(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.bills.link(user, id);
  }

  /** Admin: send the bill to the customer on WhatsApp again. */
  @Roles('ADMIN')
  @Post('orders/:id/bill/send')
  @HttpCode(200)
  resend(@Param('id', ParseUUIDPipe) id: string) {
    return this.bills.resend(id);
  }

  /** The PDF behind a bill link. */
  @Public()
  @Get('bills/:token')
  async file(@Param('token') token: string, @Res() res: Response) {
    const pdf = await this.bills.fromLink(token);
    res.setHeader('Content-Type', pdf.mimetype);
    res.setHeader('Content-Disposition', `inline; filename="${pdf.filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(pdf.data);
  }
}

@Global()
@Module({ controllers: [BillsController], providers: [BillService], exports: [BillService] })
export class BillsModule {}
