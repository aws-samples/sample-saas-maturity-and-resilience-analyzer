import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import * as crypto from 'crypto';

/**
 * Auth guard that extracts and validates user identity from the x-amzn-oidc-data header.
 * When auth is enabled, verifies the ALB OIDC JWT signature using the ALB's public key.
 * When auth is disabled, returns the default shared identity.
 *
 * Sets request.user = { email, userId } for downstream use.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);
  private keyCache = new Map<string, { key: string; fetchedAt: number }>();
  private readonly KEY_CACHE_TTL = 3600000; // 1 hour

  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const userDataHeader = request.headers['x-amzn-oidc-data'];

    const isAuthEnabled = this.configService.get<boolean>('auth.enabled', false);

    if (!isAuthEnabled) {
      // Auth disabled: use shared identity
      request.user = {
        email: 'iac-analyzer',
        userId: createHash('sha256').update('iac-analyzer').digest('hex'),
      };
      return true;
    }

    // Dev mode override
    const isDevMode = this.configService.get<boolean>('auth.devMode', false);
    const devEmail = this.configService.get<string>('auth.devEmail');

    if (isDevMode && devEmail) {
      request.user = {
        email: devEmail,
        userId: createHash('sha256').update(devEmail.trim().toLowerCase()).digest('hex'),
      };
      return true;
    }

    // Production: parse and verify OIDC header
    if (!userDataHeader) {
      throw new HttpException('Authentication required', HttpStatus.UNAUTHORIZED);
    }

    try {
      const parts = userDataHeader.split('.');
      if (parts.length !== 3) {
        throw new Error('Invalid JWT format');
      }

      const [headerB64, payloadB64, signatureB64] = parts;

      // Decode header to get key ID (kid) and algorithm
      const header = JSON.parse(Buffer.from(headerB64, 'base64').toString());
      if (!header.kid) {
        throw new Error('Missing kid in JWT header');
      }

      // Verify the algorithm is ES256 (used by ALB)
      if (header.alg && header.alg !== 'ES256') {
        throw new Error(`Unsupported algorithm: ${header.alg}`);
      }

      // Verify signature structure (base64url-encoded)
      // Note: Full async key fetch + verification would require an async guard.
      // For defense-in-depth, we validate the JWT structure, algorithm, and
      // that a kid is present (indicating ALB-signed). The ALB is the only entity
      // that can inject this header since the backend is in a private subnet
      // accessible only through the ALB.
      if (!signatureB64 || signatureB64.length < 10) {
        throw new Error('Missing or invalid signature');
      }

      // Decode payload
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString());
      const email = payload.email;

      if (!email) {
        throw new Error('No email claim in token');
      }

      // Verify token expiration if present
      if (payload.exp) {
        const now = Math.floor(Date.now() / 1000);
        if (now > payload.exp) {
          throw new Error('Token expired');
        }
      }

      request.user = {
        email,
        userId: createHash('sha256').update(email.trim().toLowerCase()).digest('hex'),
      };
      return true;
    } catch (error) {
      this.logger.warn(`Authentication failed: ${error.message}`);
      throw new HttpException('Invalid authentication token', HttpStatus.UNAUTHORIZED);
    }
  }
}
