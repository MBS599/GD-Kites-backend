import { Body, Controller, Delete, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Prisma, ProblemReportStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import { AccessTokenVerifier } from '../../common/auth.guards';
import { Public, Roles } from '../../common/auth.decorators';
import { PageQuery, pageArgs, toPage } from '../../common/paging';
import { PrismaService } from '../../prisma/prisma.service';

const KINDS = ['bug', 'payment', 'delivery', 'order', 'suggestion', 'other'] as const;
const SOURCES = ['app', 'web', 'website', 'shop'] as const;
const ERROR_SOURCES = ['app', 'web', 'website', 'server'] as const;

/** Where the report or error came from (all optional; the client fills what it knows). */
class ClientInfoDto {
  @IsOptional() @IsString() @MaxLength(200) screen?: string;
  @IsOptional() @IsString() @MaxLength(40) platform?: string;
  @IsOptional() @IsString() @MaxLength(40) appVersion?: string;
  @IsOptional() @IsString() @MaxLength(300) device?: string;
}

export class ProblemReportDto extends ClientInfoDto {
  @IsIn(KINDS) kind: (typeof KINDS)[number];
  @IsString() @MinLength(5, { message: 'Please describe the problem in a few words.' }) @MaxLength(4000) message: string;
  @IsIn(SOURCES) source: (typeof SOURCES)[number];
  @IsOptional() @IsString() @MaxLength(100) name?: string;
  @IsOptional() @IsString() @MaxLength(20) phone?: string;
}

class ErrorEntryDto {
  @IsString() @MinLength(1) @MaxLength(2000) message: string;
  @IsOptional() @IsString() @MaxLength(8000) stack?: string;
  @IsOptional() @IsString() @MaxLength(200) screen?: string;
}

export class ErrorBatchDto extends ClientInfoDto {
  @IsIn(['app', 'web', 'website']) source: 'app' | 'web' | 'website';
  @ValidateNested({ each: true }) @Type(() => ErrorEntryDto) @ArrayMinSize(1) @ArrayMaxSize(20) errors: ErrorEntryDto[];
}

class ReportsQuery extends PageQuery {
  @IsOptional() @IsIn(['open', 'resolved']) status?: 'open' | 'resolved';
  @IsOptional() @IsUUID() userId?: string;
}

class UpdateReportDto {
  @IsOptional() @IsIn(['open', 'resolved']) status?: 'open' | 'resolved';
  @IsOptional() @IsString() @MaxLength(2000) adminNote?: string;
}

class ErrorsQuery extends PageQuery {
  @IsOptional() @IsUUID() userId?: string;
  /** "guest": errors from signed-out users. */
  @IsOptional() @IsIn(['guest']) who?: 'guest';
  @IsOptional() @IsIn(ERROR_SOURCES) source?: (typeof ERROR_SOURCES)[number];
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}

type UserBrief = { id: string; name: string; phone: string | null; role: string };

@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly verifier: AccessTokenVerifier,
  ) {}

  /** Signed-in user on a public route (reports and errors also come from signed-out visitors). */
  async userIdOf(req: Request) {
    const header = req.headers.authorization;
    const user = await this.verifier.verify(header?.startsWith('Bearer ') ? header.slice(7) : undefined);
    return user?.id ?? null;
  }

  private async users(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((i): i is string => !!i))];
    if (!unique.length) return new Map<string, UserBrief>();
    const rows = await this.prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true, phone: true, role: true } });
    return new Map(rows.map((u) => [u.id, u]));
  }

  async report(dto: ProblemReportDto, userId: string | null) {
    const r = await this.prisma.problemReport.create({
      data: {
        userId,
        kind: dto.kind,
        message: dto.message.trim(),
        source: dto.source,
        name: dto.name?.trim() || null,
        phone: dto.phone?.trim() || null,
        screen: dto.screen ?? null,
        platform: dto.platform ?? null,
        appVersion: dto.appVersion ?? null,
        device: dto.device ?? null,
      },
    });
    return { id: r.id, ref: r.id.slice(0, 8).toUpperCase() };
  }

  async reports(q: ReportsQuery) {
    const { limit, args } = pageArgs(q, 30);
    const rows = await this.prisma.problemReport.findMany({
      where: {
        ...(q.status ? { status: q.status === 'open' ? ProblemReportStatus.OPEN : ProblemReportStatus.RESOLVED } : {}),
        ...(q.userId ? { userId: q.userId } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...args,
    });
    const page = toPage(rows, limit);
    const users = await this.users(page.items.map((r) => r.userId));
    const open = await this.prisma.problemReport.count({ where: { status: ProblemReportStatus.OPEN } });
    return {
      reports: page.items.map((r) => ({
        id: r.id,
        ref: r.id.slice(0, 8).toUpperCase(),
        kind: r.kind,
        message: r.message,
        source: r.source,
        screen: r.screen,
        platform: r.platform,
        appVersion: r.appVersion,
        device: r.device,
        status: r.status === ProblemReportStatus.OPEN ? 'open' : 'resolved',
        adminNote: r.adminNote,
        createdAt: r.createdAt,
        resolvedAt: r.resolvedAt,
        name: r.name ?? (r.userId ? users.get(r.userId)?.name : null) ?? null,
        phone: r.phone ?? (r.userId ? users.get(r.userId)?.phone : null) ?? null,
        user: r.userId ? (users.get(r.userId) ?? null) : null,
      })),
      nextCursor: page.nextCursor,
      open,
    };
  }

  async updateReport(id: string, dto: UpdateReportDto) {
    const r = await this.prisma.problemReport.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Report not found.');
    const resolved = dto.status === undefined ? undefined : dto.status === 'resolved';
    await this.prisma.problemReport.update({
      where: { id },
      data: {
        ...(resolved === undefined
          ? {}
          : { status: resolved ? ProblemReportStatus.RESOLVED : ProblemReportStatus.OPEN, resolvedAt: resolved ? new Date() : null }),
        ...(dto.adminNote !== undefined ? { adminNote: dto.adminNote.trim() || null } : {}),
      },
    });
    return { ok: true };
  }

  async logErrors(dto: ErrorBatchDto, userId: string | null) {
    await this.prisma.errorLog.createMany({
      data: dto.errors.map((e) => ({
        userId,
        source: dto.source,
        message: e.message,
        stack: e.stack ?? null,
        screen: e.screen ?? dto.screen ?? null,
        platform: dto.platform ?? null,
        appVersion: dto.appVersion ?? null,
        device: dto.device ?? null,
      })),
    });
    return { ok: true };
  }

  async errors(q: ErrorsQuery) {
    const { limit, args } = pageArgs(q, 50);
    const where: Prisma.ErrorLogWhereInput = {
      ...(q.userId ? { userId: q.userId } : q.who === 'guest' ? { userId: null } : {}),
      ...(q.source ? { source: q.source } : {}),
      ...(q.q ? { OR: [{ message: { contains: q.q, mode: 'insensitive' } }, { screen: { contains: q.q, mode: 'insensitive' } }] } : {}),
    };
    const rows = await this.prisma.errorLog.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], ...args });
    const page = toPage(rows, limit);
    const users = await this.users(page.items.map((r) => r.userId));
    return {
      errors: page.items.map((e) => ({ ...e, user: e.userId ? (users.get(e.userId) ?? null) : null })),
      nextCursor: page.nextCursor,
    };
  }

  /** People with errors in the log (for the filter), most errors first. */
  async errorUsers() {
    const groups = await this.prisma.errorLog.groupBy({ by: ['userId'], _count: { _all: true }, _max: { createdAt: true } });
    const users = await this.users(groups.map((g) => g.userId));
    return {
      users: groups
        .map((g) => ({
          id: g.userId,
          name: g.userId ? (users.get(g.userId)?.name ?? 'Unknown user') : 'Signed-out visitors',
          phone: g.userId ? (users.get(g.userId)?.phone ?? null) : null,
          role: g.userId ? (users.get(g.userId)?.role ?? null) : null,
          count: g._count._all,
          lastAt: g._max.createdAt,
        }))
        .sort((a, b) => b.count - a.count),
    };
  }

  async clearErrors() {
    const { count } = await this.prisma.errorLog.deleteMany({});
    return { deleted: count };
  }
}

