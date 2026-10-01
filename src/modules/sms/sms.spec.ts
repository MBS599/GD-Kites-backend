import { normalizeIndianMobile } from './sms.service';
import { clipVar, renderSms, SMS_TEMPLATES, varCount } from './sms.templates';

describe('normalizeIndianMobile', () => {
  it.each([
    ['9822011122', '919822011122'],
    ['+91 98220 11122', '919822011122'],
    ['09822011122', '919822011122'],
    ['91-9822011122', '919822011122'],
  ])('%s → %s', (raw, out) => expect(normalizeIndianMobile(raw)).toBe(out));

  it.each(['', null, '12345', '5822011122', '+1 415 555 0100', '+91 20 2426 0000'])('rejects %p', (raw) =>
    expect(normalizeIndianMobile(raw)).toBeNull(),
  );
});

describe('templates', () => {
  it('fills {#var#} in order and clips each value to 30 chars', () => {
    const text = renderSms('orderCancelled', ['GD1030', 'x'.repeat(50)]);
    expect(text).toBe(`Your GD Kite Center order GD1030 was cancelled. Reason: ${'x'.repeat(30)}. - GD Kite Center`);
    expect(clipVar('  a   b ')).toBe('a b');
  });

  it('every message stays short even with full-length variables', () => {
    for (const [event, t] of Object.entries(SMS_TEMPLATES)) {
      const longest = t.text.replaceAll('{#var#}', 'x'.repeat(30));
      expect({ event, length: longest.length <= 306 }).toEqual({ event, length: true });
      expect(varCount(event as keyof typeof SMS_TEMPLATES)).toBeLessThanOrEqual(4);
    }
  });
});
