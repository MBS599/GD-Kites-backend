import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { TEST_DATABASE_URL } from './env';

/** Migrates and seeds the isolated test database once per run. */
export default async function globalSetup() {
  const cwd = resolve(__dirname, '..');
  const env = { ...process.env, DATABASE_URL: TEST_DATABASE_URL, NODE_ENV: 'test' };
  execSync('npx prisma migrate deploy', { cwd, env, stdio: 'ignore' });
  execSync('npx ts-node --transpile-only prisma/seed.ts', { cwd, env, stdio: 'ignore' });
}
