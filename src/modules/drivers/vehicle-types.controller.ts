import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags, PartialType } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { Roles } from '../../common/auth.decorators';
import { vehicleTypeOut } from '../../common/serializers';
import { PrismaService } from '../../prisma/prisma.service';

const MONEY = { maxDecimalPlaces: 2 };

export class CreateVehicleTypeDto {
  /** e.g. "Bike", "Auto rickshaw", "Tempo". Unique. */
  @IsString() @MinLength(2) @MaxLength(40) name: string;
  /** Driver fare = baseFare + perKm × road km from hub (₹). The delivery vehicle's (Tempo) rate is also the customer delivery charge. */
  @IsNumber(MONEY) @Min(0) @Max(100000) baseFare: number;
  @IsNumber(MONEY) @Min(0) @Max(10000) perKm: number;
  /** Two-step rate: perKm for the first tierKm km, then perKmAfter per km. Send both, or both null for one rate. */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber({ maxDecimalPlaces: 1 }) @Min(0.5) @Max(1000) tierKm?: number | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber(MONEY) @Min(0) @Max(10000) perKmAfter?: number | null;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateVehicleTypeDto extends PartialType(CreateVehicleTypeDto) {}

@ApiTags('Vehicle types')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('vehicle-types')
export class VehicleTypesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list() {
    const rows = await this.prisma.vehicleType.findMany({
      orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { drivers: true } } },
    });
    return { vehicleTypes: rows.map((v) => ({ ...vehicleTypeOut(v), drivers: v._count.drivers })) };
  }

  @Post()
  async create(@Body() dto: CreateVehicleTypeDto) {
    const tier = tierOf(dto);
    const v = await this.prisma.vehicleType.create({
      data: {
        name: dto.name.trim(),
        baseFare: new Prisma.Decimal(dto.baseFare),
        perKm: new Prisma.Decimal(dto.perKm),
        ...(tier ?? {}),
        sortOrder: dto.sortOrder ?? 0,
        isActive: dto.isActive ?? true,
      },
    });
    return { vehicleType: vehicleTypeOut(v) };
  }

  /** New rates apply to future orders and assignments; placed orders and deliveries keep theirs. */
  @Patch(':id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateVehicleTypeDto) {
    const exists = await this.prisma.vehicleType.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Vehicle type not found.');
    if (dto.isActive === false) {
      const s = await this.prisma.appSettings.findUnique({ where: { id: 1 } });
      if (s?.deliveryVehicleTypeId === id) {
        throw new BadRequestException('This vehicle sets the customer delivery charge. Choose another one in Settings first.');
      }
    }
    const tier = tierOf(dto);
    const v = await this.prisma.vehicleType.update({
      where: { id },
      data: {
        ...(tier ?? {}),
        name: dto.name?.trim(),
        baseFare: dto.baseFare === undefined ? undefined : new Prisma.Decimal(dto.baseFare),
        perKm: dto.perKm === undefined ? undefined : new Prisma.Decimal(dto.perKm),
        sortOrder: dto.sortOrder,
        isActive: dto.isActive,
      },
    });
    return { vehicleType: vehicleTypeOut(v) };
  }
}

/** The second per-km rate from a request: both values, both null (one rate), or untouched. */
function tierOf(dto: { tierKm?: number | null; perKmAfter?: number | null }) {
  if (dto.tierKm === undefined && dto.perKmAfter === undefined) return null;
  if ((dto.tierKm == null) !== (dto.perKmAfter == null)) {
    throw new BadRequestException('Set both "after km" and "rate after", or clear both.');
  }
  return dto.tierKm == null
    ? { tierKm: null, perKmAfter: null }
    : { tierKm: dto.tierKm, perKmAfter: new Prisma.Decimal(dto.perKmAfter!) };
}
