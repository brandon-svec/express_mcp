import { SUPPORTED_OAUTH_PROVIDERS } from './classes/authManager.js';

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

  const enabledProviders = SUPPORTED_OAUTH_PROVIDERS.filter(
    (name) => providers[name]?.clientId && providers[name]?.clientSecret
  );

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
