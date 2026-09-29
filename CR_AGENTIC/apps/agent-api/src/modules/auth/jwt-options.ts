import { ConfigService } from '@nestjs/config';
import type { JwtModuleOptions, JwtSignOptions } from '@nestjs/jwt';

const DEFAULT_JWT_SECRET = 'your-super-secret-key-change-in-production';
const DEFAULT_ISSUER = 'course-rep';
const DEFAULT_AUDIENCE = 'course-rep-users';

export function parseExpiresToSeconds(input: string | undefined): number {
  if (!input) return 3600;
  const s = input.trim().toLowerCase();
  const m = s.match(/^\s*(\d+)\s*([smhd])?\s*$/);
  if (m) {
    const val = parseInt(m[1], 10);
    const unit = m[2] || 's';
    const mult: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
    return val * (mult[unit] || 1);
  }
  const num = Number(s);
  return Number.isFinite(num) ? num : 3600;
}

export function jwtSecret(config: ConfigService): string {
  return config.get<string>('JWT_SECRET') || DEFAULT_JWT_SECRET;
}

export function jwtIssuer(config: ConfigService): string {
  return config.get<string>('JWT_ISSUER', DEFAULT_ISSUER);
}

export function jwtAudience(config: ConfigService): string {
  return config.get<string>('JWT_AUDIENCE', DEFAULT_AUDIENCE);
}

export function jwtExpiresInSeconds(config: ConfigService): number {
  return parseExpiresToSeconds(config.get<string>('JWT_EXPIRES_IN', '90d'));
}

export function getAgentJwtConfig(config: ConfigService): JwtModuleOptions {
  const expiresIn = jwtExpiresInSeconds(config);
  const issuer = jwtIssuer(config);
  const audience = jwtAudience(config);
  return {
    secret: jwtSecret(config),
    signOptions: { expiresIn, issuer, audience },
    verifyOptions: { issuer, audience },
  };
}

export function claimJwtSignOptions(config: ConfigService): JwtSignOptions {
  return {
    expiresIn: jwtExpiresInSeconds(config),
    issuer: jwtIssuer(config),
    audience: jwtAudience(config),
  };
}
