import { Injectable } from '@nestjs/common';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

/** Random numeric codes. A provider so tests can make codes predictable. */
@Injectable()
export class OtpGenerator {
  code(digits: number) {
    return randomInt(0, 10 ** digits)
      .toString()
      .padStart(digits, '0');
  }
}

/** Keyed hash so a leaked table can't be brute-forced without the server secret. */
export const hashOtp = (secret: string, subject: string, code: string) =>
  createHmac('sha256', secret).update(`${subject}:${code}`).digest('hex');

export const sameHash = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
