import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, UnauthorizedException, type RawBodyRequest } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { PageQuery } from '../../common/paging';
import type { Request } from 'express';
import { CurrentUser, Public, Roles, type AuthUser } from '../../common/auth.decorators';
import { orderOut } from '../../common/serializers';
import { PaymentsService } from './payments.service';
import { RazorpayClient } from './razorpay.client';

export class VerifyPaymentDto {
  @Matches(/^order_[A-Za-z0-9]+$/) razorpayOrderId: string;
  @Matches(/^pay_[A-Za-z0-9]+$/) razorpayPaymentId: string;
  @IsString() @MaxLength(200) razorpaySignature: string;
}

/** Customer: pay the delivery charge of an order online. */
@ApiTags('Payments')
@ApiBearerAuth()
@Roles('CUSTOMER')
@Controller('orders/:id/payment')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  /** Opens Razorpay Checkout again for an unpaid order (e.g. after the customer closed it). */
  @Post()
  @HttpCode(200)
  async checkout(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return { checkout: await this.payments.checkout(user, id) };
  }

  /** Checkout success callback: the server verifies the signature and the payment with Razorpay. */
  @Post('verify')
  @HttpCode(200)
  async verify(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VerifyPaymentDto) {
    const order = await this.payments.verify(user, id, dto.razorpayOrderId, dto.razorpayPaymentId, dto.razorpaySignature);
    return { order: orderOut(order) };
  }
}

/** Razorpay calls this (payment.captured, payment.failed, refund.*). Public, but signature-checked. */
@Controller('webhooks/razorpay')
@SkipThrottle()
export class RazorpayWebhookController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly rzp: RazorpayClient,
  ) {}

  @Public()
  @Post()
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async receive(@Req() req: RawBodyRequest<Request>, @Headers('x-razorpay-signature') signature?: string) {
    if (!this.rzp.webhookSignatureValid(req.rawBody, signature)) throw new UnauthorizedException('Bad signature.');
    await this.payments.handleWebhook(req.body);
    return { ok: true };
  }
}

const ADMIN_STATUSES = ['paid', 'failed', 'refundPending', 'refunded', 'refundFailed'] as const;
const STATUS_DB = {
  paid: 'PAID',
  failed: 'FAILED',
  refundPending: 'REFUND_PENDING',
  refunded: 'REFUNDED',
  refundFailed: 'REFUND_FAILED',
} as const;

export class AdminPaymentsQuery extends PageQuery {
  @IsOptional() @IsIn(ADMIN_STATUSES) status?: (typeof ADMIN_STATUSES)[number];
  @IsOptional() @IsUUID() orderId?: string;
}

export class AdminRefundDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(200)
  reason?: string;
}

/** Admin → Payments & refunds: every online payment, refunds and their state. */
@ApiTags('Payments')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('payments')
export class PaymentsAdminController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  list(@Query() q: AdminPaymentsQuery) {
    return this.payments.adminList({ ...q, status: q.status ? STATUS_DB[q.status] : undefined });
  }

  /** Refund a paid payment, or retry a refund that failed. */
  @Post(':id/refund')
  @HttpCode(200)
  async refund(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminRefundDto) {
    return { payment: await this.payments.adminRefund(id, dto.reason || 'Refunded by GD Kite Center') };
  }

  /** Ask Razorpay for the refund's current state. */
  @Post(':id/sync')
  @HttpCode(200)
  async sync(@Param('id', ParseUUIDPipe) id: string) {
    return { payment: await this.payments.adminSync(id) };
  }
}

/** Customer → Profile → My payments: their own online payments and refunds. */
@ApiTags('Payments')
@ApiBearerAuth()
@Roles('CUSTOMER')
@Controller('my/payments')
export class MyPaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: PageQuery) {
    return this.payments.customerList(user.id, q.cursor, q.limit ?? 20);
  }
}
