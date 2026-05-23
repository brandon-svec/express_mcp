import { createHash, randomBytes } from 'crypto';

/**
 * @param {string} codeVerifier
 * @param {string} codeChallenge
 * @returns {boolean}
 */
export function verifyPkceChallenge(codeVerifier, codeChallenge) {
  if (typeof codeVerifier !== 'string' || typeof codeChallenge !== 'string') {
    return false;
  }
  if (!codeVerifier || !codeChallenge) {
    return false;
  }
  const digest = createHash('sha256').update(codeVerifier).digest('base64url');
  return digest === codeChallenge;
}

/**
 * @param {string} origin - Site origin without trailing slash (e.g. https://host)
 * @param {string} resourcePath - MCP resource path (e.g. /mcp)
 * @param {string} authorizationServerIssuer - MCP OAuth AS issuer (e.g. https://host/mcp)
 * @returns {Object}
 */
export function buildProtectedResourceMetadata(origin, resourcePath, authorizationServerIssuer) {
  const normalizedPath = resourcePath.startsWith('/') ? resourcePath : `/${resourcePath}`;

  return {
    resource: `${origin}${normalizedPath}`,
    authorization_servers: [authorizationServerIssuer],
    scopes_supported: ['mcp'],
    bearer_methods_supported: ['header']
  };
}

/**
 * @param {string} issuer
 * @returns {Object}
 */
export function buildAuthorizationServerMetadata(issuer) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none']
  };
}

/**
 * @param {string} origin - Site origin without trailing slash
 * @param {string} resourcePath - MCP resource path (e.g. /mcp)
 * @returns {string}
 */
export function protectedResourceMetadataUrl(origin, resourcePath) {
  const normalizedPath = resourcePath.startsWith('/') ? resourcePath : `/${resourcePath}`;
  const resourceSuffix = normalizedPath.slice(1);
  if (!resourceSuffix) {
    return `${origin}/.well-known/oauth-protected-resource`;
  }
  return `${origin}/.well-known/oauth-protected-resource/${resourceSuffix}`;
}

/**
 * @param {string} origin - Site origin without trailing slash
 * @param {string} resourcePath - MCP resource path (e.g. /mcp)
 * @returns {string}
 */
export function buildWwwAuthenticateHeader(origin, resourcePath) {
  const metadataUrl = protectedResourceMetadataUrl(origin, resourcePath);
  return `Bearer realm="mcp", resource_metadata="${metadataUrl}"`;
}

/**
 * In-memory OAuth client registry for Dynamic Client Registration.
 */
export class OAuthClientRegistry {
  constructor() {
    /** @type {Map<string, Object>} */
    this.clients = new Map();
  }

  /**
   * @param {Object} registration
   * @returns {Object}
   */
  register(registration) {
    const clientId = randomBytes(16).toString('hex');
    const record = {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: registration.client_name,
      redirect_uris: registration.redirect_uris,
      grant_types: registration.grant_types,
      response_types: registration.response_types,
      token_endpoint_auth_method: 'none'
    };
    this.clients.set(clientId, record);
    return record;
  }

  /**
   * @param {string} clientId
   * @returns {Object|null}
   */
  get(clientId) {
    return this.clients.get(clientId) || null;
  }

  /**
   * @param {string} clientId
   * @param {string} redirectUri
   * @returns {boolean}
   */
  isRedirectUriAllowed(clientId, redirectUri) {
    const client = this.get(clientId);
    if (!client) {
      return false;
    }
    return client.redirect_uris.includes(redirectUri);
  }
}

/**
 * In-memory pending IdP auth state keyed by OAuth state sent to Google/GitHub.
 * Survives MCP clients that call /authorize without a browser session cookie.
 */
export class PendingAuthStore {
  constructor() {
    /** @type {Map<string, Object>} */
    this.entries = new Map();
  }

  /**
   * @param {Object} entry
   * @returns {string} state value for IdP redirect
   */
  issue(entry) {
    const id = randomBytes(16).toString('hex');
    this.entries.set(id, {
      ...entry,
      expiresAt: Date.now() + 10 * 60 * 1000
    });
    return id;
  }

  /**
   * @param {string} id
   * @returns {Object|null}
   */
  get(id) {
    const entry = this.entries.get(id);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(id);
      return null;
    }
    return entry;
  }

  /**
   * @param {string} id
   * @returns {Object|null}
   */
  consume(id) {
    const entry = this.get(id);
    if (!entry) {
      return null;
    }
    this.entries.delete(id);
    return entry;
  }
}

/**
 * In-memory authorization code store with PKCE binding.
 */
export class AuthorizationCodeStore {
  constructor() {
    /** @type {Map<string, Object>} */
    this.codes = new Map();
  }

  /**
   * @param {Object} entry
   * @returns {string}
   */
  issue(entry) {
    const code = randomBytes(32).toString('base64url');
    this.codes.set(code, {
      ...entry,
      expiresAt: Date.now() + 5 * 60 * 1000
    });
    return code;
  }

  /**
   * @param {string} code
   * @returns {Object|null}
   */
  consume(code) {
    const entry = this.codes.get(code);
    if (!entry) {
      return null;
    }
    this.codes.delete(code);
    if (entry.expiresAt <= Date.now()) {
      return null;
    }
    return entry;
  }
}

/**
 * @param {string} token
 * @returns {number}
 */
export function jwtExpiresInSeconds(token) {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  if (typeof payload.exp !== 'number') {
    throw new Error('JWT payload missing exp claim');
  }
  const remaining = payload.exp - Math.floor(Date.now() / 1000);
  if (remaining <= 0) {
    throw new Error('JWT already expired');
  }
  return remaining;
}
