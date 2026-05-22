/**
 * Resolve OAuth client credentials and auth options from environment.
 */

import { parseAllowedUsersFromEnv } from './authz.js';

function provider() {
  return (process.env.OAUTH_PROVIDER || 'github').toLowerCase();
}

export function getOAuthClientId() {
  if (provider() === 'google') {
    return process.env.GOOGLE_CLIENT_ID || process.env.OAUTH_CLIENT_ID;
  }
  return process.env.OAUTH_CLIENT_ID || process.env.GITHUB_CLIENT_ID;
}

export function getOAuthClientSecret() {
  if (provider() === 'google') {
    return process.env.GOOGLE_CLIENT_SECRET || process.env.OAUTH_CLIENT_SECRET;
  }
  return process.env.OAUTH_CLIENT_SECRET || process.env.GITHUB_CLIENT_SECRET;
}

function buildProvidersFromEnv() {
  const providers = {};

  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
    providers.github = {
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET
    };
  }

  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    providers.google = {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET
    };
  }

  return providers;
}

export function isOAuthConfigured() {
  const providers = buildProvidersFromEnv();
  const hasProvider = Object.keys(providers).length > 0;
  const hasLegacy =
    getOAuthClientId() && getOAuthClientSecret();

  return Boolean(
    (hasProvider || hasLegacy) &&
      process.env.JWT_SECRET &&
      process.env.SESSION_SECRET
  );
}

/**
 * Build options.auth for ExpressMcp from process.env.
 * Supports multiple providers (GITHUB_* + GOOGLE_*) or legacy single-provider env.
 * @param {Object} [overrides] - Override baseUrl, callbackUrl, etc.
 * @returns {Object|null} auth options or null if not configured
 */
export function buildAuthOptionsFromEnv(overrides = {}) {
  if (process.env.AUTH_ENABLED === 'false') {
    return null;
  }

  if (!isOAuthConfigured()) {
    return null;
  }

  const port = Number(process.env.PORT) || 3000;
  const baseUrl =
    overrides.baseUrl ||
    process.env.BASE_URL ||
    (process.env.HEROKU_APP_NAME
      ? `https://${process.env.HEROKU_APP_NAME}.herokuapp.com`
      : `http://localhost:${port}`);

  const callbackUrl =
    overrides.callbackUrl ||
    process.env.OAUTH_CALLBACK_URL ||
    `${baseUrl.replace(/\/$/, '')}/auth/callback`;

  const providers = buildProvidersFromEnv();
  const auth = {
    enabled: true, // consumed by host app when assigning mcpOptions.auth
    callbackUrl,
    jwtSecret: process.env.JWT_SECRET,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
    sessionSecret: process.env.SESSION_SECRET,
    allowedUsers: parseAllowedUsersFromEnv(process.env.AUTH_ALLOWED_USERS)
  };

  if (Object.keys(providers).length > 0) {
    auth.providers = providers;
  } else {
    auth.provider = provider();
    auth.clientId = getOAuthClientId();
    auth.clientSecret = getOAuthClientSecret();
  }

  return auth;
}

export { parseAllowedUsersFromEnv } from './authz.js';
