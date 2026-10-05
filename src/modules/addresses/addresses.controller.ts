import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsLatitude, IsLongitude, IsNumber, IsOptional, IsString, Matches, MinLength } from 'class-validator';
import { CurrentUser, Roles, type AuthUser } from '../../common/auth.decorators';
import { addressOut } from '../../common/serializers';
import { PHONE_MSG, PHONE_RE } from '../../common/validation';
import { distanceFromHub, findServiceArea } from '../../domain/geofence';
import { deliveryChargeFor, onlineChargesFor } from '../../domain/pricing';
import { SettingsService } from '../settings/settings.controller';
import { deliveryTariffOf } from '../../common/rates';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env';
import { ServiceAreasService } from '../service-areas/service-areas.service';

export class CreateAddressDto {
  @IsString() @MinLength(1, { message: 'Give this address a name.' }) label: string;
  @IsString() @MinLength(2, { message: 'Area is required.' }) area: string;
  @IsString() @MinLength(3, { message: 'Street / shop details are required.' }) line: string;
  @IsOptional() @IsString() @MinLength(2) city?: string;
  @Matches(/^\d{6}$/, { message: 'Enter a 6-digit pincode.' }) pincode: string;
  @IsLatitude() lat: number;
  @IsLongitude() lng: number;
  @IsOptional() @IsString() contactName?: string;
  @IsOptional() @Matches(PHONE_RE, { message: PHONE_MSG }) contactPhone?: string;
}

export class QuoteQuery {
  @Type(() => Number) @IsNumber() @IsLatitude() lat: number;
  @Type(() => Number) @IsNumber() @IsLongitude() lng: number;
}

@ApiTags('Addresses')
@ApiBearerAuth()
@Roles('CUSTOMER')
@Controller('addresses')
export class AddressesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly areas: ServiceAreasService,
    private readonly config: ConfigService<Env, true>,
    private readonly settings: SettingsService,
  ) {}

  /** Coverage is re-evaluated against current service areas on every read. */
  @Get()
  async list(@CurrentUser() user: AuthUser) {
    const [list, active] = await Promise.all([
      this.prisma.address.findMany({ where: { userId: user.id, isDeleted: false }, orderBy: { createdAt: 'asc' } }),
      this.areas.active(),
    ]);
    return {
      addresses: list.map((a) => {
        const area = findServiceArea(active, a.lat, a.lng);
        return addressOut({
          ...a,
          serviceArea: area,
          distanceKm: area ? distanceFromHub(area, a.lat, a.lng) : a.distanceKm,
        });
      }),
    };
  }

  /** Only points inside an active service area can be saved (422 otherwise). */
  @Post()
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateAddressDto) {
    const { area, distanceKm } = await this.areas.require(dto.lat, dto.lng);
    const address = await this.prisma.address.create({
      data: {
        userId: user.id,
        serviceAreaId: area.id,
        label: dto.label.trim(),
        area: dto.area.trim(),
        line: dto.line.trim(),
        city: dto.city?.trim() || area.city,
        pincode: dto.pincode,
        lat: dto.lat,
        lng: dto.lng,
        distanceKm,
        contactName: dto.contactName?.trim() || user.businessName || user.name,
        contactPhone: dto.contactPhone?.trim() || user.phone,
      },
      include: { serviceArea: true },
    });
    return { address: addressOut(address) };
  }

  /** Whether a point is deliverable and, if so, the distance from its hub and the delivery charge. */
  @Get('quote')
  async quote(@Query() q: QuoteQuery) {
    const hit = await this.areas.resolve(q.lat, q.lng);
    if (!hit) {
      const names = (await this.areas.active()).map((a) => a.name);
      return {
        serviceable: false,
        serviceArea: null,
        servedAreas: names,
        distanceKm: null,
        deliveryCharge: null,
        deliveryTax: 0,
        paymentFee: 0,
        payOnline: 0,
      };
    }
    const settings = await this.settings.get();
    const deliveryCharge = deliveryChargeFor(hit.distanceKm, deliveryTariffOf(settings.deliveryVehicleType));
    // Online payments: delivery charge + GST + gateway fee paid now; the items in cash on delivery.
    const online = this.config.get('PAYMENTS_PROVIDER') === 'razorpay' && deliveryCharge > 0;
    const s = online ? settings : null;
    const charges = s ? onlineChargesFor(deliveryCharge, s.deliveryGstPercent, s.gatewayFeePercent) : null;
    return {
      serviceable: true,
      serviceArea: { id: hit.area.id, name: hit.area.name },
      distanceKm: hit.distanceKm,
      deliveryCharge,
      deliveryTax: charges?.tax ?? 0,
      paymentFee: charges?.fee ?? 0,
      deliveryGstPercent: s?.deliveryGstPercent ?? 0,
      /** Paid online at checkout; 0 = everything cash on delivery. */
      payOnline: charges?.total ?? 0,
    };
  }

  /** Soft delete — past orders keep their address snapshot. */
  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const res = await this.prisma.address.updateMany({
      where: { id, userId: user.id, isDeleted: false },
      data: { isDeleted: true },
    });
    if (res.count === 0) throw new NotFoundException('Address not found.');
  }
}
