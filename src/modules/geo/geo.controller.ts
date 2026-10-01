import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { IsLatitude, IsLongitude } from 'class-validator';
import { GeoService } from './geo.service';

export class ReverseQuery {
  @Type(() => Number) @IsLatitude() lat: number;
  @Type(() => Number) @IsLongitude() lng: number;
}

@ApiTags('Geo')
@ApiBearerAuth()
@Controller('geo')
export class GeoController {
  constructor(private readonly geo: GeoService) {}

  /** Address for a map point (cached; 503 if the geocoding provider is unavailable). */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('reverse')
  async reverse(@Query() q: ReverseQuery) {
    return { place: await this.geo.reverse(q.lat, q.lng) };
  }
}
