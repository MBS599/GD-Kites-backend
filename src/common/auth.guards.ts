import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Role } from '@prisma/client';
import { AppConfig } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser, canDrive, IS_PUBLIC, ROLES } from './auth.decorators';

export interface AccessPayload {
  sub: string;
  role: Role;
}

/** Verifies an access token and loads the user fresh from the DB. */
@Injectable()
export class AccessTokenVerifier {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  async verify(token: string | undefined): Promise<AuthUser | null> {
    if (!token) return null;
    let payload: AccessPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessPayload>(token, { secret: this.config.get('JWT_ACCESS_SECRET') });
    } catch {
      return null;
    }
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub }, include: { driverProfile: true } });
    // Role changes and deactivation take effect immediately, not at token expiry.
    if (!user || !user.isActive) return null;
    return user;
  }
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: AccessTokenVerifier,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;
    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const user = await this.verifier.verify(token);
    if (!user) throw new UnauthorizedException('Please sign in to continue.');
    req.user = user;
    return true;
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, [ctx.getHandler(), ctx.getClass()]);
    if (!roles || roles.length === 0) return true;
    const user: AuthUser | undefined = ctx.switchToHttp().getRequest().user;
    // Driver routes are also open to admins who deliver themselves.
    const allowed = !!user && (roles.includes(user.role) || (roles.includes('DRIVER') && canDrive(user)));
    if (!allowed) {
      throw new ForbiddenException('You do not have access to this resource.');
    }
    return true;
  }
}
