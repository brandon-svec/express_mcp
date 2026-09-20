import { BaseTool } from '../classes/baseTool.js';

/**
 * MCP tool for inspecting and revoking long-lived Google IdP grants (extra scopes).
 * Registered only when googleExtraScopes is configured. Owner is always context.user.sub.
 */
export class GoogleGrantTool extends BaseTool {
  /**
   * @param {import('../classes/authManager.js').AuthManager} authManager
   */
  constructor(authManager) {
    super(
      'google_grant',
      'Google IdP grant management for extra scopes (Contacts, Calendar, and other allowlisted scopes): status reports whether a grant is stored; revoke revokes the refresh token at Google and deletes the local grant. Owner is the signed-in user only.',
      {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'revoke'],
            description:
              'status: whether extra Google scopes are granted. revoke: revoke at Google and delete the stored grant.'
          }
        },
        required: ['action'],
        additionalProperties: false
      }
    );
    this._authManager = authManager;
  }

  /**
   * @param {{ action: string }} args
   * @param {{ user?: { sub?: string } }} context
   * @returns {Promise<object>}
   */
  async execute(args, context) {
    const sub = context?.user?.sub;
    if (typeof sub !== 'string' || !sub) {
      throw new Error('Authenticated user.sub is required');
    }

    if (args.action === 'status') {
      return this._authManager.getGoogleIdpGrantStatus(sub);
    }

    if (args.action === 'revoke') {
      const revoked = await this._authManager.revokeGoogleIdpGrant(sub);
      if (revoked) {
        return { revoked: true };
      }
      return { revoked: false, reason: 'no_grant' };
    }

    throw new Error(`Unknown action: ${args.action}`);
  }
}
