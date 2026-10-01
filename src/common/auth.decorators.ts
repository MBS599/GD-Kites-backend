import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { DriverProfile, Role, User } from '@prisma/client';

export type AuthUser = User & { driverProfile: DriverProfile | null };

export const IS_PUBLIC = 'isPublic';
export const ROLES = 'roles';

/** Route does not require an access token. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Restrict a route or controller to the given roles. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});
