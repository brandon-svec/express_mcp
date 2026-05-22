import { BaseTool } from '../classes/baseTool.js';

/**
 * Returns the authenticated MCP user from request context.
 */
export class WhoAmITool extends BaseTool {
  constructor() {
    super(
      'whoami',
      'Returns the authenticated user identity (sub, login, name, email, provider)'
    );
  }

  async execute(_args, context) {
    const user = context?.user;
    if (!user) {
      return { authenticated: false };
    }
    return {
      authenticated: true,
      sub: user.sub,
      login: user.login,
      name: user.name,
      email: user.email,
      provider: user.provider
    };
  }
}
