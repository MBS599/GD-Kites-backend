import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Post,
  Query,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import { CurrentUser, Public, Roles, type AuthUser } from '../../common/auth.decorators';
import { PushService } from './push.service';
import { WhatsAppAdminService } from './whatsapp-admin.service';
import { WhatsAppWebSession } from './whatsapp-web.session';

export class DeviceDto {
  /** Firebase Cloud Messaging registration token of this app install. */
  @IsString() @MinLength(20) @MaxLength(4096) token: string;
  @IsIn(['android', 'ios', 'web']) platform: 'android' | 'ios' | 'web';
}

export class DeviceRemoveDto {
  @IsString() @MinLength(20) @MaxLength(4096) token: string;
}

/** Push notification devices (any signed-in user). */
@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly push: PushService) {}

  @Post('devices')
  @HttpCode(204)
  async register(@CurrentUser() user: AuthUser, @Body() dto: DeviceDto) {
    await this.push.register(user.id, dto.token, dto.platform);
  }

  /** Called on sign-out so a shared phone stops getting this user's alerts. */
  @Delete('devices')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Body() dto: DeviceRemoveDto) {
    await this.push.unregister(user.id, dto.token);
  }
}

/** Admin: WhatsApp template setup. */
@ApiTags('SMS')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('sms/whatsapp')
export class WhatsAppSetupController {
  constructor(private readonly wa: WhatsAppAdminService) {}

  @Get('templates')
  async templates() {
    return { templates: await this.wa.templates() };
  }

  /** Submits the app's message templates that don't exist yet for Meta approval. */
  @Post('templates')
  @HttpCode(200)
  async create() {
    return { results: await this.wa.createMissing() };
  }
}

/** Meta calls this with delivery / read receipts. Public, but signature-checked. */
@Controller('webhooks/whatsapp')
@SkipThrottle()
export class WhatsAppWebhookController {
  constructor(private readonly wa: WhatsAppAdminService) {}

  @Public()
  @Get()
  @ApiExcludeEndpoint()
  verify(
    @Query('hub.mode') mode?: string,
    @Query('hub.verify_token') token?: string,
    @Query('hub.challenge') challenge?: string,
  ) {
    return this.wa.verifySubscription(mode, token, challenge);
  }

  @Public()
  @Post()
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async receive(@Req() req: RawBodyRequest<Request>, @Headers('x-hub-signature-256') signature?: string) {
    this.wa.checkSignature(req.rawBody, signature);
    await this.wa.applyStatuses(req.body);
    return { ok: true };
  }
}

/** Admin: link / unlink the WhatsApp phone (MESSAGING_PROVIDER=wwebjs). */
@ApiTags('SMS')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('sms/whatsapp-web')
export class WhatsAppWebController {
  constructor(private readonly web: WhatsAppWebSession) {}

  /** Connection state and, while waiting to be linked, the QR code to scan (PNG data URL). */
  @Get()
  status() {
    return {
      enabled: this.web.enabled,
      state: this.web.enabled ? this.web.state : 'off',
      qr: this.web.currentQr(),
      number: this.web.state === 'ready' ? this.web.number : null,
      error: this.web.lastError,
    };
  }

  /** Unlink the current phone; a new QR code appears. */
  @Post('logout')
  @HttpCode(204)
  async logout() {
    if (this.web.enabled) await this.web.logout();
  }

  /** Reconnect after a failure. */
  @Post('restart')
  @HttpCode(204)
  async restart() {
    if (this.web.enabled) void this.web.restart();
  }
}
