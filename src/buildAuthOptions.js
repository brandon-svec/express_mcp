import { validateAuthOptions } from './authConfig.js';

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Auth enabled but ${label} is missing or empty.`);
  }
  return value.trim();
}

/**
 * Build normalized ExpressMcp auth options from host config.
 *
 * When `enabled` is false, returns `{ enabled: false }` without validating other fields.
 * When `enabled` is true, derives `issuer` from `baseUrl` + `resourcePath` (unless `issuer`
 * is set), validates all required fields, and returns a canonical auth object.
 *
 * @param {Object} [input] - Host auth configuration
 * @param {boolean} [input.enabled] - Enable OAuth SSO and Bearer JWT on MCP routes
 * @param {string} [input.baseUrl] - Public origin (no trailing slash); required when issuer omitted
 * @param {string} [input.callbackUrl] - OAuth redirect URI (must match provider app registration)
 * @param {string} [input.jwtSecret] - Secret for signing MCP session JWTs
 * @param {string} [input.sessionSecret] - express-session secret for OAuth handshake
 * @param {string} [input.jwtExpiresIn] - JWT lifetime (e.g. `7d`, `1h`)
 * @param {string[]} [input.allowedUsers] - Optional email/login allowlist; omit or `[]` for open
 * @param {Object} [input.providers] - `{ github|google: { clientId, clientSecret } }`
 * @param {string} [input.provider] - Single-provider shorthand name
 * @param {string} [input.clientId] - Single-provider client ID
 * @param {string} [input.clientSecret] - Single-provider client secret
 * @param {string} [input.issuer] - Override derived issuer (normally `{baseUrl}{resourcePath}`)
 * @param {string} [input.resourcePath] - MCP mount path (default `/mcp`)
 * @param {string} [input.mcpPath] - Alias for resourcePath
 * @param {string} [input.loginStateExpiresIn] - Pending standalone login session TTL (e.g. `10m`)
 * @param {Function} [input.onTokenIssued] - Callback after standalone OAuth (user, jwt, context)
 * @param {string} [input.postLoginRedirectUrl] - HTTP redirect after standalone OAuth (e.g. https://t.me/BotName)
 * @param {Object} [input.sessionStore] - Standalone session store (InMemory or Redis)
 * @param {string[]} [input.allowedRedirectUris] - Exact-match redirect URIs allowed for DCR
 * @param {string[]} [input.trustedRedirectHosts] - Extra https hosts merged with library defaults
 * @param {boolean} [input.allowAnyHttpsRedirect] - When true, accept any https redirect URI
 * @returns {{ enabled: false } | Object} Normalized auth options for ExpressMcp
 */
export function buildAuthOptions(input = {}) {
  if (!input.enabled) {
    return { enabled: false };
  }

  const resourcePath = input.resourcePath || input.mcpPath || '/mcp';

  let issuer;
  if (input.issuer) {
    issuer = requireNonEmptyString(input.issuer, 'issuer');
  } else {
    const baseUrl = requireNonEmptyString(input.baseUrl, 'baseUrl').replace(/\/$/, '');
    issuer = `${baseUrl}${resourcePath}`;
  }

  const auth = {
    enabled: true,
    issuer,
    resourcePath,
    callbackUrl: input.callbackUrl,
    jwtSecret: input.jwtSecret,
    sessionSecret: input.sessionSecret,
    jwtExpiresIn: input.jwtExpiresIn,
    allowedUsers: input.allowedUsers
  };

  if (input.providers) {
    auth.providers = input.providers;
  } else if (input.clientId && input.clientSecret) {
    auth.provider = input.provider;
    auth.clientId = input.clientId;
    auth.clientSecret = input.clientSecret;
  }

  if (typeof input.loginStateExpiresIn === 'string' && input.loginStateExpiresIn.trim()) {
    auth.loginStateExpiresIn = input.loginStateExpiresIn.trim();
  }
  if (typeof input.onTokenIssued === 'function') {
    auth.onTokenIssued = input.onTokenIssued;
  }
  if (typeof input.postLoginRedirectUrl === 'string' && input.postLoginRedirectUrl.trim()) {
    auth.postLoginRedirectUrl = input.postLoginRedirectUrl.trim();
  }
  if (input.sessionStore) {
    auth.sessionStore = input.sessionStore;
  }
  if (Array.isArray(input.allowedRedirectUris)) {
    auth.allowedRedirectUris = input.allowedRedirectUris;
  }
  if (Array.isArray(input.trustedRedirectHosts)) {
    auth.trustedRedirectHosts = input.trustedRedirectHosts;
  }
  if (input.allowAnyHttpsRedirect === true) {
    auth.allowAnyHttpsRedirect = true;
  }
  if (input.showTokenOnSuccessPage === true) {
    auth.showTokenOnSuccessPage = true;
  }
  if (input.enableDebugEndpoint === true) {
    auth.enableDebugEndpoint = true;
  }

  validateAuthOptions(auth);
  return auth;
}
