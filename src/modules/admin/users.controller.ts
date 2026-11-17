import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Prisma } from '@prisma/client';
import { Roles } from '../../common/auth.decorators';
import { PrismaService } from '../../prisma/prisma.service';

export class UserListQuery {
  /** Name, shop name, mobile or email. */
  @IsOptional() @IsString() @MaxLength(60) q?: string;
  @IsOptional() @IsIn(['all', 'active', 'inactive']) status?: 'all' | 'active' | 'inactive';
}

export class SetUserActiveDto {
  @IsBoolean() isActive: boolean;
}

const userSelect = {
  id: true,
  name: true,
  businessName: true,
  email: true,
  phone: true,
  phoneVerified: true,
  googleSub: true,
  isActive: true,
  createdAt: true,
  _count: { select: { orders: true } },
} as const;
type UserRow = Prisma.UserGetPayload<{ select: typeof userSelect }>;

const userOut = (u: UserRow) => ({
  id: u.id,
  name: u.name,
  businessName: u.businessName,
  email: u.email,
  phone: u.phone ?? (u.phoneVerified ? `+${u.phoneVerified}` : null),
  /** How this account signs in: one person can have a Google and a mobile account. */
  signIn: [...(u.googleSub ? ['google'] : []), ...(u.phoneVerified ? ['mobile'] : [])],
  isActive: u.isActive,
  orders: u._count.orders,
  createdAt: u.createdAt.toISOString(),
});

/** Accounts erased by "Delete my account": nothing left to show or switch back on. */
const notDeleted: Prisma.UserWhereInput = {
  OR: [{ isActive: true }, { email: { not: null } }, { phone: { not: null } }, { phoneVerified: { not: null } }, { googleSub: { not: null } }],
};

/**
 * Admin: customer accounts. A deactivated customer can't sign in, is signed out
 * everywhere and no longer appears when picking customers for an offer. Drivers and
 * admins are managed from their own screens.
 */
@ApiTags('Admin')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('admin/users')
export class UsersAdminController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@Query() q: UserListQuery) {
    const text = q.q?.trim();
    const like = (v: string) => ({ contains: v, mode: 'insensitive' as const });
    const digits = text?.replace(/\D/g, '') ?? '';
    const base: Prisma.UserWhereInput = { role: 'CUSTOMER', ...notDeleted };
    const where: Prisma.UserWhereInput = {
      AND: [
        base,
        q.status === 'active' ? { isActive: true } : q.status === 'inactive' ? { isActive: false } : {},
        text
          ? {
              OR: [
                { name: like(text) },
                { businessName: like(text) },
                { email: like(text) },
                ...(digits.length >= 3 ? [{ phone: { contains: digits } }, { phoneVerified: { contains: digits } }] : []),
              ],
            }
          : {},
      ],
    };
    const [rows, active, inactive] = await Promise.all([
      this.prisma.user.findMany({ where, select: userSelect, orderBy: { createdAt: 'desc' }, take: 300 }),
      this.prisma.user.count({ where: { AND: [base, { isActive: true }] } }),
      this.prisma.user.count({ where: { AND: [base, { isActive: false }] } }),
    ]);
    return { users: rows.map(userOut), counts: { active, inactive } };
  }

  @Patch(':id')
  async setActive(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetUserActiveDto) {
    const user = await this.prisma.user.findFirst({ where: { AND: [{ id, role: 'CUSTOMER' }, notDeleted] }, select: { id: true } });
    if (!user) throw new NotFoundException('Customer not found.');
    const [updated] = await this.prisma.$transaction([
      this.prisma.user.update({ where: { id }, data: { isActive: dto.isActive }, select: userSelect }),
      // Deactivated: signed out on every device now (each request also checks isActive).
      ...(dto.isActive
        ? []
        : [this.prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } })]),
    ]);
    return { user: userOut(updated) };
  }
}
