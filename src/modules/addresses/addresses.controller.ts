import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags, PartialType } from '@nestjs/swagger';
import type { Address } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsBoolean, IsLatitude, IsLongitude, IsNumber, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { CurrentUser, Roles, type AuthUser } from '../../common/auth.decorators';
import { addressOut } from '../../common/serializers';
import { distanceFromHub, findServiceArea } from '../../domain/geofence';
import { deliveryChargeFor, onlineChargesFor } from '../../domain/pricing';
import { SettingsService } from '../settings/settings.controller';
import { deliveryTariffOf } from '../../common/rates';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env';
import { ServiceAreasService } from '../service-areas/service-areas.service';
import { normalizeIndianMobile } from '../sms/sms.service';

/** 10-digit Indian mobile, optionally with +91 / 0 and spaces: "98220 11122", "+91 98220 11122". */
const MOBILE_RE = /^(\+?91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}$/;
const MOBILE_MSG = 'Enter a valid 10-digit Indian mobile number.';

export class CreateAddressDto {
  /** "Shop", "Godown"… (defaults to "Shop"). */
  @IsOptional() @IsString() @MaxLength(40) label?: string;
  @IsOptional() @IsString() @MaxLength(80) contactName?: string;
  @IsOptional() @Matches(MOBILE_RE, { message: MOBILE_MSG }) contactPhone?: string;
  /** Empty string clears it. */
  @IsOptional()
  @Matches(/^$|^(\+?91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}$/, { message: 'Enter a valid 10-digit alternate mobile number.' })
  alternatePhone?: string;
  @IsOptional() @IsString() @MaxLength(40) houseNumber?: string;
  @IsOptional() @IsString() @MaxLength(80) buildingName?: string;
  @IsOptional() @IsString() @MaxLength(120) street?: string;
  /** Older apps send this combined line instead of houseNumber/buildingName/street. */
  @IsOptional() @IsString() @MaxLength(200) line?: string;
  @IsString() @MaxLength(80) area: string;
  @IsOptional() @IsString() @MaxLength(120) landmark?: string;
  @IsOptional() @IsString() @MaxLength(60) city?: string;
  @IsOptional() @IsString() @MaxLength(60) state?: string;
  @Matches(/^[1-9]\d{5}$/, { message: 'Enter a valid 6-digit PIN code.' }) pincode: string;
  @IsOptional() @IsString() @MaxLength(200) instructions?: string;
  @IsLatitude() lat: number;
  @IsLongitude() lng: number;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}

export class UpdateAddressDto extends PartialType(CreateAddressDto) {}

export class QuoteQuery {
  @Type(() => Number) @IsNumber() @IsLatitude() lat: number;
  @Type(() => Number) @IsNumber() @IsLongitude() lng: number;
}

/** Trimmed single-line text without control characters; null when empty. */
function clean(v: string | null | undefined): string | null {
  if (v == null) return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length ? s : null;
}

/** "+91 98220 11122" for any accepted way of writing an Indian mobile. */
function formatMobile(raw: string | null | undefined): string | null {
  const n = normalizeIndianMobile(raw);
  return n ? `+91 ${n.slice(2, 7)} ${n.slice(7)}` : null;
}

/** "Shop 4, Laxmi Market, Satara Road" from the parts the customer filled in. */
function lineOf(a: { houseNumber?: string | null; buildingName?: string | null; street?: string | null }) {
  return [a.houseNumber, a.buildingName, a.street].map(clean).filter(Boolean).join(', ');
}

