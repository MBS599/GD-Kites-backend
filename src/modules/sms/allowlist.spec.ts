import { SmsService } from './sms.service';

function service(allowlist: string[]) {
  const created: any[] = [];
  const prisma = {
    smsMessage: {
      create: jest.fn(async ({ data }: any) => {
        created.push(data);
        return data;
      }),
      findFirst: jest.fn(async () => null),
    },
  };
  const values: Record<string, unknown> = { MESSAGING_PROVIDER: 'log', MESSAGING_ALLOWLIST: allowlist };
  const config = { get: (k: string) => values[k] } as any;
  const push = { enabled: false, notifyUser: jest.fn() } as any;
  return { svc: new SmsService(prisma as any, config, push, {} as any), created };
}

describe('MESSAGING_ALLOWLIST (testing safety net)', () => {
  it('only messages allowed numbers; others are logged as skipped', async () => {
    const { svc } = service(['+91 93078 26630']);
    expect((await svc.sendTest('9307826630', 'admin')).status).toBe('LOGGED');
    const other = await svc.sendTest('9822045118', 'admin');
    expect(other.status).toBe('SKIPPED');
    expect(other.error).toContain('allowlist');
  });

  it('sends to everyone when empty', async () => {
    const { svc } = service([]);
    expect((await svc.sendTest('9822045118', 'admin')).status).toBe('LOGGED');
  });
});
