import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentUser, Roles, type AuthUser } from '../../common/auth.decorators';
import { AppConfig } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';

export class AddAdminDto {
  @IsString() @MinLength(2) @MaxLength(80) name: string;
  /** Google account email the new admin signs in with. */
  @IsEmail() email: string;
}

/**
 * Who can run the shop. Admins are added by their Google email and sign in with Google;
 * the first admins come from BOOTSTRAP_ADMIN_EMAILS on the server.
 */
@ApiTags('Admin')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('admin/team')
export class TeamController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  @Get()
  async list() {
    const admins = await this.prisma.user.findMany({
      where: { role: 'ADMIN', isActive: true },
      orderBy: { createdAt: 'asc' },
    });
    const bootstrap = this.config.get('BOOTSTRAP_ADMIN_EMAILS');
    return {
      admins: admins.map((a) => ({
        id: a.id,
        name: a.name,
        email: a.email,
        photoUrl: a.photoUrl,
        /** Has signed in at least once. */
        joined: a.googleSub !== null,
        /** Set in the server config: can't be removed from the app. */
        owner: !!a.email && bootstrap.includes(a.email.toLowerCase()),
      })),
    };
  }

  @Post()
  async add(@Body() dto: AddAdminDto) {
    const email = dto.email.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing?.role === 'ADMIN' && existing.isActive) throw new ConflictException('This person is already an admin.');
    if (existing?.role === 'DRIVER') throw new ConflictException('This email belongs to a driver account.');
    if (existing) {
      // A customer who never ordered (e.g. tried the app first) can become an admin.
      const orders = await this.prisma.order.count({ where: { customerId: existing.id } });
      if (orders > 0) throw new ConflictException('This email belongs to a customer with orders. Use another email for admin work.');
      await this.prisma.$transaction([
        this.prisma.cart.deleteMany({ where: { userId: existing.id } }),
        this.prisma.user.update({ where: { id: existing.id }, data: { role: 'ADMIN', isActive: true } }),
        this.prisma.refreshToken.updateMany({ where: { userId: existing.id, revokedAt: null }, data: { revokedAt: new Date() } }),
      ]);
    } else {
      await this.prisma.user.create({ data: { email, name: dto.name.trim(), role: 'ADMIN' } });
    }
    return this.list();
  }

  /** Removes admin access. The account is closed and signed out everywhere. */
  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    if (id === me.id) throw new BadRequestException('You can\'t remove yourself.');
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target || target.role !== 'ADMIN' || !target.isActive) throw new NotFoundException('Admin not found.');
    if (target.email && this.config.get('BOOTSTRAP_ADMIN_EMAILS').includes(target.email.toLowerCase())) {
      throw new ConflictException('This owner account is set on the server and can\'t be removed here.');
    }
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id }, data: { isActive: false } }),
      this.prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
  }
}
