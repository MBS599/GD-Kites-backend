import { Body, ConflictException, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Roles } from '../../common/auth.decorators';
import { sizeOut } from '../../common/serializers';
import { PrismaService } from '../../prisma/prisma.service';

export class CreateSizeDto {
  @IsString() @MinLength(1) @MaxLength(40) name: string;
  @IsOptional() @IsInt() @Min(0) @Max(1000) sortOrder?: number;
}

export class UpdateSizeDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(40) name?: string;
  @IsOptional() @IsInt() @Min(0) @Max(1000) sortOrder?: number;
  /** Hidden sizes stay on existing products but can't be picked for new ones. */
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class SizeQuery {
  /** Admin: include hidden sizes. */
  @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean() all?: boolean;
}

const taken = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/** Size master (Small, Medium, Big…). A product's size is shown in its name for customers. */
@ApiTags('Sizes')
@ApiBearerAuth()
@Controller('sizes')
export class SizesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@Query() q: SizeQuery) {
    const sizes = await this.prisma.size.findMany({
      where: q.all ? {} : { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { products: { where: { isActive: true } } } } },
    });
    return { sizes: sizes.map((s) => ({ ...sizeOut(s), products: s._count.products })) };
  }

  @Roles('ADMIN')
  @Post()
  async create(@Body() dto: CreateSizeDto) {
    const last = await this.prisma.size.aggregate({ _max: { sortOrder: true } });
    try {
      const s = await this.prisma.size.create({
        data: { name: dto.name.trim(), sortOrder: dto.sortOrder ?? (last._max.sortOrder ?? -1) + 1 },
      });
      return { size: sizeOut(s) };
    } catch (e) {
      if (taken(e)) throw new ConflictException('A size with this name already exists.');
      throw e;
    }
  }

  @Roles('ADMIN')
  @Patch(':id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSizeDto) {
    try {
      const s = await this.prisma.size.update({
        where: { id },
        data: { name: dto.name?.trim(), sortOrder: dto.sortOrder, isActive: dto.isActive },
      });
      return { size: sizeOut(s) };
    } catch (e) {
      if (taken(e)) throw new ConflictException('A size with this name already exists.');
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') throw new NotFoundException('Size not found.');
      throw e;
    }
  }
}
