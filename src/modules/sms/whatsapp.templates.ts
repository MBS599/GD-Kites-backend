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

const SIGN = '\n\n— GD Kite Center, Kondhwa, Pune';

export const WA_TEMPLATES: Record<SmsEvent, WaTemplate> = {
  orderPlaced: {
    name: 'gdk_order_placed_v3',
    category: 'UTILITY',
    body:
      'Hi {{1}},\n\nThank you for your order! We have received order *#{{2}}* for {{3}} ' +
      '(total *Rs {{4}}*), to be delivered at {{5}}.\n\nWe will confirm it shortly and keep you updated here.' +
      SIGN,
    examples: ['Mayur', 'GD1037', '100 × Premium Fighter Kite (Medium), 2 × Bareilly Manjha 9 Cord', '2,980', 'Shop 14, Katraj, Pune'],
    params: same,
  },
  orderConfirmed: {
    name: 'gdk_order_confirmed_v3',
    category: 'UTILITY',
    body:
      'Hi {{1}},\n\nGood news! Your order *#{{2}}* for {{3}} (*Rs {{4}}*) is confirmed and is being packed. ' +
      'It will reach you within 3–4 working days, and we will message you when it is out for delivery.' +
      SIGN,
    examples: ['Mayur', 'GD1037', '100 × Premium Fighter Kite (Medium), 2 × Bareilly Manjha 9 Cord', '2,980'],
    params: same,
  },
  driverAssigned: {
    name: 'gdk_driver_assigned_v3',
    category: 'UTILITY',
    body:
      'Hi {{1}},\n\nYour order *#{{2}}* for {{3}} will be delivered by *{{4}}* ({{5}}). ' +
      'You will get your delivery code when it is on the way.' +
      SIGN,
    examples: ['Mayur', 'GD1037', '100 × Premium Fighter Kite (Medium), 2 × Bareilly Manjha 9 Cord', 'Gaurav Dhamal', '+91 98220 11122'],
    params: same,
  },
  outForDelivery: {
    name: 'gdk_out_for_delivery_v3',
    category: 'UTILITY',
    body:
      'Hi {{1}},\n\nYour order *#{{2}}* for {{3}} is out for delivery with *{{4}}* ({{5}}).\n\n' +
      '*Delivery code: {{6}}*\nShare this code with the driver only after you have received all your items.' +
      SIGN,
    examples: ['Mayur', 'GD1037', '100 × Premium Fighter Kite (Medium), 2 × Bareilly Manjha 9 Cord', 'Gaurav Dhamal', '+91 98220 11122', '4821'],
    params: same,
  },
  deliveryOtp: {
    name: 'gdk_delivery_code_v3',
    category: 'UTILITY',
    body:
      'Your delivery code for order *#{{1}}* is *{{2}}*.\n\n' +
      'Share it with the driver only after you have received your order.' +
      SIGN,
    examples: ['GD1037', '4821'],
    // Event order is [code, order]; the text mentions the order first.
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
    name: 'gdk_order_delivered_v3',
    category: 'UTILITY',
    body:
      'Hi {{1}},\n\nYour order *#{{2}}* for {{3}} has been delivered (*Rs {{4}}*).\n\n' +
      'Thank you for shopping with GD Kite Center. We look forward to serving you again!' +
      SIGN,
    examples: ['Mayur', 'GD1037', '100 × Premium Fighter Kite (Medium), 2 × Bareilly Manjha 9 Cord', '2,980'],
    params: same,
  },
  orderCancelled: {
    name: 'gdk_order_cancelled_v3',
    category: 'UTILITY',
    body:
      'Hi {{1}},\n\nWe are sorry, your order *#{{2}}* for {{3}} has been cancelled. Reason: {{4}}.\n\n' +
      'If you have any questions, simply reply to this message.' +
      SIGN,
    examples: ['Mayur', 'GD1037', '100 × Premium Fighter Kite (Medium)', 'Out of stock'],
    params: same,
  },
  driverWelcome: {
    name: 'gdk_driver_welcome_v3',
    category: 'UTILITY',
    body:
      'Hi {{1}},\n\nWelcome to the *GD Kite Center* delivery team. Install the GD Kites app and sign in with {{2}} ' +
      'to see your deliveries.' +
      SIGN,
    examples: ['Rahul', 'your mobile number'],
    params: same,
  },
  deliveryAssigned: {
    name: 'gdk_delivery_assigned_v3',
    category: 'UTILITY',
    body:
      'Hi {{1}},\n\nYou have a new delivery: order *#{{2}}* for *{{3}}* in {{4}}, with {{5}}.\n\n' +
      'Open the GD Kites app to see the route and start the delivery.' +
      SIGN,
    examples: ['Rahul', 'GD1037', 'Mayur Traders', 'Katraj', '100 × Premium Fighter Kite (Medium), 2 × Bareilly Manjha 9 Cord'],
    params: same,
  },
  deliveryRemoved: {
    name: 'gdk_delivery_removed_v3',
    category: 'UTILITY',
    body: 'Order *#{{1}}* is no longer assigned to you. No action is needed.' + SIGN,
    examples: ['GD1037'],
    params: same,
  },
  adminNewOrder: {
    name: 'gdk_admin_new_order_v3',
    category: 'UTILITY',
    body:
      'New order *#{{1}}* from *{{2}}* for {{3}} (total *Rs {{4}}*), delivering to {{5}}.\n\n' +
      'Please confirm it in the GD Kites app.',
    examples: ['GD1037', 'Mayur Traders', '100 × Premium Fighter Kite (Medium), 2 × Bareilly Manjha 9 Cord', '2,980', 'Katraj'],
    params: same,
  },
  test: {
    name: 'gdk_test',
    category: 'UTILITY',
    body: 'Test message from *GD Kite Center*. WhatsApp notifications are working.',
    examples: [],
    params: () => [],
  },
};

/**
 * The message text: what the linked phone sends, and what the log shows. The sign-in
 * code sits alone on its own line so it is easy to copy (the app fills in a copied code).
 * (Meta's Cloud API uses its own fixed wording for authentication templates.)
 */
export function renderWhatsApp(event: SmsEvent, vars: string[]) {
  const t = WA_TEMPLATES[event];
  const p = t.params(vars);
  if (t.category === 'AUTHENTICATION') {
    return `Your GD Kite Center verification code is:\n\n*${p[0] ?? ''}*\n\nIt is valid for 5 minutes. For your security, do not share this code.`;
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
