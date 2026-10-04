import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles, type AuthUser } from '../../common/auth.decorators';
import { CreateProductDto, ProductQuery, UpdateProductDto } from './products.dto';
import { ProductsService } from './products.service';

@ApiTags('Products')
@ApiBearerAuth()
@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  /** Active catalogue with search (`q`), category slug, `damaged` and `outOfStock` filters. */
  @Get()
  async list(@Query() q: ProductQuery, @CurrentUser() user: AuthUser) {
    const page = await this.products.list(q, user.role === 'ADMIN');
    return { products: page.items, nextCursor: page.nextCursor };
  }

  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return { product: await this.products.get(id, user.role === 'ADMIN') };
  }

  @Roles('ADMIN')
  @Post()
  async create(@Body() dto: CreateProductDto) {
    return { product: await this.products.create(dto) };
  }

  @Roles('ADMIN')
  @Patch(':id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProductDto) {
    return { product: await this.products.update(id, dto) };
  }

  @Roles('ADMIN')
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.products.remove(id);
  }
}
