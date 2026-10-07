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
  it('fills {#var#} in order; short values are capped at 40 characters, item lists at 300', () => {
    const text = renderSms('orderCancelled', ['N'.repeat(50), 'GD1030', 'i'.repeat(320), 'Out of stock']);
    expect(text).toBe(
      `Hello ${'N'.repeat(39)}…, your GD Kite Center order GD1030 (${'i'.repeat(299)}…) was cancelled. Reason: Out of stock.`,
    );
    expect(clipVar('  a   b ')).toBe('a b');
  });

  it('every template uses its variables', () => {
    for (const event of Object.keys(SMS_TEMPLATES) as (keyof typeof SMS_TEMPLATES)[]) {
      expect(varCount(event)).toBeLessThanOrEqual(5);
    }
  });
});
