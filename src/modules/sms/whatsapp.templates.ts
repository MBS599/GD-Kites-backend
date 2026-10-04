import type { SmsEvent } from './sms.templates';

/**
 * WhatsApp versions of every message. WhatsApp only delivers business-started
 * messages from templates approved by Meta, so each event maps to a template
 * that the admin creates in one click (Admin → Settings → Messages →
 * "Create WhatsApp templates"), which calls Meta's template API with these
 * definitions.
 *
 * Meta rules followed here: parameters are numbered {{1}}, {{2}}… in order of
 * appearance, a body never starts or ends with a parameter, and every
 * parameter has an example value.
 *
 * `params` picks, from the event's variables (same order as the SMS template),
 * the values for {{1}}, {{2}}, …
 */
export interface WaTemplate {
  name: string;
  category: 'UTILITY' | 'AUTHENTICATION';
  /** Body text (unused for AUTHENTICATION: Meta supplies the fixed OTP wording). */
  body: string;
  examples: string[];
  params: (vars: string[]) => string[];
}

const same = (vars: string[]) => vars;

export const WA_TEMPLATES: Record<SmsEvent, WaTemplate> = {
  orderPlaced: {
    name: 'gdk_order_placed',
    category: 'UTILITY',
    body: 'Dear {{1}}, your GD Kite Center order {{2}} of Rs {{3}} is placed. We will confirm it shortly.',
    examples: ['Mayur Traders', 'GD1037', '1,457'],
    params: same,
  },
  orderConfirmed: {
    name: 'gdk_order_confirmed',
    category: 'UTILITY',
    body: 'Your GD Kite Center order {{1}} is confirmed and is being packed.',
    examples: ['GD1037'],
    params: same,
  },
  driverAssigned: {
    name: 'gdk_driver_assigned',
    category: 'UTILITY',
    body: 'Order {{1}}: {{2}} ({{3}}) will deliver your GD Kite Center order.',
    examples: ['GD1037', 'Rahul Patil', '+91 98220 11122'],
    params: same,
  },
  outForDelivery: {
    name: 'gdk_out_for_delivery',
    category: 'UTILITY',
    body: 'Order {{1}} is out for delivery with {{2}} ({{3}}). Share delivery code {{4}} with the driver only when you receive your order.',
    examples: ['GD1037', 'Rahul Patil', '+91 98220 11122', '4821'],
    params: same,
  },
  deliveryOtp: {
    name: 'gdk_delivery_code',
    category: 'UTILITY',
    body: 'The delivery code for your GD Kite Center order {{1}} is {{2}}. Share it with the driver only when you receive your order.',
    examples: ['GD1037', '4821'],
    // SMS order is [code, order] — WhatsApp text mentions the order first.
    params: ([otp, order]) => [order, otp],
  },
  loginOtp: {
    name: 'gdk_login_code',
    category: 'AUTHENTICATION',
    body: '',
    examples: ['123456'],
    params: same,
  },
  orderDelivered: {
    name: 'gdk_order_delivered',
    category: 'UTILITY',
    body: 'Order {{1}} is delivered. Amount Rs {{2}}. Thank you for ordering from GD Kite Center.',
    examples: ['GD1037', '1,457'],
    params: same,
  },
  orderCancelled: {
    name: 'gdk_order_cancelled',
    category: 'UTILITY',
    body: 'Your GD Kite Center order {{1}} was cancelled. Reason: {{2}}. Please contact us if you have any questions.',
    examples: ['GD1037', 'Out of stock'],
    params: same,
  },
  driverWelcome: {
    name: 'gdk_driver_welcome',
    category: 'UTILITY',
    body: 'Hi {{1}}, you are added as a GD Kite Center driver. Install the app and sign in with {{2}} to start deliveries.',
    examples: ['Rahul', 'your mobile number'],
    params: same,
  },
  deliveryAssigned: {
    name: 'gdk_delivery_assigned',
    category: 'UTILITY',
    body: 'New delivery {{1}} for {{2}}, {{3}}. Open the GD Kite Center app to start.',
    examples: ['GD1037', 'Mayur Traders', 'Katraj'],
    params: same,
  },
  deliveryRemoved: {
    name: 'gdk_delivery_removed',
    category: 'UTILITY',
    body: 'Delivery {{1}} is no longer assigned to you. No action is needed.',
    examples: ['GD1037'],
    params: same,
  },
  adminNewOrder: {
    name: 'gdk_admin_new_order',
    category: 'UTILITY',
    body: 'New order {{1}} from {{2}} for Rs {{3}}. Please confirm it in the GD Kite Center app.',
    examples: ['GD1037', 'Mayur Traders', '1,457'],
    params: same,
  },
  test: {
    name: 'gdk_test',
    category: 'UTILITY',
    body: 'Test message from GD Kite Center. WhatsApp notifications are working.',
    examples: [],
    params: () => [],
  },
};

/** What WhatsApp shows, for the message log. Auth templates use Meta's fixed wording. */
export function renderWhatsApp(event: SmsEvent, vars: string[]) {
  const t = WA_TEMPLATES[event];
  const p = t.params(vars);
  if (t.category === 'AUTHENTICATION') {
    return `${p[0] ?? ''} is your verification code. For your security, do not share this code.`;
  }
  return t.body.replace(/\{\{(\d+)\}\}/g, (_, n: string) => p[Number(n) - 1] ?? '');
}

/** Payload for Meta's "create message template" API. */
export function templateCreatePayload(t: WaTemplate, language: string) {
  if (t.category === 'AUTHENTICATION') {
    return {
      name: t.name,
      language,
      category: 'AUTHENTICATION',
      components: [
        { type: 'BODY', add_security_recommendation: true },
        { type: 'FOOTER', code_expiration_minutes: 5 },
        { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'Copy code' }] },
      ],
    };
  }
  return {
    name: t.name,
    language,
    category: 'UTILITY',
    components: [
      t.examples.length
        ? { type: 'BODY', text: t.body, example: { body_text: [t.examples] } }
        : { type: 'BODY', text: t.body },
    ],
  };
}
