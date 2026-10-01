import { z } from 'zod';

const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.string().min(1),
    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
    JWT_ACCESS_TTL: z.string().default('15m'),
    JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),
    GOOGLE_CLIENT_ID: csv,
    ALLOW_DEV_LOGIN: z
      .string()
      .default('false')
      .transform((v) => v === 'true'),
    BOOTSTRAP_ADMIN_EMAILS: csv.transform((l) => l.map((e) => e.toLowerCase())),
    PUBLIC_BASE_URL: z.string().default('http://localhost:3000'),
    CORS_ORIGINS: z.string().default('*'),
    /** Reverse geocoding: Google is used when a key is set, otherwise OpenStreetMap Nominatim. */
    GOOGLE_MAPS_API_KEY: z.string().default(''),
    NOMINATIM_URL: z.string().default('https://nominatim.openstreetmap.org'),
    /** Nominatim policy requires an identifying User-Agent with contact info. */
    GEOCODER_USER_AGENT: z.string().default('GDKiteCenter/1.0 (support@gdkitecenter.in)'),
    /** Road routing / trip optimisation. `osrm` now; `google` reserved for the Routes API later. */
    ROUTING_PROVIDER: z.enum(['osrm']).default('osrm'),
    OSRM_URL: z.string().default('https://router.project-osrm.org'),
    /**
     * Message channel. `wwebjs` sends WhatsApp from a linked phone
     * (whatsapp-web.js, unofficial, free); `whatsapp` sends Meta-approved
     * templates (official WhatsApp Cloud API); `log` (default, development)
     * only writes them to the server log. Push notifications are separate (FIREBASE_SERVICE_ACCOUNT).
     */
    MESSAGING_PROVIDER: z.enum(['log', 'whatsapp', 'wwebjs']).default('log'),
    /**
     * Testing safety net: when set (comma-separated mobiles), WhatsApp only goes
     * to these numbers; everyone else is logged as skipped. Leave empty in production.
     */
    MESSAGING_ALLOWLIST: csv,
    /** wwebjs (linked phone, unofficial): where the WhatsApp Web login is kept, and the minimum gap between sends. */
    WWEBJS_SESSION_DIR: z.string().default('.wwebjs_auth'),
    WWEBJS_MIN_GAP_MS: z.coerce.number().int().min(0).default(3000),
    /** WhatsApp Cloud API (Meta developer dashboard → WhatsApp → API setup). */
    WHATSAPP_TOKEN: z.string().default(''),
    WHATSAPP_PHONE_NUMBER_ID: z.string().default(''),
    WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().default(''),
    WHATSAPP_LANG: z.string().default('en'),
    WHATSAPP_API_VERSION: z.string().default('v22.0'),
    /** Webhook (delivery / read receipts): app secret signs the callbacks; verify token is your own random string. */
    WHATSAPP_APP_SECRET: z.string().default(''),
    WHATSAPP_VERIFY_TOKEN: z.string().default(''),
    /**
     * Push notifications (Firebase Cloud Messaging). Path to the Firebase
     * service-account JSON, or the JSON itself. Empty = push off.
     */
    FIREBASE_SERVICE_ACCOUNT: z.string().default(''),
    /**
     * Online payments. `razorpay`: the customer pays the delivery charge online at
     * checkout and the rest in cash on delivery. `none` (default): everything is
     * cash on delivery.
     */
    PAYMENTS_PROVIDER: z.enum(['none', 'razorpay']).default('none'),
    /** Razorpay dashboard → Account & Settings → API keys (test keys start with rzp_test_). */
    RAZORPAY_KEY_ID: z.string().default(''),
    RAZORPAY_KEY_SECRET: z.string().default(''),
    /** Razorpay dashboard → Webhooks: the secret you set for POST /api/v1/webhooks/razorpay. */
    RAZORPAY_WEBHOOK_SECRET: z.string().default(''),
    /** Unpaid orders are cancelled (stock released) after this many minutes. */
    PAYMENT_TIMEOUT_MIN: z.coerce.number().int().min(5).max(1440).default(15),
    HUB_LAT: z.coerce.number().default(18.4866),
    HUB_LNG: z.coerce.number().default(73.8656),
  })
  .refine((e) => e.JWT_ACCESS_SECRET !== e.JWT_REFRESH_SECRET, {
    message: 'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ',
  })
  .refine((e) => !(e.NODE_ENV === 'production' && e.ALLOW_DEV_LOGIN), {
    message: 'ALLOW_DEV_LOGIN must be false in production',
  })
  .refine((e) => e.PAYMENTS_PROVIDER !== 'razorpay' || (!!e.RAZORPAY_KEY_ID && !!e.RAZORPAY_KEY_SECRET), {
    message: 'RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required when PAYMENTS_PROVIDER is razorpay',
  })
  .refine(
    (e) => e.MESSAGING_PROVIDER !== 'whatsapp' || (!!e.WHATSAPP_TOKEN && !!e.WHATSAPP_PHONE_NUMBER_ID),
    { message: 'WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID are required when MESSAGING_PROVIDER is whatsapp' },
  );

export type Env = z.infer<typeof schema>;

/** Used by ConfigModule.validate — fails fast on bad configuration. */
export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