@ApiTags('support')
@ApiBearerAuth()
@Controller('support')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  /** "Report a problem": from the app, web app, website or shop page; signed in or not. */
  @Public()
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @Post('reports')
  async report(@Body() dto: ProblemReportDto, @Req() req: Request) {
    return this.support.report(dto, await this.support.userIdOf(req));
  }

  @Roles('ADMIN')
  @Get('reports')
  reports(@Query() q: ReportsQuery) {
    return this.support.reports(q);
  }

  @Roles('ADMIN')
  @Patch('reports/:id')
  updateReport(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateReportDto) {
    return this.support.updateReport(id, dto);
  }

  /** Errors the app and website catch, sent in small batches. */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('errors')
  @HttpCode(200)
  async logErrors(@Body() dto: ErrorBatchDto, @Req() req: Request) {
    return this.support.logErrors(dto, await this.support.userIdOf(req));
  }

  @Roles('ADMIN')
  @Get('errors')
  errors(@Query() q: ErrorsQuery) {
    return this.support.errors(q);
  }

  @Roles('ADMIN')
  @Get('errors/users')
  errorUsers() {
    return this.support.errorUsers();
  }

  @Roles('ADMIN')
  @Delete('errors')
  clearErrors() {
    return this.support.clearErrors();
  }
}

@Module({ controllers: [SupportController], providers: [SupportService] })
export class SupportModule {}
