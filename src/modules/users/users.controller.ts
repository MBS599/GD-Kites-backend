import { Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { IsIn } from 'class-validator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PHONE_TAKEN, phoneInUse } from '../../common/phone-unique';
import type { OrderStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateIf, IsBoolean } from 'class-validator';
import { CurrentUser, type AuthUser } from '../../common/auth.decorators';
import { userOut } from '../../common/serializers';
import { PHONE_MSG, PHONE_RE } from '../../common/validation';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizeIndianMobile } from '../sms/sms.service';

export class UpdateProfileDto {
  /** Customers who signed up with a mobile number add their email (Google accounts keep Google's). */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsEmail({}, { message: 'Enter a valid email address.' })
  @MaxLength(120)
  email?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @IsOptional()
  @Matches(PHONE_RE, { message: PHONE_MSG })
  phone?: string;

  /** Order / delivery updates by SMS. */
  @IsOptional()
  @IsBoolean()
  smsEnabled?: boolean;

  /** Customers only; null clears it. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MinLength(2)
  businessName?: string | null;
}

export class ReviewPromptDto {
  /** shown: the sheet was shown; rated: tapped "Rate us" / "Already rated" (never again); later: closed it. */
  @IsIn(['shown', 'rated', 'later']) action: 'shown' | 'rated' | 'later';
}

/** In-app review sheet: shown again only after a delivery this long after the last time. */
const REVIEW_REMIND_DAYS = 15;
/** Shown at most this many times in all (the first time + 3 reminders). */
const REVIEW_MAX_PROMPTS = 4;

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return { user: userOut(user) };
  }

  @Patch('me')
  async update(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    // A verified number is a sign-in method: changing the phone un-verifies it,
    // and accounts that can *only* sign in by SMS can't drop their number here.
    const changed = dto.phone !== undefined && normalizeIndianMobile(dto.phone) !== user.phoneVerified;
    if (changed && user.phoneVerified && !user.googleSub) {
      throw new ConflictException('Your mobile number is how you sign in. Contact GD Kite Center to change it.');
    }
    // One account per mobile number (verified or just saved).
    if (dto.phone !== undefined && (await phoneInUse(this.prisma, dto.phone, user.id))) {
      throw new ConflictException(PHONE_TAKEN);
    }
    let email: string | undefined;
    if (dto.email !== undefined) {
      if (user.role !== 'CUSTOMER') throw new ForbiddenException('Staff emails are managed by an admin.');
      // Only an email the customer typed in can be set or changed; a Google account's email is its sign-in.
      if (user.googleSub || (user.email && !user.emailUnverified)) {
        throw new ConflictException('Your email comes from your Google account.');
      }
      email = dto.email.trim().toLowerCase();
      const taken = await this.prisma.user.findFirst({ where: { email, id: { not: user.id } }, select: { id: true } });
      if (taken) throw new ConflictException('This email is already used by another account.');
    }
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        ...(email !== undefined ? { email, emailUnverified: true } : {}),
        name: dto.name?.trim(),
        phone: dto.phone?.trim(),
        phoneVerified: changed ? null : undefined,
        businessName: user.role === 'CUSTOMER' ? dto.businessName?.trim() : undefined,
        smsEnabled: dto.smsEnabled,
      },
      include: { driverProfile: true },
    });
    return { user: userOut(updated) };
  }

  /**
   * Should the app show the "Rate us on Google" sheet now? Every customer once; if they did not
   * rate, again after a later delivered order (or shop bill), at most every 15 days and 4 times
   * in all. Never after they tap Rate / Already rated, and never while no review link is set.
   */
  @Get('me/review-prompt')
  async reviewPrompt(@CurrentUser() user: AuthUser) {
    const s = await this.prisma.appSettings.findUnique({ where: { id: 1 }, select: { googleReviewUrl: true } });
    const url = s?.googleReviewUrl?.trim() || null;
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    let show = !!url && u.role === 'CUSTOMER' && !u.reviewedAt && u.reviewPrompts < REVIEW_MAX_PROMPTS;
    if (show && u.reviewPrompts > 0) {
      const last = u.reviewPromptedAt ?? new Date(0);
      const due = Date.now() - last.getTime() >= REVIEW_REMIND_DAYS * 86_400_000;
      const deliveredSince = due
        ? await this.prisma.order.count({ where: { customerId: u.id, status: 'DELIVERED', deliveredAt: { gt: last } } })
        : 0;
      show = due && deliveredSince > 0;
    }
    return { show, url };
  }

  @Post('me/review-prompt')
  @HttpCode(200)
  async reviewPromptDone(@CurrentUser() user: AuthUser, @Body() dto: ReviewPromptDto) {
    await this.prisma.user.update({
      where: { id: user.id },
      data:
        dto.action === 'shown'
          ? { reviewPrompts: { increment: 1 }, reviewPromptedAt: new Date() }
          : dto.action === 'rated'
            ? { reviewedAt: new Date() }
            : { reviewPromptedAt: new Date() },
    });
    return { ok: true };
  }

  /** The user opened their notifications: everything so far is read. */
  @Post('me/notifications-seen')
  @HttpCode(200)
  async notificationsSeen(@CurrentUser() user: AuthUser) {
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { notificationsSeenAt: new Date() },
      include: { driverProfile: true },
    });
    return { user: userOut(updated) };
  }

  /**
   * Deletes the signed-in customer's account (Play Store / App Store requirement).
   * Personal data is erased; placed orders stay — anonymised — for tax and accounting
   * records. Drivers and admins are removed by an admin instead.
   */
  @Delete('me')
  @HttpCode(204)
  async deleteMe(@CurrentUser() user: AuthUser) {
    if (user.role !== 'CUSTOMER') {
      throw new ForbiddenException('Driver and admin accounts are closed by GD Kite Center. Please contact support.');
    }
    const open = await this.prisma.order.count({ where: { customerId: user.id, status: { in: OPEN_ORDER_STATUSES } } });
    if (open > 0) {
      throw new ConflictException('You have orders in progress. Delete your account after they are delivered or cancelled.');
    }
    // Message log: everything sent for this account, plus anything to its own numbers.
    const numbers = [user.phone, user.phoneVerified, normalizeIndianMobile(user.phone)].filter((n): n is string => !!n);
    await this.prisma.$transaction([
      this.prisma.smsMessage.deleteMany({ where: { OR: [{ userId: user.id }, { to: { in: numbers } }] } }),
      this.prisma.address.deleteMany({ where: { userId: user.id } }),
      this.prisma.cart.deleteMany({ where: { userId: user.id } }),
      this.prisma.deviceToken.deleteMany({ where: { userId: user.id } }),
      this.prisma.refreshToken.deleteMany({ where: { userId: user.id } }),
      this.prisma.problemReport.deleteMany({ where: { userId: user.id } }),
      this.prisma.errorLog.deleteMany({ where: { userId: user.id } }),
      ...(user.phoneVerified ? [this.prisma.otpChallenge.deleteMany({ where: { phone: user.phoneVerified } })] : []),
      this.prisma.user.update({
        where: { id: user.id },
        data: {
          name: 'Deleted user',
          email: null,
          phone: null,
          phoneVerified: null,
          businessName: null,
          photoUrl: null,
          googleSub: null,
          smsEnabled: false,
          isActive: false,
        },
      }),
    ]);
  }
}

/** Orders that still need the customer: deleting the account would strand them. */
const OPEN_ORDER_STATUSES: OrderStatus[] = ['AWAITING_PAYMENT', 'PENDING', 'CONFIRMED', 'ASSIGNED', 'OUT_FOR_DELIVERY'];
