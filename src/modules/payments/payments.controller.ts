import { Body, Controller, Headers, HttpCode, Param, ParseUUIDPipe, Post, Req, UnauthorizedException, type RawBodyRequest } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { IsString, Matches, MaxLength } from 'class-validator';
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
