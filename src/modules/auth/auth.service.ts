import { ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Role } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AccessPayload } from '../../common/auth.guards';
import { userOut, type UserWithDriver } from '../../common/serializers';
import { AppConfig } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { GoogleVerifier, type GoogleIdentity } from './google-verifier.service';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
    private readonly google: GoogleVerifier,
  ) {}

  async signInWithGoogle(idToken: string, userAgent?: string) {
    const identity = await this.google.verify(idToken);
    const user = await this.upsertFromGoogle(identity);
    return this.issueSession(user, randomUUID(), userAgent);
  }

  /** Development only — caller must check `devLoginEnabled`. */
  async devLogin(email: string, userAgent?: string) {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      include: { driverProfile: true },
    });
    if (!user || !user.isActive) throw new NotFoundException('Account not found.');
    return this.issueSession(user, randomUUID(), userAgent);
  }

  /**
   * Refresh token rotation. A valid token is revoked and replaced. Presenting a
   * token that was already rotated means it leaked: the whole family is revoked.
   */
  async refresh(refreshToken: string, userAgent?: string) {
    const hash = sha256(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash: hash } });
    if (!stored) throw new UnauthorizedException('Session expired. Please sign in again.');

    if (stored.revokedAt) {
      await this.prisma.refreshToken.updateMany({
        where: { familyId: stored.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException('Session expired. Please sign in again.');
    }
    if (stored.expiresAt < new Date()) throw new UnauthorizedException('Session expired. Please sign in again.');

    const user = await this.prisma.user.findUnique({ where: { id: stored.userId }, include: { driverProfile: true } });
    if (!user || !user.isActive) throw new UnauthorizedException('Session expired. Please sign in again.');

    // Conditional revoke guards against two concurrent refreshes with the same token.
    const revoked = await this.prisma.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (revoked.count === 0) throw new UnauthorizedException('Session expired. Please sign in again.');

    const session = await this.issueSession(user, stored.familyId, userAgent);
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { replacedBy: session.refreshTokenId },
    });
    return session;
  }

  /** Revokes the presented refresh token's whole family (this device). */
  async logout(refreshToken: string | undefined, userId: string) {
    if (!refreshToken) return;
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(refreshToken) } });
    if (!stored || stored.userId !== userId) return;
    await this.prisma.refreshToken.updateMany({
      where: { familyId: stored.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async upsertFromGoogle(identity: GoogleIdentity): Promise<UserWithDriver> {
    const existing = await this.prisma.user.findUnique({
      where: { email: identity.email },
      include: { driverProfile: true },
    });
    if (existing) {
      if (!existing.isActive) throw new ForbiddenException('This account has been deactivated.');
      if (existing.googleSub && existing.googleSub !== identity.sub) {
        throw new UnauthorizedException('This email is linked to a different Google account.');
      }
      return this.prisma.user.update({
        where: { id: existing.id },
        data: { googleSub: identity.sub, photoUrl: identity.photoUrl ?? existing.photoUrl },
        include: { driverProfile: true },
      });
    }
    // Public sign-up never grants elevated roles.
    const role: Role = this.config.get('BOOTSTRAP_ADMIN_EMAILS').includes(identity.email) ? 'ADMIN' : 'CUSTOMER';
    return this.prisma.user.create({
      data: {
        email: identity.email,
        name: identity.name,
        photoUrl: identity.photoUrl,
        googleSub: identity.sub,
        role,
        ...(role === 'CUSTOMER' ? { cart: { create: {} } } : {}),
      },
      include: { driverProfile: true },
    });
  }

  /** New session (fresh refresh-token family) for a user verified another way, e.g. SMS code. */
  startSession(user: UserWithDriver, userAgent?: string) {
    return this.issueSession(user, randomUUID(), userAgent);
  }

  private async issueSession(user: UserWithDriver, familyId: string, userAgent?: string) {
    const payload: AccessPayload = { sub: user.id, role: user.role };
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.get('JWT_ACCESS_SECRET'),
      expiresIn: this.config.get('JWT_ACCESS_TTL') as never,
    });
    const refreshToken = randomBytes(48).toString('base64url');
    const ttlDays = this.config.get('JWT_REFRESH_TTL_DAYS');
    const record = await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(refreshToken),
        familyId,
        expiresAt: new Date(Date.now() + ttlDays * 86_400_000),
        userAgent: userAgent?.slice(0, 200),
      },
    });
    const decoded = this.jwt.decode(accessToken) as { exp: number; iat: number };
    return {
      accessToken,
      token: accessToken,
      refreshToken,
      expiresIn: decoded.exp - decoded.iat,
      user: userOut(user),
      refreshTokenId: record.id,
    };
  }
}
