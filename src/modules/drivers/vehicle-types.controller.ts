import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags, PartialType } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
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
    const v = await this.prisma.vehicleType.create({
      data: {
        name: dto.name.trim(),
        baseFare: new Prisma.Decimal(dto.baseFare),
        perKm: new Prisma.Decimal(dto.perKm),
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
    const v = await this.prisma.vehicleType.update({
      where: { id },
      data: {
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
