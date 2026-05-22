// Core exports for Express integration
export { ExpressMcp, AuthManager } from './classes/index.js';

// Base tool interface for creating custom tools
export { BaseTool } from './classes/index.js';

// Auth helpers for host apps
export {
  buildAuthOptionsFromEnv,
  parseAllowedUsersFromEnv,
  getOAuthClientId,
  getOAuthClientSecret,
  isOAuthConfigured
} from './oauthEnv.js';

export { normalizeAuthProviders, authServerInfo } from './authConfig.js';
export { SUPPORTED_OAUTH_PROVIDERS } from './classes/authManager.js';
