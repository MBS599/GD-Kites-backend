import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, Matches } from 'class-validator';
import { CurrentUser, Roles, type AuthUser } from '../../common/auth.decorators';
import { imageUpload, publicUrl } from '../../common/uploads';
import { AppConfig } from '../../config/app-config.service';
import { driverIdOf } from '../drivers/drivers.controller';
import { DeliveriesService } from './deliveries.service';

export class DeliveryListQuery {
  @IsOptional() @IsIn(['active', 'completed', 'all']) scope?: 'active' | 'completed' | 'all';
}

export class CompleteDeliveryDto {
  @IsBoolean() customerReceived: boolean;
  @IsBoolean() cashCollected: boolean;
  /** 4-digit code the customer shares at handover (sent by SMS, shown in their app). */
  @IsOptional() @Matches(/^[0-9]{4}$/, { message: 'Enter the 4-digit delivery OTP.' }) otp?: string;
}

/** Driver-only delivery workflow. `:orderId` is the order being delivered. */
@ApiTags('Deliveries')
@ApiBearerAuth()
@Roles('DRIVER')
@Controller('deliveries')
export class DeliveriesController {
  constructor(
    private readonly deliveries: DeliveriesService,
    private readonly config: AppConfig,
  ) {}

  /** Orders assigned to the signed-in driver. */
  @Get()
  async list(@CurrentUser() user: AuthUser, @Query() q: DeliveryListQuery) {
    return { orders: await this.deliveries.list(driverIdOf(user), q.scope ?? 'all') };
  }

  /**
   * Best visiting order for the driver's open deliveries on real roads, with a
   * road-following polyline, per-stop distance/ETA and totals. Declared before
   * `:orderId` so "route" is not parsed as an id.
   */
  @Get('route')
  route(@CurrentUser() user: AuthUser) {
    return this.deliveries.route(driverIdOf(user));
  }

  @Get(':orderId')
  async detail(@CurrentUser() user: AuthUser, @Param('orderId', ParseUUIDPipe) orderId: string) {
    return { order: await this.deliveries.detail(driverIdOf(user), orderId) };
  }

  @Post(':orderId/start')
  @HttpCode(200)
  async start(@CurrentUser() user: AuthUser, @Param('orderId', ParseUUIDPipe) orderId: string) {
    return { order: await this.deliveries.start(user, driverIdOf(user), orderId) };
  }

  /** Upload one proof-of-delivery photo (multipart field `file`, JPG/PNG/WEBP ≤ 5 MB). */
  @Post(':orderId/proof')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  @UseInterceptors(FileInterceptor('file', imageUpload))
  async proof(
    @CurrentUser() user: AuthUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('No file was uploaded.');
    return this.deliveries.addProof(driverIdOf(user), orderId, publicUrl(this.config.get('PUBLIC_BASE_URL'), file.filename));
  }

  /** Marks delivered. Requires both confirmations, at least one proof photo and the customer's delivery OTP. */
  @Post(':orderId/complete')
  @HttpCode(200)
  async complete(
    @CurrentUser() user: AuthUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: CompleteDeliveryDto,
  ) {
    return { order: await this.deliveries.complete(user, driverIdOf(user), orderId, dto) };
  }
}
