/**
 * Every message the app sends, as plain text with {#var#} placeholders. This
 * list defines the events and their variables; the WhatsApp template for each
 * event is in whatsapp.templates.ts. The plain text is what the development
 * log shows (MESSAGING_PROVIDER=log).
 *
 * Variables are clipped to 30 characters.
 */
export const SMS_TEMPLATES = {
  // ---- Customer ----
  /** [customer name, order, items, total, deliver to] */
  orderPlaced: {
    audience: 'customer',
    text: 'Hello {#var#}, thank you for your GD Kite Center order {#var#}: {#var#}. Total Rs {#var#}, delivering to {#var#}. We will confirm it shortly.',
    long: [2, 4],
  },
  /** [customer name, order, items, total] */
  orderConfirmed: {
    audience: 'customer',
    text: 'Hello {#var#}, your GD Kite Center order {#var#} ({#var#}, Rs {#var#}) is confirmed and being packed. It will reach you within 3-4 working days.',
    long: [2],
  },
  /** [customer name, order, driver, driver phone] */
  driverAssigned: {
    audience: 'customer',
    text: 'Hello {#var#}, {#var#} ({#var#}) will deliver your GD Kite Center order {#var#}.',
    order: [0, 2, 3, 1],
  },
  /** [customer name, order, driver, driver phone, delivery code] */
  outForDelivery: {
    audience: 'customer',
    text: 'Hello {#var#}, your GD Kite Center order {#var#} is out for delivery with {#var#} ({#var#}). Delivery code {#var#}: share it only after you receive your order.',
    secretVar: 4,
  },
  /** [delivery code, order] */
  deliveryOtp: {
    audience: 'customer',
    text: '{#var#} is the delivery code for your GD Kite Center order {#var#}. Share it with the driver only after you receive your order.',
    secretVar: 0,
  },
  loginOtp: {
    audience: 'customer',
    text: '{#var#} is your GD Kite Center login OTP. It is valid for 5 minutes. Do not share it with anyone.',
    secretVar: 0,
  },
  /** [customer name, order, items, total] */
  orderDelivered: {
    audience: 'customer',
    text: 'Hello {#var#}, your GD Kite Center order {#var#} ({#var#}, Rs {#var#}) is delivered. Thank you for shopping with us!',
    long: [2],
  },
  /** [customer name, order, items, reason] */
  orderCancelled: {
    audience: 'customer',
    text: 'Hello {#var#}, your GD Kite Center order {#var#} ({#var#}) was cancelled. Reason: {#var#}.',
    long: [2, 3],
  },

  // ---- Driver ----
  /** [first name, how to sign in] */
  driverWelcome: {
    audience: 'driver',
    text: 'Hello {#var#}, welcome to GD Kite Center deliveries. Install the GD Kites app and sign in with {#var#} to see your deliveries.',
  },
  /** [driver first name, order, customer, area, items] */
  deliveryAssigned: {
    audience: 'driver',
    text: 'Hello {#var#}, new delivery {#var#} for {#var#}, {#var#}: {#var#}. Open the GD Kites app to start.',
    long: [4],
  },
  /** [order] */
  deliveryRemoved: {
    audience: 'driver',
    text: 'Delivery {#var#} is no longer assigned to you. No action is needed.',
  },

  // ---- Admin ----
  /** [order, customer, items, total, area] */
  adminNewOrder: {
    audience: 'admin',
    text: 'New order {#var#} from {#var#}: {#var#}. Total Rs {#var#}, {#var#}. Please confirm it in the GD Kites app.',
    long: [2],
  },

  /** Admin "send test message" from Settings. */
  test: {
    audience: 'admin',
    text: 'Test message from GD Kite Center. WhatsApp notifications are working.',
  },
} as const satisfies Record<
  string,
  {
    audience: 'customer' | 'driver' | 'admin';
    text: string;
    /** Index of a one-time code (never stored in the log). */
    secretVar?: number;
    /** Variables that may be long (item lists, addresses, reasons): clipped at 300 characters, not 40. */
    long?: readonly number[];
    /** Order of the variables in [text], when it differs from the event's variable order. */
    order?: readonly number[];
  }
>;

export type SmsEvent = keyof typeof SMS_TEMPLATES;
export const SMS_EVENTS = Object.keys(SMS_TEMPLATES) as SmsEvent[];

/** One line, capped: 40 characters, or 300 for the template's [long] variables (item lists, addresses). */
export const clipVar = (v: string | number, max = 40) => {
  const t = String(v).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

/** [vars] clipped for [event]: long variables keep up to 300 characters. */
export function clipVars(event: SmsEvent, vars: (string | number)[]) {
  const long = (SMS_TEMPLATES[event] as { long?: readonly number[] }).long ?? [];
  return vars.map((v, i) => clipVar(v, long.includes(i) ? 300 : 40));
}

export function renderSms(event: SmsEvent, vars: (string | number)[]) {
  const clipped = clipVars(event, vars);
  const order = (SMS_TEMPLATES[event] as { order?: readonly number[] }).order;
  let i = 0;
  return SMS_TEMPLATES[event].text.replace(/\{#var#\}/g, () => clipped[order ? order[i++] : i++] ?? '');
}

/** Index of a one-time code in this template's variables (never stored in the SMS log). */
export const secretVarOf = (event: SmsEvent): number | undefined =>
  (SMS_TEMPLATES[event] as { secretVar?: number }).secretVar;

/** Variables with the one-time code (if any) replaced by dots — for the audit log. */
export function maskSecret(event: SmsEvent, vars: string[]) {
  const secret = secretVarOf(event);
  return secret === undefined ? vars : vars.map((v, i) => (i === secret ? '••••' : v));
}

/** Text for the audit log: one-time codes replaced by dots. */
export function renderForLog(event: SmsEvent, vars: (string | number)[]) {
  return renderSms(event, maskSecret(event, vars.map(String)));
}

export const varCount =(event: SmsEvent) => SMS_TEMPLATES[event].text.split('{#var#}').length - 1;
