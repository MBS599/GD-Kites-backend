import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsNumber, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { CurrentUser, Roles, type AuthUser } from '../../common/auth.decorators';
import { SettingsService } from '../settings/settings.controller';
import { DispatchService } from './dispatch.service';

export class DispatchQuery {
  @IsOptional() @IsUUID() serviceAreaId?: string;
  /** Most orders suggested for one driver (default: admin setting). */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) maxPerDriver?: number;
  /** Orders join a group only within this many km of its first order (default: admin setting). */
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0.5) @Max(1000) radiusKm?: number;
}

export class AssignGroupDto {
  @IsUUID() driverId: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsUUID('all', { each: true }) orderIds: string[];
}

@ApiTags('Dispatch')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller()
export class DispatchController {
  constructor(
    private readonly dispatch: DispatchService,
    private readonly settings: SettingsService,
  ) {}

  /** Confirmed orders grouped around the oldest order, with a suggested driver and route per group. */
  @Get('dispatch/plan')
  async plan(@Query() q: DispatchQuery) {
    const s = await this.settings.get();
    const maxPerDriver = q.maxPerDriver ?? s.dispatchMaxOrders;
    const radiusKm = q.radiusKm ?? s.dispatchRadiusKm;
    return { ...(await this.dispatch.plan({ serviceAreaId: q.serviceAreaId, maxPerDriver, radiusKm })), maxPerDriver, radiusKm };
  }

  /** Assign a whole group to one driver. Each order follows the normal assignment rules. */
  @Post('dispatch/assign')
  @HttpCode(200)
  assign(@CurrentUser() user: AuthUser, @Body() dto: AssignGroupDto) {
    return this.dispatch.assignGroup(user, dto.driverId, dto.orderIds);
  }

  /** Drivers ranked for one order: those already delivering nearby first. */
  @Get('orders/:id/driver-suggestions')
  async suggestions(@Param('id', ParseUUIDPipe) id: string) {
    return { drivers: await this.dispatch.suggestForOrder(id) };
  }
}
