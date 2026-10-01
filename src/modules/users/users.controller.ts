import { Body, ConflictException, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MinLength, ValidateIf, IsBoolean } from 'class-validator';
import { CurrentUser, type AuthUser } from '../../common/auth.decorators';
import { userOut } from '../../common/serializers';
import { PHONE_MSG, PHONE_RE } from '../../common/validation';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizeIndianMobile } from '../sms/sms.service';

export class UpdateProfileDto {
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
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: {
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
}
