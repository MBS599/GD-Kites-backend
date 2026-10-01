import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';

async function main() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  const config = configureApp(app);
  app.enableShutdownHooks();
  const port = config.get('PORT');
  await app.listen(port, '0.0.0.0');
  const log = new Logger('Bootstrap');
  log.log(`GD Kite Center API on http://0.0.0.0:${port}/api/v1 — docs at /api/docs`);
  if (config.devLoginEnabled) log.warn('Dev login is ENABLED (POST /api/v1/auth/dev-login). Never enable in production.');
}

void main();