@ApiTags('Addresses')
@ApiBearerAuth()
@Roles('CUSTOMER')
@Controller('addresses')
export class AddressesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly areas: ServiceAreasService,
    private readonly config: ConfigService<Env, true>,
    private readonly settings: SettingsService,
  ) {}

  /** Default address first. Coverage is re-evaluated against current service areas on every read. */
  @Get()
  async list(@CurrentUser() user: AuthUser) {
    const [list, active] = await Promise.all([
      this.prisma.address.findMany({
        where: { userId: user.id, isDeleted: false },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      }),
      this.areas.active(),
    ]);
    // Every customer with addresses has a default (rows saved before defaults existed get their oldest).
    if (list.length && !list.some((a) => a.isDefault)) {
      await this.prisma.address.update({ where: { id: list[0].id }, data: { isDefault: true } }).catch(() => undefined);
      list[0] = { ...list[0], isDefault: true };
    }
    return {
      addresses: list.map((a) => {
        const area = findServiceArea(active, a.lat, a.lng);
        return addressOut({
          ...a,
          serviceArea: area,
          distanceKm: area ? distanceFromHub(area, a.lat, a.lng) : a.distanceKm,
        });
      }),
    };
  }

  /** Only points inside an active service area can be saved (422 otherwise). The first address becomes the default. */
  @Post()
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateAddressDto) {
    const { area, distanceKm } = await this.areas.require(dto.lat, dto.lng);
    const fields = this.fields(dto, null);
    const address = await this.prisma.tx(async (tx) => {
      const live = await tx.address.count({ where: { userId: user.id, isDeleted: false } });
      const isDefault = dto.isDefault === true || live === 0;
      if (isDefault) await tx.address.updateMany({ where: { userId: user.id, isDefault: true }, data: { isDefault: false } });
      return tx.address.create({
        data: {
          ...fields,
          userId: user.id,
          serviceAreaId: area.id,
          city: fields.city ?? area.city,
          lat: dto.lat,
          lng: dto.lng,
          distanceKm,
          contactName: fields.contactName ?? user.businessName ?? user.name,
          contactPhone: fields.contactPhone ?? user.phone,
          isDefault,
        },
        include: { serviceArea: true },
      });
    });
    return { address: addressOut(address) };
  }

  /**
   * Edit a saved address (any subset of fields). Moving the pin re-checks the delivery
   * area and distance. Past orders keep their own snapshot and never change.
   */
  @Patch(':id')
  async update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAddressDto) {
    const current = await this.prisma.address.findFirst({ where: { id, userId: user.id, isDeleted: false } });
    if (!current) throw new NotFoundException('Address not found.');
    if ((dto.lat == null) !== (dto.lng == null)) throw new BadRequestException('Send both lat and lng to move the pin.');
    const moved = dto.lat != null && dto.lng != null && (dto.lat !== current.lat || dto.lng !== current.lng);
    const coverage = moved ? await this.areas.require(dto.lat!, dto.lng!) : null;
    const fields = this.fields(dto, current);
    const address = await this.prisma.tx(async (tx) => {
      if (dto.isDefault === true) {
        await tx.address.updateMany({ where: { userId: user.id, isDefault: true, NOT: { id } }, data: { isDefault: false } });
      }
      return tx.address.update({
        where: { id },
        data: {
          ...fields,
          city: fields.city ?? current.city,
          ...(coverage && { lat: dto.lat, lng: dto.lng, serviceAreaId: coverage.area.id, distanceKm: coverage.distanceKm }),
          ...(dto.isDefault === true && { isDefault: true }),
        },
        include: { serviceArea: true },
      });
    });
    return { address: addressOut(address) };
  }

  /** Make this the customer's default delivery address. */
  @Post(':id/default')
  async makeDefault(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const address = await this.prisma.tx(async (tx) => {
      const found = await tx.address.findFirst({ where: { id, userId: user.id, isDeleted: false } });
      if (!found) throw new NotFoundException('Address not found.');
      await tx.address.updateMany({ where: { userId: user.id, isDefault: true, NOT: { id } }, data: { isDefault: false } });
      return tx.address.update({ where: { id }, data: { isDefault: true }, include: { serviceArea: true } });
    });
    return { address: addressOut(address) };
  }

  /**
   * Cleans and checks the text fields of a create or a (partial) update. [current] is the
   * saved address on update: fields left out keep their value.
   */
  private fields(dto: UpdateAddressDto, current: Address | null) {
    const pick = <K extends keyof UpdateAddressDto & keyof Address>(k: K) =>
      dto[k] !== undefined ? clean(dto[k] as string | null) : current ? (current[k] as string | null) : null;

    const houseNumber = pick('houseNumber');
    const buildingName = pick('buildingName');
    const street = pick('street');
    const structured = dto.houseNumber !== undefined || dto.buildingName !== undefined || dto.street !== undefined;
    const line = structured || !dto.line ? lineOf({ houseNumber, buildingName, street }) || current?.line || '' : clean(dto.line)!;
    if (dto.line !== undefined || structured || !current) {
      if (line.length < 3) throw new BadRequestException('Enter the house / shop number and street.');
    }
    const area = pick('area');
    if (!current || dto.area !== undefined) {
      if (!area || area.length < 2) throw new BadRequestException('Area is required.');
    }

    const contactPhone = dto.contactPhone !== undefined ? formatMobile(dto.contactPhone) : (current?.contactPhone ?? null);
    const alternatePhone =
      dto.alternatePhone !== undefined ? formatMobile(dto.alternatePhone) : (current?.alternatePhone ?? null);
    if (alternatePhone && contactPhone && normalizeIndianMobile(alternatePhone) === normalizeIndianMobile(contactPhone)) {
      throw new BadRequestException('The alternate mobile number must be different from the primary one.');
    }

    return {
      label: pick('label') ?? (current ? current.label : 'Shop'),
      contactName: pick('contactName'),
      contactPhone,
      alternatePhone,
      houseNumber,
      buildingName,
      street,
      line,
      area: area ?? current!.area,
      landmark: pick('landmark'),
      city: pick('city') ?? current?.city ?? null,
      state: pick('state'),
      pincode: dto.pincode ?? current?.pincode ?? '',
      instructions: pick('instructions'),
    };
  }

  /** Whether a point is deliverable and, if so, the distance from its hub and the delivery charge. */
  @Get('quote')
  async quote(@Query() q: QuoteQuery) {
    const hit = await this.areas.resolve(q.lat, q.lng);
    if (!hit) {
      const names = (await this.areas.active()).map((a) => a.name);
      return {
        serviceable: false,
        serviceArea: null,
        servedAreas: names,
        distanceKm: null,
        deliveryCharge: null,
        deliveryTax: 0,
        paymentFee: 0,
        payOnline: 0,
      };
    }
    const settings = await this.settings.get();
    const deliveryCharge = deliveryChargeFor(hit.distanceKm, deliveryTariffOf(settings.deliveryVehicleType));
    // Online payments: delivery charge + GST + gateway fee paid now; the items in cash on delivery.
    const online = this.config.get('PAYMENTS_PROVIDER') === 'razorpay' && deliveryCharge > 0;
    const s = online ? settings : null;
    const charges = s ? onlineChargesFor(deliveryCharge, s.deliveryGstPercent, s.gatewayFeePercent) : null;
    return {
      serviceable: true,
      serviceArea: { id: hit.area.id, name: hit.area.name },
      distanceKm: hit.distanceKm,
      deliveryCharge,
      deliveryTax: charges?.tax ?? 0,
      paymentFee: charges?.fee ?? 0,
      deliveryGstPercent: s?.deliveryGstPercent ?? 0,
      /** Paid online at checkout; 0 = everything cash on delivery. */
      payOnline: charges?.total ?? 0,
    };
  }

  /** Soft delete — past orders keep their address snapshot. A removed default passes to the oldest remaining address. */
  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.prisma.tx(async (tx) => {
      const found = await tx.address.findFirst({ where: { id, userId: user.id, isDeleted: false } });
      if (!found) throw new NotFoundException('Address not found.');
      await tx.address.update({ where: { id }, data: { isDeleted: true, isDefault: false } });
      if (found.isDefault) {
        const next = await tx.address.findFirst({
          where: { userId: user.id, isDeleted: false },
          orderBy: { createdAt: 'asc' },
        });
        if (next) await tx.address.update({ where: { id: next.id }, data: { isDefault: true } });
      }
    });
  }
}
