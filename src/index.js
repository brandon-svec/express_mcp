// Core exports for Express integration
export { ExpressMcp, AuthManager } from './classes/index.js';

// Base tool interface for creating custom tools
export { BaseTool } from './classes/index.js';

// Auth helpers for host apps
export { buildAuthOptions } from './buildAuthOptions.js';

export {
  buildAuthOptionsFromEnv,
  parseAllowedUsersFromEnv,
  getOAuthClientId,
  getOAuthClientSecret,
  isOAuthConfigured
} from './oauthEnv.js';

export {
  normalizeAuthProviders,
  authServerInfo,
  validateAuthOptions
} from './authConfig.js';
export { SUPPORTED_OAUTH_PROVIDERS } from './classes/authManager.js';

export {
  Agent,
  ModelAdapter,
  GeminiAdapter,
  InMemoryHistoryStore
} from './agents/index.js';
