/**
 * Starts sessions for the seeded accounts used by the Flutter API integration test
 * (the API has no password-less sign-in route) and prints them as JSON:
 *
 *   npm run db:seed
 *   npx ts-node --transpile-only test/it-sessions.ts > it-sessions.json
 *
 * Test tool only: not part of the server build, refuses NODE_ENV=production.
 */
import './it-sessions.env';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/modules/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';

const ACCOUNTS = [
  'mayur.traders@gmail.com',
  'admin@gdkitecenter.in',
  'rahul.patil@gdkitecenter.in',
  'patilkitehouse@gmail.com',
];

async function main() {
  // Providers only, no init(): nothing listens, no background jobs start.
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const prisma = moduleRef.get(PrismaService);
  const auth = moduleRef.get(AuthService);
  try {
    const sessions: Record<string, { accessToken: string; refreshToken: string }> = {};
    for (const email of ACCOUNTS) {
      const user = await prisma.user.findUniqueOrThrow({ where: { email }, include: { driverProfile: true } });
      const { accessToken, refreshToken } = await auth.startSession(user, 'flutter-integration-test');
      sessions[email] = { accessToken, refreshToken };
    }
    process.stdout.write(JSON.stringify(sessions, null, 2) + '\n');
  } finally {
    await prisma.$disconnect();
    await moduleRef.close();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
