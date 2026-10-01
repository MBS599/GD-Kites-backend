import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser, Roles, type AuthUser } from '../../common/auth.decorators';
import { pageArgs, PageQuery, toPage } from '../../common/paging';
import { PrismaService } from '../../prisma/prisma.service';
import { SmsService } from './sms.service';
import { SMS_TEMPLATES } from './sms.templates';
import { renderWhatsApp, WA_TEMPLATES } from './whatsapp.templates';

export class SmsTestDto {
  /** Defaults to the admin's own phone. */
  @IsOptional() @IsString() @MaxLength(20) phone?: string;
}

@ApiTags('SMS')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('sms')
export class SmsController {
  constructor(
    private readonly sms: SmsService,
    private readonly prisma: PrismaService,
  ) {}

  /** Channel in use (WhatsApp or development log), push status and every message the app sends. */
  @Get('status')
  status() {
    const s = this.sms.status();
    return {
      ...s,
      channel: 'whatsapp',
      // What each WhatsApp message looks like (with example values).
      events: s.events.map((e) => ({
        ...e,
        audience: SMS_TEMPLATES[e.event].audience,
        text: renderWhatsApp(e.event, WA_TEMPLATES[e.event].examples),
        whatsappTemplate: WA_TEMPLATES[e.event].name,
      })),
    };
  }

  /** Delivery log, newest first. */
  @Get('messages')
  async messages(@Query() q: PageQuery) {
    const { limit, args } = pageArgs(q, 20);
    const rows = await this.prisma.smsMessage.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], ...args });
    const page = toPage(rows, limit);
    return {
      messages: page.items.map((m) => ({
        id: m.id,
        event: m.event,
        to: m.to,
        body: m.body,
        status: m.status.toLowerCase(),
        provider: m.provider,
        error: m.error,
        deliveryStatus: m.deliveryStatus,
        createdAt: m.createdAt,
      })),
      nextCursor: page.nextCursor,
    };
  }

  @Post('test')
  @HttpCode(200)
  async test(@CurrentUser() user: AuthUser, @Body() dto: SmsTestDto) {
    const m = await this.sms.sendTest(dto.phone ?? user.phone ?? '', user.id);
    return { status: m.status.toLowerCase(), error: m.error, body: m.body, to: m.to };
  }
}
