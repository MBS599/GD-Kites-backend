import { config } from 'dotenv';
import { resolve } from 'node:path';

// Loaded before the app module: same database and JWT secrets as the running API,
// but no outgoing WhatsApp / push from this script.
config({ path: resolve(__dirname, '..', '.env'), quiet: true });
if (process.env.NODE_ENV === 'production') throw new Error('it-sessions is a test tool; refusing NODE_ENV=production.');
process.env.MESSAGING_PROVIDER = 'log';
process.env.FIREBASE_SERVICE_ACCOUNT = '';
