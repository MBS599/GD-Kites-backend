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
  orderPlaced: {
    audience: 'customer',
    text: 'Dear {#var#}, your GD Kite Center order {#var#} of Rs {#var#} is placed. We will confirm it shortly. - GD Kite Center',
  },
  orderConfirmed: {
    audience: 'customer',
    text: 'Your GD Kite Center order {#var#} is confirmed and is being packed. - GD Kite Center',
  },
  driverAssigned: {
    audience: 'customer',
    text: 'Order {#var#}: {#var#} ({#var#}) will deliver your GD Kite Center order. - GD Kite Center',
  },
  outForDelivery: {
    audience: 'customer',
    text: 'Order {#var#} is out for delivery with {#var#} ({#var#}). Share OTP {#var#} with the driver only when you receive it. - GD Kite Center',
    secretVar: 3,
  },
  deliveryOtp: {
    audience: 'customer',
    text: '{#var#} is the delivery OTP for your GD Kite Center order {#var#}. Share it with the driver only when you receive your order.',
    secretVar: 0,
  },
  loginOtp: {
    audience: 'customer',
    text: '{#var#} is your GD Kite Center login OTP. It is valid for 5 minutes. Do not share it with anyone.',
    secretVar: 0,
  },
  orderDelivered: {
    audience: 'customer',
    text: 'Order {#var#} delivered. Amount Rs {#var#}. Thank you for ordering from GD Kite Center.',
  },
  orderCancelled: {
    audience: 'customer',
    text: 'Your GD Kite Center order {#var#} was cancelled. Reason: {#var#}. - GD Kite Center',
  },

  // ---- Driver ----
  driverWelcome: {
    audience: 'driver',
    text: 'Hi {#var#}, you are added as a GD Kite Center driver. Install the app and sign in with {#var#}. - GD Kite Center',
  },
  deliveryAssigned: {
    audience: 'driver',
    text: 'New delivery {#var#} for {#var#}, {#var#}. Open the GD Kite Center app to start. - GD Kite Center',
  },
  deliveryRemoved: {
    audience: 'driver',
    text: 'Delivery {#var#} is no longer assigned to you. - GD Kite Center',
  },

  // ---- Admin ----
  adminNewOrder: {
    audience: 'admin',
    text: 'New order {#var#} from {#var#} for Rs {#var#}. Please confirm it in the GD Kite Center app.',
  },
  adminLowStock: {
    audience: 'admin',
    text: 'Low stock: {#var#} has {#var#} left. Please restock. - GD Kite Center',
  },

  /** Admin "send test SMS" from Settings. */
  test: {
    audience: 'admin',
    text: 'Test message from GD Kite Center. SMS is working. - GD Kite Center',
  },
} as const satisfies Record<string, { audience: 'customer' | 'driver' | 'admin'; text: string; secretVar?: number }>;

export type SmsEvent = keyof typeof SMS_TEMPLATES;
export const SMS_EVENTS = Object.keys(SMS_TEMPLATES) as SmsEvent[];

/** Variables are capped at 30 characters (keeps messages short). */
export const clipVar = (v: string | number) => String(v).replace(/\s+/g, ' ').trim().slice(0, 30);

export function renderSms(event: SmsEvent, vars: (string | number)[]) {
  let i = 0;
  return SMS_TEMPLATES[event].text.replace(/\{#var#\}/g, () => clipVar(vars[i++] ?? ''));
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
