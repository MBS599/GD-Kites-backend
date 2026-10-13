import { Body, ConflictException, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Matches, MaxLength, Min, MinLength } from 'class-validator';
import { Prisma } from '@prisma/client';
import { CurrentUser, Roles, type AuthUser } from '../../common/auth.decorators';
import { categoryOut } from '../../common/serializers';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';

export class CreateCategoryDto {
  /** lowerCamelCase identifier, e.g. "fighterKites". Made from the name when left out. */
  @IsOptional() @Matches(/^[a-z][a-zA-Z0-9]{1,40}$/, { message: 'Slug must be lowerCamelCase letters/digits.' }) slug?: string;
  @IsString() @MinLength(2) @MaxLength(40) name: string;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
}

export class UpdateCategoryDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(40) name?: string;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class CategoryListQuery {
  /** Admin: include hidden categories, with product counts. */
  @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean() all?: boolean;
}

/** "Paper Kites & More" → "paperKitesMore" (letters and digits only). */
export function slugFromName(name: string) {
  const words = name.normalize('NFKD').replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const slug = words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join('');
  return /^[a-z]/.test(slug) ? slug.slice(0, 36) : `c${slug}`.slice(0, 36);
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
  async list(@CurrentUser() user: AuthUser, @Query() q: CategoryListQuery) {
    const all = q.all && user?.role === 'ADMIN';
    const list = await this.prisma.category.findMany({
      where: all ? {} : { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { products: { where: { isActive: true } } } } },
    });
    return {
      categories: list.map((c) => ({
        ...categoryOut(c),
        ...(all ? { isActive: c.isActive, products: c._count.products } : {}),
      })),
    };
  }

  @Roles('ADMIN')
  @Post()
  async create(@Body() dto: CreateCategoryDto) {
    const name = dto.name.trim();
    if (await this.prisma.category.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } })) {
      throw new ConflictException('A category with this name already exists.');
    }
    let slug = dto.slug ?? slugFromName(name);
    // A made-up slug that is taken (e.g. by a hidden category) gets a number.
    for (let n = 2; !dto.slug && (await this.prisma.category.findUnique({ where: { slug } })); n++) slug = `${slugFromName(name)}${n}`;
    const last = await this.prisma.category.aggregate({ _max: { sortOrder: true } });
    const c = await this.prisma.category.create({
      data: { slug, name, sortOrder: dto.sortOrder ?? (last._max.sortOrder ?? -1) + 1 },
    });
    this.realtime.catalogUpdated('');
    return { category: categoryOut(c) };
  }

  @Roles('ADMIN')
  @Patch(':id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCategoryDto) {
    const exists = await this.prisma.category.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Category not found.');
    // Products of a hidden category would still show in the app's lists: move or delete them first.
    if (dto.isActive === false && exists.isActive) {
      const products = await this.prisma.product.count({ where: { categoryId: id, isActive: true } });
      if (products > 0) {
        throw new ConflictException(
          `${exists.name} still has ${products} product${products === 1 ? '' : 's'}. Move them to another category or delete them first.`,
        );
      }
    }
    const name = dto.name?.trim();
    if (name && (await this.prisma.category.findFirst({ where: { id: { not: id }, name: { equals: name, mode: 'insensitive' } } }))) {
      throw new ConflictException('A category with this name already exists.');
    }
    const data: Prisma.CategoryUpdateInput = { name, sortOrder: dto.sortOrder, isActive: dto.isActive };
    const c = await this.prisma.category.update({ where: { id }, data });
    this.realtime.catalogUpdated('');
    return { category: categoryOut(c) };
  }
}
