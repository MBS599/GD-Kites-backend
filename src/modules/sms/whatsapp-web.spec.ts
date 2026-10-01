import { EventEmitter } from 'node:events';
import { WhatsAppWebProvider } from './sms.providers';
import { WhatsAppWebSession, type WebClient } from './whatsapp-web.session';

class FakeClient extends EventEmitter implements WebClient {
  sent: { chatId: string; text: string; at: number }[] = [];
  onWhatsApp = new Set(['919822011122']);
  info = { wid: { user: '919000000001' } };
  async initialize() {}
  async destroy() {}
  async logout() {}
  async getState() {
    return 'CONNECTED';
  }
  async getNumberId(n: string) {
    return this.onWhatsApp.has(n) ? { _serialized: `${n}@c.us` } : null;
  }
  /** Simulates the whatsapp-web.js bug: message goes out, then the library throws. */
  breakAfterSend = false;
  async sendMessage(chatId: string, text: string) {
    this.sent.push({ chatId, text, at: Date.now() });
    if (this.breakAfterSend) throw new TypeError("Cannot read properties of undefined (reading 'id')");
    return { id: { _serialized: `msg-${this.sent.length}` } };
  }
  async getChatById() {
    return {
      fetchMessages: async () => this.sent.map((m, i) => ({ body: m.text, id: { _serialized: `msg-${i + 1}` } })),
    };
  }
}

const config = (over: Record<string, unknown> = {}) =>
  ({ get: (k: string) => ({ MESSAGING_PROVIDER: 'wwebjs', WWEBJS_SESSION_DIR: '.x', WWEBJS_MIN_GAP_MS: 50, ...over })[k] }) as any;

function session(prisma: any = { smsMessage: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } }) {
  const fake = new FakeClient();
  const s = new (class extends WhatsAppWebSession {
    protected async createClient() {
      return fake;
    }
  })(config(), prisma);
  return { s, fake, prisma };
}

describe('WhatsApp Web (linked phone)', () => {
  it('shows a QR code until the phone is linked, then becomes ready', async () => {
    const { s, fake } = session();
    await s.start();
    expect(s.state).toBe('starting');
    fake.emit('qr', 'qr-payload');
    // QR image rendering is async (~100 ms).
    for (let i = 0; i < 40 && !s.qr; i++) await new Promise((r) => setTimeout(r, 50));
    expect(s.state).toBe('qr');
    expect(s.qr).toMatch(/^data:image\/png;base64,/);
    fake.emit('ready');
    expect(s.state).toBe('ready');
    expect(s.qr).toBeNull();
    expect(s.number).toBe('919000000001');
  });

  it('replaces an expired QR code with a fresh one when it is requested', async () => {
    const { s, fake } = session();
    await s.start();
    fake.emit('qr', 'first');
    for (let i = 0; i < 40 && !s.qr; i++) await new Promise((r) => setTimeout(r, 50));
    expect(s.currentQr()).toMatch(/^data:image\/png;base64,/);
    const restart = jest.spyOn(s, 'restart').mockResolvedValue();
    (s as any).qrAt = Date.now() - 60_000; // WhatsApp stopped rotating the code
    expect(s.currentQr()).toBeNull();
    expect(s.currentQr()).toBeNull();
    await new Promise((r) => setImmediate(r));
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('becomes ready from the connection state when the library never emits "ready"', async () => {
    const { s, fake } = session();
    await s.start();
    fake.emit('authenticated');
    for (let i = 0; i < 20 && s.state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 250));
    expect(s.state).toBe('ready');
    await s.onModuleDestroy();
  });

  it('refuses to send before linking, with a clear message and no retry', async () => {
    const { s } = session();
    const err = await new WhatsAppWebProvider(s)
      .send({ event: 'test', to: '919822011122', vars: [], text: 'hi' })
      .catch((e) => e);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('not connected');
  });

  it('sends one at a time with a minimum gap, only to WhatsApp users', async () => {
    const { s, fake } = session();
    await s.start();
    fake.emit('ready');
    const p = new WhatsAppWebProvider(s);
    const [a, b] = await Promise.all([
      p.send({ event: 'test', to: '919822011122', vars: [], text: 'one' }),
      p.send({ event: 'test', to: '919822011122', vars: [], text: 'two' }),
    ]);
    expect([a.ref, b.ref]).toEqual(['msg-1', 'msg-2']);
    expect(fake.sent.map((m) => m.chatId)).toEqual(['919822011122@c.us', '919822011122@c.us']);
    expect(fake.sent[1].at - fake.sent[0].at).toBeGreaterThanOrEqual(45);

    const missing = await p.send({ event: 'test', to: '919999999999', vars: [], text: 'x' }).catch((e) => e);
    expect(missing.message).toContain('not on WhatsApp');
    expect(missing.retryable).toBe(false);
  });

  it('a library error after sending is not retried (no duplicates) and the message id is recovered', async () => {
    const { s, fake } = session();
    await s.start();
    fake.emit('ready');
    fake.breakAfterSend = true;
    const res = await new WhatsAppWebProvider(s).send({ event: 'test', to: '919822011122', vars: [], text: 'hello' });
    expect(fake.sent).toHaveLength(1);
    expect(res.ref).toBe('msg-1');
  });

  it('records delivered / read receipts', async () => {
    const { s, fake, prisma } = session();
    await s.start();
    fake.emit('message_ack', { id: { _serialized: 'msg-7' } }, 3);
    await new Promise((r) => setImmediate(r));
    expect(prisma.smsMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ providerRef: 'msg-7' }), data: expect.objectContaining({ deliveryStatus: 'read' }) }),
    );
  });

  it('stays off unless MESSAGING_PROVIDER is wwebjs', () => {
    const s = new WhatsAppWebSession(config({ MESSAGING_PROVIDER: 'log' }), {} as any);
    expect(s.enabled).toBe(false);
    s.onModuleInit();
    expect(s.state).toBe('off');
  });
});
