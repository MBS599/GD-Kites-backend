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
  log.log(`GD Kite Center API on http://0.0.0.0:${port}/api/v1${config.isProduction ? '' : ' — docs at /api/docs'}`);
}

// whatsapp-web.js drives a browser and can reject a promise nobody awaits (e.g. "Execution context
// was destroyed" when WhatsApp logs the phone out). Node would end the whole API for that; log it
// instead: the WhatsApp session recovers on its own (new QR / reconnect) and orders keep working.
process.on('unhandledRejection', (reason) => {
  new Logger('Process').error(`Unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});

void main();
