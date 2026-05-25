import { SUPPORTED_OAUTH_PROVIDERS } from './classes/authManager.js';

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
 * Validate ExpressMcp auth options when auth is enabled.
 * @param {Object} auth - options.auth from ExpressMcp constructor
 */
export function validateAuthOptions(auth) {
  if (!auth?.enabled) {
    return;
  }

  requireNonEmptyString(auth.callbackUrl, 'callbackUrl');
  requireNonEmptyString(auth.jwtSecret, 'jwtSecret');
  requireNonEmptyString(auth.sessionSecret, 'sessionSecret');
  requireNonEmptyString(auth.issuer, 'issuer');
  requireNonEmptyString(auth.jwtExpiresIn, 'jwtExpiresIn');

  if (!auth.sessionStore) {
    throw new Error('Auth enabled but sessionStore is required.');
  }

  if (auth.resourcePath !== undefined) {
    requireNonEmptyString(auth.resourcePath, 'resourcePath');
  }

  if (auth.allowedUsers !== undefined && !Array.isArray(auth.allowedUsers)) {
    throw new Error('Auth enabled but allowedUsers must be an array.');
  }

  normalizeAuthProviders(auth);
}

/**
 * Normalize ExpressMcp auth options into a providers map for AuthManager.
 * @param {Object} auth - options.auth from ExpressMcp constructor
 * @returns {{ providers: Object, enabledProviders: string[] }}
 */
export function normalizeAuthProviders(auth) {
  let providers = auth.providers;

  if (!providers && auth.clientId && auth.clientSecret) {
    const name = auth.provider || 'github';
    providers = {
      [name]: {
        clientId: auth.clientId,
        clientSecret: auth.clientSecret
      }
    };
  }

  if (!providers || typeof providers !== 'object') {
    throw new Error(
      'Auth enabled but no providers configured. Set auth.providers or auth.clientId/clientSecret.'
    );
  }

  const enabledProviders = [];

  for (const name of SUPPORTED_OAUTH_PROVIDERS) {
    const providerConfig = providers[name];
    if (!providerConfig) {
      continue;
    }

    const hasClientId =
      typeof providerConfig.clientId === 'string' && providerConfig.clientId.trim();
    const hasClientSecret =
      typeof providerConfig.clientSecret === 'string' &&
      providerConfig.clientSecret.trim();

    if (hasClientId && hasClientSecret) {
      enabledProviders.push(name);
      continue;
    }

    if (hasClientId || hasClientSecret) {
      const missing = hasClientId ? 'clientSecret' : 'clientId';
      throw new Error(
        `Auth enabled but ${name} ${missing} is missing or empty.`
      );
    }
  }

  if (enabledProviders.length === 0) {
    throw new Error(
      'Auth enabled but no valid OAuth provider credentials found in auth.providers'
    );
  }

  return { providers, enabledProviders };
}

/**
 * Build serverInfo.auth payload for MCP initialize response.
 * @param {string[]} enabledProviders
 * @returns {Object}
 */
export function authServerInfo(enabledProviders) {
  if (enabledProviders.length === 1) {
    return {
      required: true,
      provider: enabledProviders[0]
    };
  }
  return {
    required: true,
    providers: enabledProviders
  };
}
