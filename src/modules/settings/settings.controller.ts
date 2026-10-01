import { Body, Controller, Get, Injectable, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';
import { Roles } from '../../common/auth.decorators';
import { PrismaService } from '../../prisma/prisma.service';

/** Hard ceiling (also enforced by a DB CHECK constraint). */
export const RADIUS_CEILING_KM = 1000;

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The single settings row (created with defaults if missing). */
  get() {
    return this.prisma.appSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  }
}

export class UpdateSettingsDto {
  /** Largest radius (km) an admin may give a service area. Default 100. */
  @IsOptional() @IsNumber() @Min(1) @Max(RADIUS_CEILING_KM) maxServiceRadiusKm?: number;
  /** Delivery planning: orders join a group within this distance (km) of its first order. Default 4. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 1 }) @Min(0.5) @Max(RADIUS_CEILING_KM) dispatchRadiusKm?: number;
  /** Delivery planning: most orders suggested for one driver. Default 8. */
  @IsOptional() @IsInt() @Min(1) @Max(100) dispatchMaxOrders?: number;
}

const out = (s: { maxServiceRadiusKm: number; dispatchRadiusKm: number; dispatchMaxOrders: number }) => ({
  maxServiceRadiusKm: s.maxServiceRadiusKm,
  dispatchRadiusKm: s.dispatchRadiusKm,
  dispatchMaxOrders: s.dispatchMaxOrders,
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
    const s = await this.prisma.appSettings.upsert({
      where: { id: 1 },
      create: { id: 1, ...dto },
      update: { ...dto },
    });
    return { settings: out(s) };
  }
}
