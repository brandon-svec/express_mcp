import { BaseTool } from '../classes/baseTool.js';

/**
 * @param {number} unixSeconds
 * @returns {string}
 */
function jwtTimestampToIso(unixSeconds) {
  if (typeof unixSeconds !== 'number' || !Number.isFinite(unixSeconds)) {
    throw new Error(`Invalid JWT timestamp: ${unixSeconds}`);
  }
  return new Date(unixSeconds * 1000).toISOString();
}

/**
 * Session management tool when auth is enabled.
 */
export class SessionTool extends BaseTool {
  /**
   * @param {import('../classes/authManager.js').AuthManager} authManager
   */
  constructor(authManager) {
    super(
      'session',
      'Session management: who_am_i returns the current authenticated user with token issuedAt and expiresAt; reset_session invalidates this token and forces re-authentication.',
      {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['who_am_i', 'reset_session'],
            description: 'who_am_i: return current user identity. reset_session: revoke this session token.'
          }
        },
        required: ['action'],
        additionalProperties: false
      }
    );
    this._authManager = authManager;
  }

  async execute(args, context) {
    if (args.action === 'who_am_i') {
      const user = context?.user;
      if (!user) {
        return { authenticated: false };
      }
      if (typeof user.iat !== 'number') {
        throw new Error('JWT payload missing iat claim');
      }
      if (typeof user.exp !== 'number') {
        throw new Error('JWT payload missing exp claim');
      }
      return {
        authenticated: true,
        sub: user.sub,
        login: user.login,
        name: user.name,
        email: user.email,
        provider: user.provider,
        issuedAt: jwtTimestampToIso(user.iat),
        expiresAt: jwtTimestampToIso(user.exp)
      };
    }

    if (args.action === 'reset_session') {
      const jti = context?.user?.jti;
      if (!jti) {
        throw new Error('No jti in current session token; cannot revoke.');
      }
      this._authManager.revokeToken(jti);
      return {
        revoked: true,
        message: 'Session token invalidated. Reconnect your MCP server in Cursor to re-authenticate.'
      };
    }

    throw new Error(`Unknown action: ${args.action}`);
  }
}
