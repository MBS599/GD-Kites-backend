import { PageQuery } from '../../common/paging';
import { PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/** One line of a combo. */
export class ProductSpecDto {
  @IsString() @MinLength(1) @MaxLength(40) label!: string;
  @IsString() @MinLength(1) @MaxLength(160) value!: string;
}

export class ProductMediaDto {
  @IsIn(['image', 'video']) type!: 'image' | 'video';
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] }) url!: string;
}

export class ComboItemDto {
  @IsUUID() productId: string;
  @IsInt() @Min(1) @Max(100000) qty: number;
}

/**
 * Prices are whole rupees (stored as DECIMAL(10,2) so paise can be enabled
 * later without a migration).
 */
export class CreateProductDto {
  @IsString() @MinLength(2, { message: 'Product name is required.' }) @MaxLength(120) name: string;

  /** Category slug, e.g. "fighterKites". */
  @IsString() category: string;

  /** Rupees, up to 2 decimals (paise), e.g. 9.2. */
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Price can have at most 2 decimals.' })
  @Min(0.01, { message: 'Price must be greater than 0.' })
  price: number;

  /** What the business pays per unit (admin only; for profit). Null clears it. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  costPrice?: number | null;

  @IsOptional() @IsString() @MinLength(1) unit?: string;

  /** Admin switch; customers can't order products that are out of stock. Default true. */
  @IsOptional() @IsBoolean() inStock?: boolean;

  /** Damaged goods sold cheaply; listed in the "Damaged" section. */
  @IsOptional() @IsBoolean() isDamaged?: boolean;
  /** What is wrong with it, shown to customers. */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(300) damageNote?: string | null;
  @IsOptional() @IsString() @MaxLength(5000) description?: string;
  /** Selling points shown as bullets (replaces the list when given). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(160, { each: true })
  highlights?: string[];
  /** Specifications table (replaces the list when given). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ProductSpecDto)
  specs?: ProductSpecDto[];
  /** Photo/video gallery in display order (replaces the list when given). The first photo becomes the cover. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(15)
  @ValidateNested({ each: true })
  @Type(() => ProductMediaDto)
  media?: ProductMediaDto[];
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() material?: string | null;
  /** From the size master; null for none. */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() sizeId?: string | null;

  /** A combo of other products at its own price. Needs [comboItems]. */
  @IsOptional() @IsBoolean() isCombo?: boolean;
  /** Combo contents (replaces the whole list when given). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => ComboItemDto)
  comboItems?: ComboItemDto[];
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) slabQty?: number | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) slabPrice?: number | null;

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
  /** true: only combos (the "Combos" section); false: no combos; omit for all. */
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  combo?: boolean;
  /** Admin: only products switched to out of stock. */
  @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean() outOfStock?: boolean;
}
