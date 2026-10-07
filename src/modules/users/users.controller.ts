import { Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, Patch, Post } from '@nestjs/common';
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
