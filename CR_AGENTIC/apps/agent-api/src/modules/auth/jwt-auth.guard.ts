import { Injectable, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './public.decorator';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const guestToken =
      request.headers?.['x-onboarding-guest-token'] ||
      request.headers?.['X-Onboarding-Guest-Token'];
    if (typeof guestToken === 'string' && guestToken.length > 0) {
      // Bypass passport; handler verifies the guest token against Postgres
      // session metadata (not Redis).
      return true;
    }

    return super.canActivate(context);
  }

  handleRequest<TUser>(err: Error | null, user: TUser, info?: Error | string): TUser {
    if (err) throw err;
    if (user) return user;

    const detail = info instanceof Error ? info.message : info;
    if (detail && /expired/i.test(detail)) {
      throw new UnauthorizedException(
        'Access token expired. Retry claim-identity or send a valid X-Onboarding-Guest-Token.',
      );
    }
    throw new UnauthorizedException(
      'A valid Course Rep JWT or X-Onboarding-Guest-Token is required for this onboarding session.',
    );
  }
}
