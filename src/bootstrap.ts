import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { resizedUploads } from './common/resized-uploads';
import { UPLOAD_DIR } from './common/uploads';
import { AppConfig } from './config/app-config.service';

export const API_PREFIX = 'api/v1';

/** Shared by main.ts and e2e tests so tests exercise the real configuration. */
export function configureApp(app: NestExpressApplication | INestApplication) {
  const config = app.get(AppConfig);
  app.setGlobalPrefix(API_PREFIX);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.enableCors({ origin: config.corsOrigins });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  // ?w=200|400|800|1200 serves a resized WebP (made once, cached); otherwise the original file.
  app.use('/uploads', resizedUploads(UPLOAD_DIR));
  (app as NestExpressApplication).useStaticAssets(UPLOAD_DIR, { prefix: '/uploads/', maxAge: '7d' });
  (app as NestExpressApplication).disable('x-powered-by');
  // Behind nginx on the same host: take the client IP from X-Forwarded-For (rate limits are per IP).
  (app as NestExpressApplication).set('trust proxy', 'loopback');

  // API docs are for development; production doesn't publish the endpoint list.
  if (config.isProduction) return config;

  const doc = new DocumentBuilder()
    .setTitle('GD Kite Center API')
    .setDescription(
      'Wholesale kite ordering & delivery. Roles: customer, driver, admin. ' +
        'Errors: `{ error: { code, message, details? } }`. Realtime: Socket.IO at the server root with `auth: { token }`.',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, doc));
  return config;
}
