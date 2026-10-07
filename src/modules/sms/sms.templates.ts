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
  /** [first name, order, items, total, deliver to] */
  orderPlaced: {
    audience: 'customer',
    text: 'Hi {#var#}, thank you for your order! We have received order #{#var#} for {#var#} (total Rs {#var#}), to be delivered at {#var#}. We will confirm it shortly.',
    long: [2, 4],
  },
  /** [first name, order, items, total] */
  orderConfirmed: {
    audience: 'customer',
    text: 'Hi {#var#}, your order #{#var#} for {#var#} (Rs {#var#}) is confirmed and is being packed. It will reach you within 3-4 working days.',
    long: [2],
  },
  /** [first name, order, items, driver, driver phone] */
  driverAssigned: {
    audience: 'customer',
    text: 'Hi {#var#}, your order #{#var#} for {#var#} will be delivered by {#var#} ({#var#}).',
    long: [2],
  },
  /** [first name, order, items, driver, driver phone, delivery code] */
  outForDelivery: {
    audience: 'customer',
    text: 'Hi {#var#}, your order #{#var#} for {#var#} is out for delivery with {#var#} ({#var#}). Delivery code {#var#}: share it only after you receive your order.',
    secretVar: 5,
    long: [2],
  },
  /** [delivery code, order] */
  deliveryOtp: {
    audience: 'customer',
    text: '{#var#} is the delivery code for your order #{#var#}. Share it with the driver only after you receive your order.',
    secretVar: 0,
  },
  loginOtp: {
    audience: 'customer',
    text: '{#var#} is your GD Kite Center login OTP. It is valid for 5 minutes. Do not share it with anyone.',
    secretVar: 0,
  },
  /** [first name, order, items, total] */
  orderDelivered: {
    audience: 'customer',
    text: 'Hi {#var#}, your order #{#var#} for {#var#} has been delivered (Rs {#var#}). Thank you for shopping with GD Kite Center!',
    long: [2],
  },
  /** [first name, order, items, reason] */
  orderCancelled: {
    audience: 'customer',
    text: 'Hi {#var#}, we are sorry: your order #{#var#} for {#var#} has been cancelled. Reason: {#var#}.',
    long: [2, 3],
  },

  // ---- Driver ----
  /** [first name, how to sign in] */
  driverWelcome: {
    audience: 'driver',
    text: 'Hi {#var#}, welcome to the GD Kite Center delivery team. Install the GD Kites app and sign in with {#var#} to see your deliveries.',
  },
  /** [driver first name, order, customer, area, items] */
  deliveryAssigned: {
    audience: 'driver',
    text: 'Hi {#var#}, you have a new delivery: order #{#var#} for {#var#} in {#var#}, with {#var#}. Open the GD Kites app to start.',
    long: [4],
  },
  /** [order] */
  deliveryRemoved: {
    audience: 'driver',
    text: 'Order #{#var#} is no longer assigned to you. No action is needed.',
  },

  // ---- Admin ----
  /** [order, customer, items, total, area] */
  adminNewOrder: {
    audience: 'admin',
    text: 'New order #{#var#} from {#var#} for {#var#} (total Rs {#var#}), delivering to {#var#}. Please confirm it in the GD Kites app.',
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
