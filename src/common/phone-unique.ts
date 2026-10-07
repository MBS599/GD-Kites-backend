import type { PrismaService } from '../prisma/prisma.service';
import { normalizeIndianMobile } from '../modules/sms/sms.service';

/**
 * Whether another account already has this mobile number — verified (OTP) or just
 * saved — compared on its last 10 digits, so "+91 98220 11122" and "9822011122" match.
 */
export async function phoneInUse(prisma: PrismaService, raw: string, exceptUserId?: string): Promise<boolean> {
  const phone = normalizeIndianMobile(raw);
  if (!phone) return false;
  const ten = phone.slice(2);
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "User"
    WHERE id <> ${exceptUserId ?? ''}
      AND ("phoneVerified" = ${phone} OR right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) = ${ten})
    LIMIT 1`;
  return rows.length > 0;
}

export const PHONE_TAKEN = 'This mobile number is already used by another GD Kites account.';
