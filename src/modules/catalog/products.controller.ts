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

  /** Active catalogue with search (`q`) and category slug filter. */
  @Get()
  async list(@Query() q: ProductQuery) {
    const page = await this.products.list(q);
    return { products: page.items, nextCursor: page.nextCursor };
  }

  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return { product: await this.products.get(id) };
  }

  @Roles('ADMIN')
  @Post()
  async create(@Body() dto: CreateProductDto, @CurrentUser() user: AuthUser) {
    return { product: await this.products.create(dto, user.id) };
  }

  @Roles('ADMIN')
  @Patch(':id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProductDto, @CurrentUser() user: AuthUser) {
    return { product: await this.products.update(id, dto, user.id) };
  }

  @Roles('ADMIN')
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.products.remove(id);
  }
}
