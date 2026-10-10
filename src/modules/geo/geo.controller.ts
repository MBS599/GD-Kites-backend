import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { IsLatitude, IsLongitude, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { GeoService } from './geo.service';

export class ReverseQuery {
  @Type(() => Number) @IsLatitude() lat: number;
  @Type(() => Number) @IsLongitude() lng: number;
}

/** Places session token: a client-made UUID (one per search). */
const SESSION_RE = /^[A-Za-z0-9_-]{8,64}$/;

export class AutocompleteQuery {
  @IsString() @MinLength(2) @MaxLength(120) q: string;
  @Matches(SESSION_RE) session: string;
  @IsOptional() @Type(() => Number) @IsLatitude() lat?: number;
  @IsOptional() @Type(() => Number) @IsLongitude() lng?: number;
}

export class PlaceQuery {
  @IsOptional() @Matches(SESSION_RE) session?: string;
}

@ApiTags('Geo')
@ApiBearerAuth()
@Controller('geo')
export class GeoController {
  constructor(private readonly geo: GeoService) {}

  /** What the address picker can use: Google address search needs the server key. */
  @Get('config')
  config() {
    return { search: this.geo.searchEnabled };
  }

  /** Address for a map point (cached; 503 if the geocoding provider is unavailable). */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('reverse')
  async reverse(@Query() q: ReverseQuery) {
    return { place: await this.geo.reverse(q.lat, q.lng) };
  }

  /**
   * Address search suggestions (Google Places, India). The Google key stays on the server.
   * `enabled: false` when no key is configured: the app then hides the search box.
   */
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Get('autocomplete')
  async autocomplete(@Query() q: AutocompleteQuery) {
    if (!this.geo.searchEnabled) return { enabled: false, suggestions: [] };
    const near = q.lat != null && q.lng != null ? { lat: q.lat, lng: q.lng } : undefined;
    return { enabled: true, suggestions: await this.geo.autocomplete(q.q.trim(), q.session, near) };
  }

  /** Location and address parts of a chosen suggestion. */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('place/:placeId')
  async place(@Param('placeId') placeId: string, @Query() q: PlaceQuery) {
    return { place: await this.geo.details(placeId.slice(0, 300), q.session) };
  }
}
