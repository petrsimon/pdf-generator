import httpContext from 'express-http-context';
import config from './config';
import { apiLogger } from './logging';

/**
 * SEC-MON-REQ-1 security logging for CRC PDF Generator.
 *
 * Required fields per security logging guidelines:
 *   action, resource_type, resource_id, outcome, principal
 *
 * Applicable EOI categories:
 *   EOI-1  Customer data CRUD (PDF create, download)
 *   EOI-5  Process lifecycle (startup, shutdown)
 *   EOI-7  Authentication failures (missing/invalid identity)
 *   EOI-11 System errors (unhandled errors, generation failures)
 *
 * Not applicable:
 *   EOI-3  No admin CRUD operations
 *   EOI-4  No RBAC model (authz handled upstream)
 *   EOI-6  Authentication handled upstream by platform gateway
 *   EOI-9  No sensitive data import/export
 *   EOI-10 No direct sensitive data access
 */

export type SecurityAction =
  | 'CREATE'
  | 'READ'
  | 'DELETE'
  | 'STARTUP'
  | 'SHUTDOWN'
  | 'AUTH_FAILURE'
  | 'ERROR';

export type SecurityOutcome = 'success' | 'failure';

export interface SecurityLogFields {
  action: SecurityAction;
  resource_type: string;
  resource_id: string;
  outcome: SecurityOutcome;
  principal: SecurityPrincipal;
}

export interface SecurityPrincipal {
  user_id?: string;
  org_id?: string;
  type: 'user' | 'service_account' | 'system' | 'anonymous';
}

interface SecurityLogEntry extends SecurityLogFields {
  security_event: true;
  eoi_category: string;
  reason?: string;
}

/**
 * Extract principal from current express-http-context.
 * Identity is decoded by identity-middleware and stored in context.
 */
export function getPrincipalFromContext(): SecurityPrincipal {
  try {
    const identityObject = httpContext.get(config.IDENTITY_CONTEXT_KEY);
    if (!identityObject) {
      return { type: 'anonymous' };
    }

    const identity = identityObject?.identity;
    const userId = identity?.user?.user_id;
    const orgId = identity?.org_id;
    const serviceAccount = identity?.service_account?.username;

    if (serviceAccount) {
      return {
        user_id: serviceAccount,
        org_id: orgId,
        type: 'service_account',
      };
    }

    if (userId) {
      return {
        user_id: userId,
        org_id: orgId,
        type: 'user',
      };
    }

    return { org_id: orgId, type: 'anonymous' };
  } catch {
    return { type: 'anonymous' };
  }
}

function getEoiCategory(action: SecurityAction): string {
  switch (action) {
    case 'CREATE':
    case 'READ':
    case 'DELETE':
      return 'EOI-1';
    case 'STARTUP':
    case 'SHUTDOWN':
      return 'EOI-5';
    case 'AUTH_FAILURE':
      return 'EOI-7';
    case 'ERROR':
      return 'EOI-11';
    default:
      return 'EOI-1';
  }
}

/**
 * Emit a structured security log entry with all required SEC-MON-REQ-1 fields.
 */
export function logSecurityEvent(
  fields: SecurityLogFields,
  reason?: string,
): void {
  const entry: SecurityLogEntry = {
    security_event: true,
    eoi_category: getEoiCategory(fields.action),
    ...fields,
  };
  if (reason) {
    entry.reason = reason;
  }
  apiLogger.info(JSON.stringify(entry));
}

/**
 * Log process startup (EOI-5).
 */
export function logStartup(port: number): void {
  logSecurityEvent(
    {
      action: 'STARTUP',
      resource_type: 'process',
      resource_id: 'crc-pdf-generator',
      outcome: 'success',
      principal: { type: 'system' },
    },
    `Listening on port ${port}`,
  );
}

/**
 * Log process shutdown (EOI-5).
 */
export function logShutdown(signal: string): void {
  logSecurityEvent(
    {
      action: 'SHUTDOWN',
      resource_type: 'process',
      resource_id: 'crc-pdf-generator',
      outcome: 'success',
      principal: { type: 'system' },
    },
    `Received ${signal}`,
  );
}

/**
 * Log authentication failure (EOI-7).
 */
export function logAuthFailure(reason: string, resourcePath: string): void {
  logSecurityEvent(
    {
      action: 'AUTH_FAILURE',
      resource_type: 'api_endpoint',
      resource_id: resourcePath,
      outcome: 'failure',
      principal: { type: 'anonymous' },
    },
    reason,
  );
}
