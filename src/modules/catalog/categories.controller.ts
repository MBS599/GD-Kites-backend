import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Matches, Min, MinLength } from 'class-validator';
import { Roles } from '../../common/auth.decorators';
import { categoryOut } from '../../common/serializers';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';

export class CreateCategoryDto {
  /** lowerCamelCase identifier, e.g. "fighterKites". */
  @Matches(/^[a-z][a-zA-Z0-9]{1,40}$/, { message: 'Slug must be lowerCamelCase letters/digits.' }) slug: string;
  @IsString() @MinLength(2) name: string;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
}

export class UpdateCategoryDto {
  @IsOptional() @IsString() @MinLength(2) name?: string;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

@ApiTags('Categories')
@ApiBearerAuth()
@Controller('categories')
export class CategoriesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  @Get()
  async list() {
    const list = await this.prisma.category.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } });
    return { categories: list.map(categoryOut) };
  }

  @Roles('ADMIN')
  @Post()
  async create(@Body() dto: CreateCategoryDto) {
    const c = await this.prisma.category.create({ data: { ...dto, name: dto.name.trim() } });
    this.realtime.catalogUpdated('');
    return { category: categoryOut(c) };
  }

  @Roles('ADMIN')
  @Patch(':id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCategoryDto) {
    const exists = await this.prisma.category.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Category not found.');
    const c = await this.prisma.category.update({ where: { id }, data: dto });
    this.realtime.catalogUpdated('');
    return { category: categoryOut(c) };
  }
}
