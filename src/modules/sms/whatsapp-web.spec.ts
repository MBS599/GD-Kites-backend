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
  pairingFor: string | null = null;
  async requestPairingCode(phone: string) {
    this.pairingFor = phone;
    return 'ABCD1234';
  }
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

const fakePrisma = () => ({
  smsMessage: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  appSettings: { upsert: jest.fn().mockResolvedValue({}) },
  user: { findMany: jest.fn().mockResolvedValue([{ id: 'admin-1' }]) },
});

function session(prisma: any = fakePrisma()) {
  let fake = new FakeClient();
  const push = { notifyUser: jest.fn() };
  const cleared = { count: 0 };
  const s = new (class extends WhatsAppWebSession {
    protected async createClient() {
      return fake;
    }
    protected async clearSavedLogin() {
      cleared.count++;
    }
  })(config(), prisma, push as any);
  const nextClient = () => (fake = new FakeClient());
  return { s, get fake() { return fake; }, prisma, push, cleared, nextClient };
}

// Drawing the QR images is slow when the whole suite runs in parallel on a busy machine.
jest.setTimeout(30_000);

describe('WhatsApp Web (linked phone)', () => {
  afterEach(() => jest.useRealTimers());

  it('logged out on the phone: starts over without the saved login (new QR) and tells the admins', async () => {
    jest.useFakeTimers();
    const { s, fake, push, cleared } = session();
    await s.start();
    fake.emit('ready');
    expect(s.state).toBe('ready');
    const fresh = jest.spyOn(s, 'freshLink').mockResolvedValue();
    fake.emit('disconnected', 'LOGOUT');
    expect(s.state).toBe('disconnected');
    await jest.advanceTimersByTimeAsync(15_000);
    expect(fresh).toHaveBeenCalledTimes(1);
    fresh.mockRestore();
    // Still not linked 2 minutes later: one push to each admin, not repeated.
    await jest.advanceTimersByTimeAsync(2 * 60_000);
    expect(push.notifyUser).toHaveBeenCalledTimes(1);
    expect(push.notifyUser.mock.calls[0][1]).toMatchObject({ title: 'WhatsApp is not connected', data: { type: 'whatsappDown' } });
    fake.emit('disconnected', 'NAVIGATION');
    await jest.advanceTimersByTimeAsync(3 * 60_000);
    expect(push.notifyUser).toHaveBeenCalledTimes(1);
    await s.onModuleDestroy();
  });

  it('a network blip that reconnects quickly does not alert anyone', async () => {
    jest.useFakeTimers();
    const { s, fake, push } = session();
    await s.start();
    fake.emit('ready');
    jest.spyOn(s, 'restart').mockResolvedValue();
    fake.emit('disconnected', 'NAVIGATION');
    await jest.advanceTimersByTimeAsync(20_000);
    fake.emit('ready');
    await jest.advanceTimersByTimeAsync(3 * 60_000);
    expect(push.notifyUser).not.toHaveBeenCalled();
    await s.onModuleDestroy();
  });

  it('links with a code only while waiting to be linked, and keeps that session for 3 minutes', async () => {
    jest.useFakeTimers();
    const { s, fake } = session();
    await s.start();
    await expect(s.pairingCode('919822011122')).rejects.toThrow('not waiting to be linked');
    fake.emit('qr', 'qr-payload');
    for (let i = 0; i < 40 && !s.qr; i++) await jest.advanceTimersByTimeAsync(50);
    expect(await s.pairingCode('919822011122')).toBe('ABCD1234');
    expect(fake.pairingFor).toBe('919822011122');
    // The QR would count as stale after 45 s, but a code is being typed: no restart.
    const restart = jest.spyOn(s, 'restart').mockResolvedValue();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(s.currentQr()).not.toBeNull();
    expect(restart).not.toHaveBeenCalled();
    await s.onModuleDestroy();
  });

  it('"Get a new QR code" removes the saved login and starts again', async () => {
    const { s, cleared } = session();
    await s.start();
    await s.logout();
    expect(cleared.count).toBe(1);
    expect(s.state).toBe('starting');
    await s.onModuleDestroy();
  });

  it('no QR code and no login after 90 s: starts over without the saved login once, then shows failed', async () => {
    jest.useFakeTimers();
    const { s, cleared } = session();
    await s.start();
    expect(s.state).toBe('starting');
    await jest.advanceTimersByTimeAsync(90_000);
    expect(cleared.count).toBe(1);
    expect(s.state).toBe('starting');
    await jest.advanceTimersByTimeAsync(90_000);
    expect(cleared.count).toBe(1);
    expect(s.state).toBe('failed');
    expect(s.lastError).toContain('Get a new QR code');
    await s.onModuleDestroy();
  });

  it('a frozen browser fails the send quickly and restarts WhatsApp Web', async () => {
    const { s, fake } = session();
    await s.start();
    fake.emit('ready');
    fake.getNumberId = () => Promise.reject(new Error('Runtime.callFunctionOn timed out. Increase the protocolTimeout'));
    const restart = jest.spyOn(s, 'restart').mockResolvedValue();
    await expect(s.send('919822011122', 'hi')).rejects.toThrow('timed out');
    expect(restart).toHaveBeenCalledTimes(1);
    // The provider retries it (a fresh browser may send it); "not on WhatsApp" is final.
    const provider = new WhatsAppWebProvider(s);
    await expect(provider.send({ event: 'loginOtp', to: '919822011122', vars: [], text: 'x' })).rejects.toMatchObject({
      retryable: true,
    });
  });

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

  it('says whether a number is on WhatsApp; unknown before linking or when the check fails', async () => {
    const { s, fake } = session();
    expect(await s.isOnWhatsApp('919822011122')).toBeNull();
    await s.start();
    fake.emit('ready');
    expect(await s.isOnWhatsApp('919822011122')).toBe(true);
    expect(await s.isOnWhatsApp('919999999999')).toBe(false);
    fake.getNumberId = () => Promise.reject(new Error('Evaluation failed'));
    expect(await s.isOnWhatsApp('919822011122')).toBeNull();
    expect(s.state).toBe('ready');
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

  it('saves the linked number as the contact number, and clears it when the phone is unlinked', async () => {
    const { s, fake, prisma } = session();
    await s.start();
    fake.emit('ready');
    await new Promise((r) => setImmediate(r));
    expect(prisma.appSettings.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({ update: { whatsappNumber: '919000000001' } }),
    );

    fake.emit('disconnected', 'NAVIGATION'); // network blip: keep the number
    await new Promise((r) => setImmediate(r));
    expect(prisma.appSettings.upsert).toHaveBeenCalledTimes(1);

    fake.emit('disconnected', 'LOGOUT'); // removed under Linked devices on the phone
    await new Promise((r) => setImmediate(r));
    expect(prisma.appSettings.upsert).toHaveBeenLastCalledWith(expect.objectContaining({ update: { whatsappNumber: null } }));
    await s.onModuleDestroy();
  });

  it('clears the contact number when an admin unlinks the phone', async () => {
    const { s, fake, prisma } = session();
    await s.start();
    fake.emit('ready');
    await s.logout();
    expect(prisma.appSettings.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { whatsappNumber: null } }));
    await s.onModuleDestroy();
  });

  it('stays off unless MESSAGING_PROVIDER is wwebjs', () => {
    const s = new WhatsAppWebSession(config({ MESSAGING_PROVIDER: 'log' }), {} as any, {} as any);
    expect(s.enabled).toBe(false);
    s.onModuleInit();
    expect(s.state).toBe('off');
  });
});
