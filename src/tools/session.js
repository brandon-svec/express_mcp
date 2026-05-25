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
      const hostContext = context?.hostContext;
      if (hostContext && typeof hostContext === 'object' && !Array.isArray(hostContext)) {
        const standaloneDeactivated = await this._authManager.deactivateVerifiedSessionByContext(hostContext);
        if (typeof hostContext.telegram_chat_id === 'string' && hostContext.telegram_chat_id) {
          return {
            standaloneDeactivated,
            message: standaloneDeactivated
              ? 'Telegram sign-in cleared. Send another message to receive a new sign-in link.'
              : 'No active Telegram sign-in session was found.',
          };
        }
      }

      const jti = context?.user?.jti;
      if (!jti) {
        return {
          revoked: false,
          error: 'No jti in current session token; cannot deactivate.',
        };
      }

      const revoked = await this._authManager.deactivateVerifiedSessionByJti(jti);
      return {
        revoked,
        message: revoked
          ? 'Session cleared. Reconnect your MCP server in Cursor to re-authenticate.'
          : 'No active session found for this token.',
      };
    }

    throw new Error(`Unknown action: ${args.action}`);
  }
}
