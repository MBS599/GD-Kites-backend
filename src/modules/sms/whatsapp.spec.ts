import { pushFor } from './push.service';
import { WhatsAppProvider } from './sms.providers';
import { SMS_EVENTS, SMS_TEMPLATES, varCount } from './sms.templates';
import { renderWhatsApp, templateCreatePayload, WA_TEMPLATES } from './whatsapp.templates';

describe('WhatsApp templates', () => {
  it('cover every message and follow Meta rules', () => {
    for (const event of SMS_EVENTS) {
      const t = WA_TEMPLATES[event];
      expect(t.name).toMatch(/^[a-z0-9_]{1,512}$/);
      if (t.category === 'AUTHENTICATION') continue;
      // {{1}}, {{2}}… in order of appearance.
      const nums = [...t.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
      expect({ event, nums }).toEqual({ event, nums: nums.map((_, i) => i + 1) });
      // Never starts or ends with a parameter; one example per parameter.
      expect({ event, start: /^\s*\{\{/.test(t.body), end: /\}\}[\s.!?]*$/.test(t.body) }).toEqual({ event, start: false, end: false });
      expect({ event, examples: t.examples.length }).toEqual({ event, examples: nums.length });
      // Same inputs as the SMS version.
      expect(t.params(Array.from({ length: varCount(event) }, (_, i) => `v${i}`))).toHaveLength(nums.length);
    }
  });

  it('renders the delivery code template with the order first', () => {
    expect(renderWhatsApp('deliveryOtp', ['4821', 'GD1037'])).toBe(
      'Your delivery code for GD Kite Center order *GD1037* is *4821*.\n\n' +
        'Share it with the driver only after you have received your order.\n\n— GD Kite Center, Kondhwa, Pune',
    );
    expect(renderWhatsApp('loginOtp', ['123456'])).toContain('verification code is:\n\n*123456*\n');
  });

  it('builds creation payloads (authentication uses a copy-code button)', () => {
    const auth = templateCreatePayload(WA_TEMPLATES.loginOtp, 'en') as any;
    expect(auth.category).toBe('AUTHENTICATION');
    expect(auth.components[2].buttons[0]).toEqual({ type: 'OTP', otp_type: 'COPY_CODE', text: 'Copy code' });
    const util = templateCreatePayload(WA_TEMPLATES.orderPlaced, 'en') as any;
    expect(util.components[0].example.body_text[0][0]).toBe('Mayur Traders');
    expect(Object.keys(SMS_TEMPLATES)).toEqual(Object.keys(WA_TEMPLATES));
  });
});

describe('WhatsAppProvider', () => {
  const realFetch = global.fetch;
  afterEach(() => (global.fetch = realFetch));
  const mockFetch = (status: number, body: unknown) => {
    const calls: { url: string; init: RequestInit }[] = [];
    global.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
    return calls;
  };

  it('sends the approved template with body parameters', async () => {
    const calls = mockFetch(200, { messages: [{ id: 'wamid.X' }] });
    const res = await new WhatsAppProvider('TOKEN', '1234', 'en', 'v22.0').send({
      event: 'deliveryOtp',
      to: '919822011122',
      vars: ['4821', 'GD1037'],
      text: '',
    });
    expect(res.ref).toBe('wamid.X');
    expect(calls[0].url).toBe('https://graph.facebook.com/v22.0/1234/messages');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer TOKEN');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '919822011122',
      type: 'template',
      template: {
        name: 'gdk_delivery_code_v2',
        language: { code: 'en' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: 'GD1037' }, { type: 'text', text: '4821' }] }],
      },
    });
  });

  it('adds the copy-code button parameter for sign-in codes', async () => {
    const calls = mockFetch(200, { messages: [{ id: 'wamid.Y' }] });
    await new WhatsAppProvider('T', '1').send({ event: 'loginOtp', to: '91', vars: ['123456'], text: '' });
    const components = JSON.parse(calls[0].init.body as string).template.components;
    expect(components[1]).toEqual({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '123456' }] });
  });

  it('classifies errors: rate limits retry, template problems do not', async () => {
    mockFetch(400, { error: { message: 'Template name does not exist', code: 132001 } });
    const bad = await new WhatsAppProvider('T', '1').send({ event: 'test', to: '91', vars: [], text: '' }).catch((e) => e);
    expect(bad.retryable).toBe(false);
    expect(bad.message).toContain('132001');
    mockFetch(400, { error: { message: 'Rate limit', code: 130429 } });
    const slow = await new WhatsAppProvider('T', '1').send({ event: 'test', to: '91', vars: [], text: '' }).catch((e) => e);
    expect(slow.retryable).toBe(true);
  });
});

describe('order messages', () => {
  it('greet the customer by name and list what they ordered', () => {
    const text = renderWhatsApp('orderPlaced', [
      'Mayur Traders',
      'GD1037',
      '100 × Premium Fighter Kite (Medium), 2 × Bareilly Manjha 9 Cord',
      '2,980',
      'Shop 14, Katraj, Pune',
    ]);
    expect(text).toContain('Hello Mayur Traders,');
    expect(text).toContain('*Items:* 100 × Premium Fighter Kite (Medium), 2 × Bareilly Manjha 9 Cord');
    expect(text).toContain('*Total:* Rs 2,980');
    expect(text).toContain('*Deliver to:* Shop 14, Katraj, Pune');
    expect(renderWhatsApp('driverAssigned', ['Mayur Traders', 'GD1037', 'Rahul Patil', '+91 98220 11122'])).toContain(
      '*Rahul Patil* (+91 98220 11122) will deliver your order *GD1037*',
    );
  });
});

describe('push texts', () => {
  it('carry the event and order for tap handling; sign-in codes never go by push', () => {
    expect(pushFor('outForDelivery', ['Mayur Traders', 'GD1037', 'Rahul Patil', '+91 98220 11122', '4821'], 'o1')).toEqual({
      title: 'Out for delivery',
      body: 'GD1037 is on the way with Rahul Patil. Delivery code: 4821',
      data: { type: 'outForDelivery', orderId: 'o1' },
    });
    expect(pushFor('loginOtp', ['123456'])).toBeNull();
    expect(pushFor('test', [])).toBeNull();
  });
});
