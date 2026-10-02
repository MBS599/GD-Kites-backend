import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from './env';

/** Typed accessor over validated environment variables. */
@Injectable()
export class AppConfig {
  constructor(private readonly config: ConfigService<Env, true>) {}

  get<K extends keyof Env>(key: K): Env[K] {
    return this.config.get(key, { infer: true });
  }

  get isProduction() {
    return this.get('NODE_ENV') === 'production';
  }

  get hub() {
    return { lat: this.get('HUB_LAT'), lng: this.get('HUB_LNG') };
  }

  get corsOrigins(): true | string[] {
    const v = this.get('CORS_ORIGINS');
    return v === '*' ? true : v.split(',').map((s) => s.trim());
  }
}
