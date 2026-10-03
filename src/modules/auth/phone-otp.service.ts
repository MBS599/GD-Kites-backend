import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { UserWithDriver } from '../../common/serializers';
import { AppConfig } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { hashOtp, OtpGenerator, sameHash } from '../sms/otp';
import { normalizeIndianMobile, SmsService } from '../sms/sms.service';

export const LOGIN_OTP = {
  digits: 6,
  ttlMs: 5 * 60_000,
  /** Wait before asking for another code. */
  resendAfterMs: 30_000,
  maxPerHour: 5,
  maxAttempts: 5,
} as const;

const tooMany = (message: string, retryAfterSec?: number) =>
  new HttpException({ message, code: 'too_many_requests', details: { retryAfterSec } }, HttpStatus.TOO_MANY_REQUESTS);

/** "919822011122" → "+91 98220 11122" (how phones are shown elsewhere). */
const display = (n: string) => `+91 ${n.slice(2, 7)} ${n.slice(7)}`;

/**
 * Sign-in with a mobile number + SMS code.
 *
 * - Unknown number → a new CUSTOMER account (needs a name). Roles are never
 *   chosen by the caller.
 * - A number already on a customer/driver account (e.g. a driver added by an
 *   admin) signs into that account.
 * - Admin accounts must use Google sign-in.
 */
