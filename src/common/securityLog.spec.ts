import {
  logSecurityEvent,
  logStartup,
  logShutdown,
  logAuthFailure,
  getPrincipalFromContext,
  SecurityLogFields,
} from './securityLog';
import { apiLogger } from './logging';
import httpContext from 'express-http-context';

jest.mock('./logging', () => ({
  apiLogger: {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warning: jest.fn(),
  },
}));

jest.mock('express-http-context', () => ({
  get: jest.fn(),
}));

const mockedApiLogger = apiLogger as jest.Mocked<typeof apiLogger>;
const mockedHttpContext = httpContext as jest.Mocked<typeof httpContext>;

describe('securityLog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('logSecurityEvent', () => {
    it('should log a structured security event with all required fields', () => {
      const fields: SecurityLogFields = {
        action: 'CREATE',
        resource_type: 'pdf_collection',
        resource_id: 'abc-123',
        outcome: 'success',
        principal: { user_id: 'user1', org_id: 'org1', type: 'user' },
      };

      logSecurityEvent(fields);

      expect(mockedApiLogger.info).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(
        (mockedApiLogger.info as jest.Mock).mock.calls[0][0],
      );
      expect(logged.security_event).toBe(true);
      expect(logged.action).toBe('CREATE');
      expect(logged.resource_type).toBe('pdf_collection');
      expect(logged.resource_id).toBe('abc-123');
      expect(logged.outcome).toBe('success');
      expect(logged.principal).toEqual({
        user_id: 'user1',
        org_id: 'org1',
        type: 'user',
      });
      expect(logged.eoi_category).toBe('EOI-1');
    });

    it('should include reason when provided', () => {
      const fields: SecurityLogFields = {
        action: 'ERROR',
        resource_type: 'process',
        resource_id: 'crc-pdf-generator',
        outcome: 'failure',
        principal: { type: 'system' },
      };

      logSecurityEvent(fields, 'Unhandled error');

      const logged = JSON.parse(
        (mockedApiLogger.info as jest.Mock).mock.calls[0][0],
      );
      expect(logged.reason).toBe('Unhandled error');
      expect(logged.eoi_category).toBe('EOI-11');
    });

    it('should map AUTH_FAILURE to EOI-7', () => {
      logSecurityEvent({
        action: 'AUTH_FAILURE',
        resource_type: 'api_endpoint',
        resource_id: '/api/crc-pdf-generator/v2/create',
        outcome: 'failure',
        principal: { type: 'anonymous' },
      });

      const logged = JSON.parse(
        (mockedApiLogger.info as jest.Mock).mock.calls[0][0],
      );
      expect(logged.eoi_category).toBe('EOI-7');
    });

    it('should map STARTUP to EOI-5', () => {
      logSecurityEvent({
        action: 'STARTUP',
        resource_type: 'process',
        resource_id: 'crc-pdf-generator',
        outcome: 'success',
        principal: { type: 'system' },
      });

      const logged = JSON.parse(
        (mockedApiLogger.info as jest.Mock).mock.calls[0][0],
      );
      expect(logged.eoi_category).toBe('EOI-5');
    });

    it('should map SHUTDOWN to EOI-5', () => {
      logSecurityEvent({
        action: 'SHUTDOWN',
        resource_type: 'process',
        resource_id: 'crc-pdf-generator',
        outcome: 'success',
        principal: { type: 'system' },
      });

      const logged = JSON.parse(
        (mockedApiLogger.info as jest.Mock).mock.calls[0][0],
      );
      expect(logged.eoi_category).toBe('EOI-5');
    });
  });

  describe('logStartup', () => {
    it('should log a startup event with port', () => {
      logStartup(8000);

      const logged = JSON.parse(
        (mockedApiLogger.info as jest.Mock).mock.calls[0][0],
      );
      expect(logged.action).toBe('STARTUP');
      expect(logged.resource_type).toBe('process');
      expect(logged.outcome).toBe('success');
      expect(logged.reason).toBe('Listening on port 8000');
    });
  });

  describe('logShutdown', () => {
    it('should log a shutdown event with signal', () => {
      logShutdown('SIGTERM');

      const logged = JSON.parse(
        (mockedApiLogger.info as jest.Mock).mock.calls[0][0],
      );
      expect(logged.action).toBe('SHUTDOWN');
      expect(logged.reason).toBe('Received SIGTERM');
    });
  });

  describe('logAuthFailure', () => {
    it('should log an auth failure event', () => {
      logAuthFailure(
        'Missing identity header',
        '/api/crc-pdf-generator/v2/create',
      );

      const logged = JSON.parse(
        (mockedApiLogger.info as jest.Mock).mock.calls[0][0],
      );
      expect(logged.action).toBe('AUTH_FAILURE');
      expect(logged.resource_type).toBe('api_endpoint');
      expect(logged.resource_id).toBe('/api/crc-pdf-generator/v2/create');
      expect(logged.outcome).toBe('failure');
      expect(logged.principal).toEqual({ type: 'anonymous' });
      expect(logged.reason).toBe('Missing identity header');
    });
  });

  describe('getPrincipalFromContext', () => {
    it('should extract user principal from identity context', () => {
      (mockedHttpContext.get as jest.Mock).mockReturnValue({
        identity: {
          user: { user_id: 'u-123' },
          org_id: 'o-456',
        },
      });

      const principal = getPrincipalFromContext();
      expect(principal).toEqual({
        user_id: 'u-123',
        org_id: 'o-456',
        type: 'user',
      });
    });

    it('should extract service account principal', () => {
      (mockedHttpContext.get as jest.Mock).mockReturnValue({
        identity: {
          service_account: { username: 'sa-bot' },
          org_id: 'o-789',
        },
      });

      const principal = getPrincipalFromContext();
      expect(principal).toEqual({
        user_id: 'sa-bot',
        org_id: 'o-789',
        type: 'service_account',
      });
    });

    it('should return anonymous when no identity in context', () => {
      (mockedHttpContext.get as jest.Mock).mockReturnValue(undefined);

      const principal = getPrincipalFromContext();
      expect(principal).toEqual({ type: 'anonymous' });
    });

    it('should return anonymous when identity object has no user', () => {
      (mockedHttpContext.get as jest.Mock).mockReturnValue({
        identity: { org_id: 'o-999' },
      });

      const principal = getPrincipalFromContext();
      expect(principal).toEqual({ org_id: 'o-999', type: 'anonymous' });
    });

    it('should return anonymous on error', () => {
      (mockedHttpContext.get as jest.Mock).mockImplementation(() => {
        throw new Error('context error');
      });

      const principal = getPrincipalFromContext();
      expect(principal).toEqual({ type: 'anonymous' });
    });
  });
});
