import { BadRequestException, Body, Controller, Get, Injectable, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsInt, IsNumber, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Roles } from '../../common/auth.decorators';
import type { AppSettings, VehicleType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { deliveryTariffOf } from '../../common/rates';
import { vehicleTypeOut } from '../../common/serializers';
import type { Tariff } from '../../domain/pricing';

/** Hard ceiling (also enforced by a DB CHECK constraint). */
export const RADIUS_CEILING_KM = 1000;

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The single settings row (created with defaults if missing). */
  get() {
    return this.prisma.appSettings.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: {},
      include: { deliveryVehicleType: true },
    });
  }

  /** Customer delivery charge rate: the delivery vehicle's (Tempo) base + per km. */
  async deliveryTariff(): Promise<Tariff> {
    return deliveryTariffOf((await this.get()).deliveryVehicleType);
  }

  /** Smallest cart subtotal a customer can order, in rupees (0 = none). */
  async minOrderValue(): Promise<number> {
    const s = await this.prisma.appSettings.findUnique({ where: { id: 1 }, select: { minOrderValue: true } });
    return s ? s.minOrderValue.toNumber() : 1000;
  }

  /** The WhatsApp-linked business number as +91…, or null when no phone is linked. */
  async contactNumber(): Promise<string | null> {
    const s = await this.prisma.appSettings.findUnique({ where: { id: 1 }, select: { whatsappNumber: true } });
    return s?.whatsappNumber ? `+${s.whatsappNumber}` : null;
  }
}

export class UpdateSettingsDto {
  /** Largest radius (km) an admin may give a service area. Default 100. */
  @IsOptional() @IsNumber() @Min(1) @Max(RADIUS_CEILING_KM) maxServiceRadiusKm?: number;
  /** Delivery planning: orders join a group within this distance (km) of its first order. Default 4. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 1 }) @Min(0.5) @Max(RADIUS_CEILING_KM) dispatchRadiusKm?: number;
  /** Delivery planning: most orders suggested for one driver. Default 8. */
  @IsOptional() @IsInt() @Min(1) @Max(100) dispatchMaxOrders?: number;
  /** Online payment: GST % on the delivery charge. Default 18. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(28) deliveryGstPercent?: number;
  /** Online payment: Razorpay fee % passed to the customer (0 = absorbed). Default 2. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(5) gatewayFeePercent?: number;
  /** Smallest cart value (goods, before delivery) in rupees. 0 = no minimum. Default 1000. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(10_000_000) minOrderValue?: number;
  /** Vehicle type whose rate sets the customer delivery charge (the Tempo). */
  @IsOptional() @IsUUID() deliveryVehicleTypeId?: string;
}

const out = (s: AppSettings & { deliveryVehicleType: VehicleType | null }) => ({
  maxServiceRadiusKm: s.maxServiceRadiusKm,
  dispatchRadiusKm: s.dispatchRadiusKm,
  dispatchMaxOrders: s.dispatchMaxOrders,
  deliveryGstPercent: s.deliveryGstPercent,
  gatewayFeePercent: s.gatewayFeePercent,
  minOrderValue: s.minOrderValue.toNumber(),
  /** Customer delivery charge = this vehicle's baseFare + perKm × km (null = default ₹150 + ₹25/km). */
  deliveryVehicleType: s.deliveryVehicleType ? vehicleTypeOut(s.deliveryVehicleType) : null,
});

@ApiTags('Settings')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('settings')
export class SettingsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  @Get()
  async get() {
    return { settings: out(await this.settings.get()) };
  }

  /** Lowering the max does not shrink existing areas; it only limits future edits. */
  @Patch()
  async update(@Body() dto: UpdateSettingsDto) {
    if (dto.deliveryVehicleTypeId) {
      const v = await this.prisma.vehicleType.findUnique({ where: { id: dto.deliveryVehicleTypeId } });
      if (!v || !v.isActive) throw new BadRequestException('Choose an active vehicle type for the delivery charge.');
    }
    const s = await this.prisma.appSettings.upsert({
      where: { id: 1 },
      create: { id: 1, ...dto },
      update: { ...dto },
      include: { deliveryVehicleType: true },
    });
    return { settings: out(s) };
  }
}
