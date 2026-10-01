import { PageQuery } from '../../common/paging';
import { PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUrl, MaxLength, Min, MinLength, ValidateIf, IsBoolean } from 'class-validator';

/**
 * Prices are whole rupees (stored as DECIMAL(10,2) so paise can be enabled
 * later without a migration).
 */
export class CreateProductDto {
  @IsString() @MinLength(2, { message: 'Product name is required.' }) @MaxLength(120) name: string;

  /** Category slug, e.g. "fighterKites". */
  @IsString() category: string;

  @IsInt({ message: 'Price must be a whole number of rupees.' }) @Min(1, { message: 'Price must be greater than 0.' })
  price: number;

  @IsOptional() @IsString() @MinLength(1) unit?: string;

  @IsInt() @Min(1, { message: 'Minimum quantity must be at least 1.' }) minOrderQty: number;

  /** Initial stock. After creation, change stock through the inventory endpoints. */
  @IsInt() @Min(0, { message: 'Stock cannot be negative.' }) stock: number;

  @IsOptional() @IsInt() @Min(0) lowStockThreshold?: number;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() material?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() size?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) slabQty?: number | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) slabPrice?: number | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  imageUrl?: string | null;
}

export class UpdateProductDto extends PartialType(CreateProductDto) {}

export class ProductQuery extends PageQuery {
  @IsOptional() @IsString() @Transform(({ value }) => String(value).trim()) q?: string;
  @IsOptional() @IsString() category?: string;

  /** Only products at or below their low-stock threshold. */
  @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean() lowStock?: boolean;
}
