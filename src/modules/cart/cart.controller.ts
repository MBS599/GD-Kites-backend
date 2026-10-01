import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsInt, IsUUID, Max, Min } from 'class-validator';
import { CurrentUser, Roles, type AuthUser } from '../../common/auth.decorators';
import { CartService } from './cart.service';

export class AddCartItemDto {
  @IsUUID() productId: string;
  @IsInt() @Min(1) @Max(1_000_000) qty: number;
}

export class SetQtyDto {
  @IsInt() @Min(1) @Max(1_000_000) qty: number;
}

@ApiTags('Cart')
@ApiBearerAuth()
@Roles('CUSTOMER')
@Controller('cart')
export class CartController {
  constructor(private readonly cart: CartService) {}

  @Get()
  get(@CurrentUser() user: AuthUser) {
    return this.cart.get(user.id);
  }

  /** Adds to the existing quantity. Validates minimum order and stock. */
  @Post('items')
  add(@CurrentUser() user: AuthUser, @Body() dto: AddCartItemDto) {
    return this.cart.add(user.id, dto.productId, dto.qty);
  }

  /** Sets the exact quantity for a product line. */
  @Patch('items/:productId')
  set(@CurrentUser() user: AuthUser, @Param('productId', ParseUUIDPipe) productId: string, @Body() dto: SetQtyDto) {
    return this.cart.set(user.id, productId, dto.qty);
  }

  @Delete('items/:productId')
  remove(@CurrentUser() user: AuthUser, @Param('productId', ParseUUIDPipe) productId: string) {
    return this.cart.remove(user.id, productId);
  }

  @Delete()
  clear(@CurrentUser() user: AuthUser) {
    return this.cart.clear(user.id);
  }
}
