import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
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
  (app as NestExpressApplication).useStaticAssets(UPLOAD_DIR, { prefix: '/uploads/', maxAge: '7d' });
  (app as NestExpressApplication).disable('x-powered-by');

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
