import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(__dirname, '..', '.env'), quiet: true });

/** e2e tests always run against a separate database. */
export const TEST_DATABASE_URL = (process.env.DATABASE_URL ?? '').replace(/\/([^/?]+)(\?|$)/, '/gdkite_test$2');
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.NODE_ENV = 'test';
process.env.ALLOW_DEV_LOGIN = 'true';
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test-client.apps.googleusercontent.com';
// Never talk to real gateways from tests, whatever the local .env says.
process.env.MESSAGING_PROVIDER = 'log';
process.env.MESSAGING_ALLOWLIST = ''; // a dev allowlist in .env would skip the test numbers
process.env.FIREBASE_SERVICE_ACCOUNT = '';
process.env.WHATSAPP_APP_SECRET = 'test-app-secret';
process.env.WHATSAPP_VERIFY_TOKEN = 'test-verify-token';
// Online payments are switched on per test (Razorpay itself is faked); these only sign test payloads.
process.env.PAYMENTS_PROVIDER = 'none';
process.env.RAZORPAY_KEY_ID = 'rzp_test_e2e';
process.env.RAZORPAY_KEY_SECRET = 'rzp-test-secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'rzp-webhook-secret';
