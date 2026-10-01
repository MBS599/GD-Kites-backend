import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AccessTokenVerifier, JwtAuthGuard, RolesGuard } from './common/auth.guards';
import { ApiExceptionFilter } from './common/http-exception.filter';
import { AppConfig } from './config/app-config.service';
import { validateEnv } from './config/env';
import { HealthController } from './health.controller';
import { PrismaModule } from './prisma/prisma.service';
import {
  AddressesModule,
  AdminModule,
  AuthModule,
  CartModule,
  CatalogModule,
  DeliveriesModule,
  DriversModule,
  GeoModule,
  OrdersModule,
  RealtimeModule,
  ServiceAreasModule,
  SmsModule,
  UsersModule,
} from './modules/feature.modules';

@Global()
@Module({
  imports: [JwtModule.register({})],
  providers: [AppConfig, AccessTokenVerifier],
  exports: [AppConfig, AccessTokenVerifier, JwtModule],
})
class CoreModule {}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv, cache: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
    PrismaModule,
    CoreModule,
    RealtimeModule,
    SmsModule,
    ServiceAreasModule,
    AuthModule,
    UsersModule,
    GeoModule,
    AddressesModule,
    CatalogModule,
    CartModule,
    OrdersModule,
    DriversModule,
    DeliveriesModule,
    AdminModule,
  ],
  controllers: [HealthController],
  providers: [
    // Order matters: rate limit → authenticate → authorize by role.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule {}
