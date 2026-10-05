import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { CurrentUser, Roles, type AuthUser } from '../../common/auth.decorators';
import { serviceAreaOut } from '../../common/serializers';
import { PrismaService } from '../../prisma/prisma.service';
import { RADIUS_CEILING_KM, SettingsService } from '../settings/settings.controller';
import { ServiceAreasService } from './service-areas.service';


export class CreateServiceAreaDto {
  /** Display name, e.g. "Pune" or "Ahilyanagar". Unique. */
  @IsString() @MinLength(2) @MaxLength(60) name: string;
  @IsString() @MinLength(2) @MaxLength(60) city: string;
  @IsLatitude() centerLat: number;
  @IsLongitude() centerLng: number;
  /** Geofence radius in km; must not exceed the admin setting `maxServiceRadiusKm` (default 100). */
  @IsNumber() @Min(0.5) @Max(RADIUS_CEILING_KM) radiusKm: number;
  /** Dispatch hub; defaults to the centre. */
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) hubName?: string;
  @IsOptional() @IsLatitude() hubLat?: number;
  @IsOptional() @IsLongitude() hubLng?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateServiceAreaDto extends PartialType(CreateServiceAreaDto) {}

export class AreaListQuery {
  /** Admin only: include inactive areas. */
  @IsOptional() @Transform(({ value }) => value === 'true' || value === true) @IsBoolean() all?: boolean;
}


@ApiTags('Service areas')
@ApiBearerAuth()
@Controller('service-areas')
export class ServiceAreasController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly areas: ServiceAreasService,
    private readonly settings: SettingsService,
  ) {}

  private async checkRadius(radiusKm: number | undefined) {
    if (radiusKm === undefined) return;
    const { maxServiceRadiusKm } = await this.settings.get();
    if (radiusKm > maxServiceRadiusKm) {
      throw new BadRequestException(
        `Radius cannot exceed ${maxServiceRadiusKm} km. Raise the maximum in service area settings first.`,
      );
    }
  }

  /** Where we deliver. Customers/drivers get active areas; admins may pass `all=true`. */
  @Get()
  async list(@CurrentUser() user: AuthUser, @Query() q: AreaListQuery) {
    const includeInactive = q.all && user.role === 'ADMIN';
    const rows = await this.prisma.serviceArea.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
    const counts = includeInactive
      ? await this.prisma.address.groupBy({ by: ['serviceAreaId'], where: { isDeleted: false }, _count: { _all: true } })
      : [];
    return {
      serviceAreas: rows.map((a) => ({
        ...serviceAreaOut(a),
        ...(includeInactive
          ? { customerAddresses: counts.find((c) => c.serviceAreaId === a.id)?._count._all ?? 0 }
          : {}),
      })),
    };
  }

  @Roles('ADMIN')
  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return { serviceArea: serviceAreaOut(await this.areas.get(id)) };
  }

  @Roles('ADMIN')
  @Post()
  async create(@Body() dto: CreateServiceAreaDto) {
    await this.checkRadius(dto.radiusKm);
    const a = await this.prisma.serviceArea.create({
      data: {
        name: dto.name.trim(),
        city: dto.city.trim(),
        centerLat: dto.centerLat,
        centerLng: dto.centerLng,
        radiusKm: dto.radiusKm,
        hubName: dto.hubName?.trim() || `${dto.name.trim()} hub`,
        hubLat: dto.hubLat ?? dto.centerLat,
        hubLng: dto.hubLng ?? dto.centerLng,
        isActive: dto.isActive ?? true,
      },
    });
    return { serviceArea: serviceAreaOut(a) };
  }

  /**
   * Edit the geofence/hub or switch an area on/off. Placed orders keep their
   * charges and fares.
   */
  @Roles('ADMIN')
  @Patch(':id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateServiceAreaDto) {
    const existing = await this.areas.get(id);
    // Only a changed radius is checked, so areas larger than a later-lowered max stay editable.
    if (dto.radiusKm !== undefined && dto.radiusKm !== existing.radiusKm) await this.checkRadius(dto.radiusKm);
    const a = await this.prisma.serviceArea.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        city: dto.city?.trim(),
        centerLat: dto.centerLat,
        centerLng: dto.centerLng,
        radiusKm: dto.radiusKm,
        hubName: dto.hubName?.trim(),
        hubLat: dto.hubLat,
        hubLng: dto.hubLng,
        isActive: dto.isActive,
      },
    });
    return { serviceArea: serviceAreaOut(a) };
  }
}
