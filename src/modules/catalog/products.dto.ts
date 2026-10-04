import { PageQuery } from '../../common/paging';
import { PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, IsUrl, IsUUID, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';

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

  /** Admin switch; customers can't order products that are out of stock. Default true. */
  @IsOptional() @IsBoolean() inStock?: boolean;

  /** Damaged goods sold cheaply; listed in the "Damaged" section. */
  @IsOptional() @IsBoolean() isDamaged?: boolean;
  /** What is wrong with it, shown to customers. */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(300) damageNote?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() material?: string | null;
  /** From the size master; null for none. */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() sizeId?: string | null;
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

  /** true: only damaged products (the "Damaged" section); false: only regular ones; omit for all. */
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  damaged?: boolean;
  /** Admin: only products switched to out of stock. */
  @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean() outOfStock?: boolean;
}
