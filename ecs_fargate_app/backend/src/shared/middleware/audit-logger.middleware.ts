import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

/**
 * Audit logging middleware that records authenticated API requests.
 * Logs: timestamp, userId (hashed), method, path, status code.
 * Does NOT log PII (email) or request bodies.
 */
@Injectable()
export class AuditLoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger('AuditLog');

  use(req: Request, res: Response, next: NextFunction): void {
    const startTime = Date.now();

    // Log after response is sent
    res.on('finish', () => {
      const duration = Date.now() - startTime;
      const userId = (req as any).user?.userId || 'anonymous';
      const method = req.method;
      const path = req.originalUrl || req.url;
      const statusCode = res.statusCode;

      // Structured audit log entry — no PII, only hashed userId
      this.logger.log(
        JSON.stringify({
          event: 'api_request',
          timestamp: new Date().toISOString(),
          userId,
          method,
          path,
          statusCode,
          durationMs: duration,
        }),
      );
    });

    next();
  }
}
