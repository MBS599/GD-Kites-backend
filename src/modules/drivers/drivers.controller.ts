import { PageQuery } from '../../common/paging';
import { Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { CurrentUser, Roles, type AuthUser } from '../../common/auth.decorators';
import { PHONE_MSG, PHONE_RE } from '../../common/validation';
import { DriversService } from './drivers.service';

export class AvailabilityDto {
  @IsIn(['available', 'offline']) availability: 'available' | 'offline';
}

export class LocationDto {
  @IsLatitude() lat: number;
  @IsLongitude() lng: number;
}

export class CreateDriverDto {
  @IsString() @MinLength(2) name: string;
  /** Google account email the driver will sign in with. */
  @IsEmail() email: string;
  @Matches(PHONE_RE, { message: PHONE_MSG }) phone: string;
  @IsIn(['gd', 'external']) type: 'gd' | 'external';
  @IsString() @MinLength(4) vehicleNumber: string;
  /** Area the driver works in; defaults to the first active area. */
  @IsOptional() @IsUUID() serviceAreaId?: string;
  /** Vehicle category (sets the fare); defaults to the first active type. */
  @IsOptional() @IsUUID() vehicleTypeId?: string;
}

/** Admin edit of a driver's vehicle and fare. */
export class UpdateDriverDto {
  @IsOptional() @IsUUID() vehicleTypeId?: string;
  @IsOptional() @IsString() @MinLength(4) vehicleNumber?: string;
  @IsOptional() @IsIn(['gd', 'external']) type?: 'gd' | 'external';
  /**
   * Negotiated fare for this driver, overriding the vehicle type's rates.
   * Send both values to set, or both as null to go back to the vehicle rate.
   */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100000)
  customBaseFare?: number | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(10000)
  customPerKm?: number | null;
}

export class DriverAreaDto {
  @IsUUID() serviceAreaId: string;
}

export class DriverListQuery extends PageQuery {
  @IsOptional() @IsUUID() serviceAreaId?: string;
}

export const driverIdOf = (user: AuthUser) => {
  if (user.role !== 'DRIVER' || !user.driverProfile) throw new ForbiddenException('No driver profile is linked to this account.');
  return user.driverProfile.id;
};

@ApiTags('Drivers')
@ApiBearerAuth()
@Controller('drivers')
export class DriversController {
  constructor(private readonly drivers: DriversService) {}

  /** Driver dashboard: profile, availability and today's delivery stats. */
  @Roles('DRIVER')
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.drivers.dashboard(driverIdOf(user));
  }

  @Roles('DRIVER')
  @Patch('me/availability')
  async availability(@CurrentUser() user: AuthUser, @Body() dto: AvailabilityDto) {
    return { driver: await this.drivers.setAvailability(driverIdOf(user), dto.availability === 'available') };
  }

  /** REST fallback for live location (the app normally sends `driver:location` over the socket). */
  @Roles('DRIVER')
  @Post('me/location')
  @HttpCode(200)
  async location(@CurrentUser() user: AuthUser, @Body() dto: LocationDto) {
    const saved = await this.drivers.updateLocation(driverIdOf(user), dto.lat, dto.lng);
    if (!saved) throw new ConflictException('You are offline. Go on duty to share your location.');
    return saved;
  }

  @Roles('ADMIN')
  @Get()
  async list(@Query() q: DriverListQuery) {
    const page = await this.drivers.list(q.serviceAreaId, q);
    return { drivers: page.items, nextCursor: page.nextCursor };
  }

  @Roles('ADMIN')
  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.drivers.detail(id);
  }

  /** Change a driver's vehicle type/number or set a custom (per-driver) fare. */
  @Roles('ADMIN')
  @Patch(':id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDriverDto) {
    return {
      driver: await this.drivers.update(id, {
        ...dto,
        type: dto.type === undefined ? undefined : dto.type === 'gd' ? 'GD' : 'EXTERNAL',
      }),
    };
  }

  /** Move a driver to another service area (no open deliveries allowed). */
  @Roles('ADMIN')
  @Patch(':id/service-area')
  async setArea(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DriverAreaDto) {
    return { driver: await this.drivers.setServiceArea(id, dto.serviceAreaId) };
  }

  @Roles('ADMIN')
  @Post()
  async create(@Body() dto: CreateDriverDto) {
    return {
      driver: await this.drivers.create({ ...dto, type: dto.type === 'gd' ? 'GD' : 'EXTERNAL' }),
    };
  }
}
