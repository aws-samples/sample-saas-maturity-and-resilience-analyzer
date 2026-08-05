import { Logger } from '@nestjs/common';

/**
 * Sanitizes error messages for client responses.
 * Logs the full error server-side but returns a generic message to the client
 * to prevent leaking internal infrastructure details (account IDs, ARNs, etc.).
 */
export function sanitizeErrorForClient(
  error: any,
  operation: string,
  logger: Logger,
): string {
  // Log full error server-side for debugging
  logger.error(`${operation} failed:`, error?.message || error);

  // Return generic message to client — never expose AWS SDK error details
  return `${operation} failed. Please try again or contact support if the issue persists.`;
}
