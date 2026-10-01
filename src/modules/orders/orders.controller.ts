import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { CurrentUser, Roles, type AuthUser } from '../../common/auth.decorators';
import { OrdersService } from './orders.service';

const STATUSES = ['pending', 'confirmed', 'assigned', 'outForDelivery', 'delivered', 'cancelled'];

export class OrderListQuery {
  /** Comma-separated statuses, e.g. `pending,confirmed`. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value))
  @IsIn(STATUSES, { each: true })
  status?: string[];

  /** Order number (GD1025 / 1025), customer name or area. */
  @IsOptional() @IsString() @MaxLength(60) q?: string;

  /** Page size (1–100). Without it the newest 100 are returned. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;

  /** `nextCursor` from the previous page. */
  @IsOptional() @IsUUID() cursor?: string;

  /** Filter by service area (e.g. admin viewing one city). */
  @IsOptional() @IsUUID() serviceAreaId?: string;

  /** Orders delivered / assigned to one driver (admin driver history). Combined with role scoping. */
  @IsOptional() @IsUUID() driverId?: string;
}

export class PlaceOrderDto {
  /** Saved address to deliver to. Items come from the server-side cart. */
  @IsUUID() addressId: string;
}

export class AssignDriverDto {
  @IsUUID() driverId: string;
}

export class RejectOrderDto {
  @IsString() @MinLength(3, { message: 'Please give a reason.' }) @MaxLength(300) reason: string;
}

@ApiTags('Orders')
@ApiBearerAuth()
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /** Scoped by role on the server: customer → own orders, driver → assigned, admin → all. */
  @Get()
  async list(@CurrentUser() user: AuthUser, @Query() q: OrderListQuery) {
    const page = await this.orders.list(user, q.status ?? [], q.q, { limit: q.limit, cursor: q.cursor }, {
      serviceAreaId: q.serviceAreaId,
      driverId: q.driverId,
    });
    return { orders: page.items, nextCursor: page.nextCursor };
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.get(user, id);
  }

  @Get(':id/tracking')
  tracking(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.tracking(user, id);
  }

  /** Checkout: converts the cart into an order. Prices and totals are computed on the server. */
  @Roles('CUSTOMER')
  @Post()
  async place(@CurrentUser() user: AuthUser, @Body() dto: PlaceOrderDto) {
    return { order: await this.orders.place(user, dto.addressId) };
  }

  @Roles('CUSTOMER')
  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return { order: await this.orders.cancelByCustomer(user, id) };
  }

  /** Customer: SMS the delivery OTP again (it is also shown in the order screen). */
  @Roles('CUSTOMER')
  @Post(':id/delivery-otp/resend')
  @HttpCode(200)
  resendOtp(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.resendDeliveryOtp(user, id);
  }

  @Roles('ADMIN')
  @Post(':id/confirm')
  @HttpCode(200)
  async confirm(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return { order: await this.orders.confirm(user, id) };
  }

  @Roles('ADMIN')
  @Post(':id/assign')
  @HttpCode(200)
  async assign(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignDriverDto) {
    return { order: await this.orders.assign(user, id, dto.driverId) };
  }

  @Roles('ADMIN')
  @Post(':id/reject')
  @HttpCode(200)
  async reject(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectOrderDto) {
    return { order: await this.orders.reject(user, id, dto.reason.trim()) };
  }
}