@Injectable()
export class PhoneOtpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sms: SmsService,
    private readonly otp: OtpGenerator,
    private readonly config: AppConfig,
  ) {}

  /** Off in production unless a real SMS gateway is configured (codes would only reach the server log). */
  get enabled() {
    return this.sms.provider.name !== 'log' || !this.config.isProduction;
  }

  /** Where sign-in codes go: 'whatsapp' or 'sms' (the app words its screens accordingly). */
  get channel() {
    return this.sms.provider.name === 'log' ? 'sms' : 'whatsapp';
  }

  private hash(phone: string, code: string) {
    return hashOtp(this.config.get('JWT_ACCESS_SECRET'), phone, code);
  }

  private phone(raw: string) {
    const phone = normalizeIndianMobile(raw);
    if (!phone) throw new BadRequestException('Enter a valid 10-digit Indian mobile number.');
    return phone;
  }

  async request(raw: string) {
    if (!this.enabled) throw new ServiceUnavailableException('Mobile sign-in is not available right now.');
    const phone = this.phone(raw);
    const now = Date.now();
    const recent = await this.prisma.otpChallenge.findMany({
      where: { phone, createdAt: { gte: new Date(now - 60 * 60_000) } },
      orderBy: { createdAt: 'desc' },
    });
    const last = recent[0];
    if (last && now - last.createdAt.getTime() < LOGIN_OTP.resendAfterMs) {
      const wait = Math.ceil((LOGIN_OTP.resendAfterMs - (now - last.createdAt.getTime())) / 1000);
      throw tooMany(`Please wait ${wait} s before requesting another code.`, wait);
    }
    if (recent.length >= LOGIN_OTP.maxPerHour) {
      throw tooMany('Too many codes requested for this number. Try again in an hour.', 3600);
    }

    const code = this.otp.code(LOGIN_OTP.digits);
    // Older unused codes stop working as soon as a new one is issued.
    await this.prisma.otpChallenge.updateMany({ where: { phone, consumedAt: null }, data: { consumedAt: new Date() } });
    await this.prisma.otpChallenge.create({
      data: { phone, codeHash: this.hash(phone, code), expiresAt: new Date(now + LOGIN_OTP.ttlMs) },
    });
    const status = await this.sms.loginOtp(phone, code);
    if (status === 'FAILED' || status === 'SKIPPED') {
      throw new ServiceUnavailableException('Could not send the SMS right now. Please try again or sign in with Google.');
    }
    return {
      sentTo: display(phone),
      expiresInSec: LOGIN_OTP.ttlMs / 1000,
      resendAfterSec: LOGIN_OTP.resendAfterMs / 1000,
    };
  }

  /**
   * Checks the code and returns the account to sign in. A wrong code counts
   * against the attempt limit; a correct one can be used once.
   */
  async verify(raw: string, code: string, name?: string): Promise<UserWithDriver> {
    const phone = this.phone(raw);
    const challenge = await this.check(phone, code);

    const existing = await this.findAccount(phone);
    if (existing) {
      if (existing.role === 'ADMIN') throw new ForbiddenException('Admin accounts sign in with Google.');
      if (!existing.isActive) throw new ForbiddenException('This account has been deactivated.');
    } else if (!name?.trim()) {
      // Code stays valid: the app asks for a name and sends it again.
      throw new UnprocessableEntityException({ message: 'Tell us your name to create your account.', code: 'name_required' });
    }

    await this.consume(challenge.id);

    if (existing) {
      return this.prisma.user.update({
        where: { id: existing.id },
        data: { phoneVerified: phone },
        include: { driverProfile: true },
      });
    }
    return this.prisma.user.create({
      data: {
        name: name!.trim().slice(0, 80),
        phone: display(phone),
        phoneVerified: phone,
        role: 'CUSTOMER',
        cart: { create: {} },
      },
      include: { driverProfile: true },
    });
  }

  /**
   * Adds a confirmed mobile number to a signed-in account (e.g. after Google sign-up,
   * so order updates reach the customer on WhatsApp).
   */
  async link(userId: string, raw: string, code: string): Promise<UserWithDriver> {
    const phone = this.phone(raw);
    const challenge = await this.check(phone, code);
    const owner = await this.prisma.user.findUnique({ where: { phoneVerified: phone }, select: { id: true } });
    if (owner && owner.id !== userId) {
      throw new ConflictException('This number is already used by another GD Kites account.');
    }
    await this.consume(challenge.id);
    return this.prisma.user.update({
      where: { id: userId },
      data: { phone: display(phone), phoneVerified: phone },
      include: { driverProfile: true },
    });
  }

  /** The live challenge for [phone] if [code] matches it; a wrong code uses up an attempt. */
  private async check(phone: string, code: string) {
    const challenge = await this.prisma.otpChallenge.findFirst({
      where: { phone, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!challenge) throw new BadRequestException('This code has expired. Please request a new one.');
    if (challenge.attempts >= LOGIN_OTP.maxAttempts) {
      throw tooMany('Too many wrong attempts. Please request a new code.');
    }
    if (!sameHash(challenge.codeHash, this.hash(phone, code.trim()))) {
      const left = LOGIN_OTP.maxAttempts - challenge.attempts - 1;
      await this.prisma.otpChallenge.update({ where: { id: challenge.id }, data: { attempts: { increment: 1 } } });
      if (left <= 0) throw tooMany('Too many wrong attempts. Please request a new code.');
      throw new BadRequestException(`Incorrect code. ${left} ${left === 1 ? 'attempt' : 'attempts'} left.`);
    }
    return challenge;
  }

  /** Single use, even under concurrent requests. */
  private async consume(id: string) {
    const used = await this.prisma.otpChallenge.updateMany({ where: { id, consumedAt: null }, data: { consumedAt: new Date() } });
    if (used.count === 0) throw new BadRequestException('This code was already used. Please request a new one.');
  }

  /** Account already proven for this number, else the one account whose saved phone matches. */
  private async findAccount(phone: string) {
    const verified = await this.prisma.user.findUnique({ where: { phoneVerified: phone }, include: { driverProfile: true } });
    if (verified) return verified;
    const ten = phone.slice(2);
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "User"
      WHERE "phoneVerified" IS NULL AND right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) = ${ten}`;
    if (rows.length > 1) {
      throw new ConflictException('This number is on more than one account. Please sign in with Google.');
    }
    return rows.length
      ? this.prisma.user.findUniqueOrThrow({ where: { id: rows[0].id }, include: { driverProfile: true } })
      : null;
  }
}
