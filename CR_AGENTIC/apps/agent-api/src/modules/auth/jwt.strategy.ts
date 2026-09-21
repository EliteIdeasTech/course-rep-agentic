import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { jwtAudience, jwtIssuer, jwtSecret } from './jwt-options';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: jwtSecret(config),
      issuer: jwtIssuer(config),
      audience: jwtAudience(config),
    });
  }

  validate(payload: { sub?: string; id?: string }) {
    const userId = payload.sub ?? payload.id;
    if (!userId) throw new UnauthorizedException('Access token is missing a user id');
    return { id: userId };
  }
}
