import { BadRequestException, Body, Controller, Get, Injectable, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { readFile } from 'node:fs/promises';
import { Transform } from 'class-transformer';
import { IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { Public } from '../../common/auth.decorators';
import { AppConfig } from '../../config/app-config.service';
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
  /** Force update: Android builds below this must update first. 0 turns it off. */
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000_000) androidMinBuild?: number;
  /** Text on the update screens (what changed). Empty/null for the default. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() || null : value))
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(300)
  updateMessage?: string | null;
}

const out = (s: AppSettings & { deliveryVehicleType: VehicleType | null }) => ({
  maxServiceRadiusKm: s.maxServiceRadiusKm,
  dispatchRadiusKm: s.dispatchRadiusKm,
  dispatchMaxOrders: s.dispatchMaxOrders,
  deliveryGstPercent: s.deliveryGstPercent,
  gatewayFeePercent: s.gatewayFeePercent,
  minOrderValue: s.minOrderValue.toNumber(),
  /** Customer delivery charge = this vehicle's baseFare + perKm × km (null = default ₹50 + ₹10/km for 5 km, then ₹8/km). */
  deliveryVehicleType: s.deliveryVehicleType ? vehicleTypeOut(s.deliveryVehicleType) : null,
  androidMinBuild: s.androidMinBuild,
  updateMessage: s.updateMessage,
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

/** What CI publishes next to the APK (downloads/version.json). */
interface PublishedBuild {
  build: number;
  version: string;
  publishedAt?: string;
}

/**
 * Android app updates. The newest build comes from the version file CI writes next
 * to the APK; the minimum build (force update) and the message are admin settings.
 */
@ApiTags('App')
@Controller('app')
export class AppVersionController {
  private cache?: { at: number; build: PublishedBuild | null };

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  private async published(): Promise<PublishedBuild | null> {
    if (this.cache && Date.now() - this.cache.at < 60_000) return this.cache.build;
    let build: PublishedBuild | null = null;
    try {
      const j = JSON.parse(await readFile(this.config.get('APP_VERSION_FILE'), 'utf8')) as Partial<PublishedBuild>;
      if (Number.isInteger(j.build) && (j.build as number) > 0) {
        build = { build: j.build as number, version: String(j.version ?? ''), publishedAt: j.publishedAt };
      }
    } catch {
      // No APK published yet (or unreadable): no update offered.
    }
    this.cache = { at: Date.now(), build };
    return build;
  }

  /** Public: the app asks on start and when it comes back to the foreground. */
  @Public()
  @Get('version')
  async version() {
    const s = await this.prisma.appSettings.findUnique({
      where: { id: 1 },
      select: { androidMinBuild: true, updateMessage: true },
    });
    const latest = await this.published();
    return {
      android: {
        /** Newest published build (null until CI has published one). */
        latestBuild: latest?.build ?? null,
        latestVersion: latest?.version ?? null,
        publishedAt: latest?.publishedAt ?? null,
        /** Builds below this must update before the app can be used (0 = no force update). */
        minBuild: s?.androidMinBuild ?? 0,
        message: s?.updateMessage ?? null,
        url: this.config.get('APK_URL'),
      },
    };
  }
}
