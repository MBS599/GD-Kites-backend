import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsNumber, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { CurrentUser, Roles, type AuthUser } from '../../common/auth.decorators';
import { DispatchService } from './dispatch.service';

export class DispatchQuery {
  @IsOptional() @IsUUID() serviceAreaId?: string;
  /** Most orders suggested for one driver (default 8). */
  @IsOptional() @Type(() => Number) @IsNumber() @Min(1) @Max(30) maxPerDriver?: number;
  /** Orders join a group only within this many km of its first order (default 4). */
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0.5) @Max(50) radiusKm?: number;
}

export class AssignGroupDto {
  @IsUUID() driverId: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @IsUUID('all', { each: true }) orderIds: string[];
}

@ApiTags('Dispatch')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller()
export class DispatchController {
  constructor(private readonly dispatch: DispatchService) {}

  /** Confirmed orders grouped around the oldest order, with a suggested driver and route per group. */
  @Get('dispatch/plan')
  plan(@Query() q: DispatchQuery) {
    return this.dispatch.plan({ serviceAreaId: q.serviceAreaId, maxPerDriver: q.maxPerDriver ?? 8, radiusKm: q.radiusKm ?? 4 });
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
