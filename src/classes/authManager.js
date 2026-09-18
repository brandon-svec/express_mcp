import { Router } from 'express';
import express from 'express';
import session from 'express-session';
import jwt from 'jsonwebtoken';
import { randomBytes, randomUUID } from 'crypto';
import { isUserAllowed, userLogFields } from '../authz.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import {
  AuthorizationCodeStore,
  DEFAULT_REFRESH_TOKEN_TTL_SECONDS,
  DEFAULT_TRUSTED_REDIRECT_HOSTS,
  OAuthClientRegistry,
  PendingAuthStore,
  buildAuthorizationRedirectUrl,
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
  extractRawQueryParam,
  isRedirectUriAllowedByPolicy,
  jwtExpiresInSeconds,
  verifyPkceChallenge
} from '../mcpOAuth.js';
import { ContextAuthRequiredError } from '../stores/errors.js';
import { GoogleScopeGrantRequiredError } from '../stores/errors.js';
import { deriveSealKey, seal, unseal } from '../crypto/seal.js';
import { assertValidSessionId, isUuidV4SessionId, sanitizeHostContext } from '../stores/sessionContext.js';
import { parseDurationToSeconds } from '../stores/sessionTtl.js';

export const SUPPORTED_OAUTH_PROVIDERS = ['github', 'google'];

export const GOOGLE_CONTACTS_READONLY_SCOPE =
  'https://www.googleapis.com/auth/contacts.readonly';

/**
 * @param {unknown} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeGoogleExtraScopes(value) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error('googleExtraScopes must be an array of strings');
  }
  const scopes = [];
  for (const scope of value) {
    if (typeof scope !== 'string' || !scope.trim()) {
      throw new Error('googleExtraScopes must contain only non-empty strings');
    }
    const trimmed = scope.trim();
    if (!scopes.includes(trimmed)) {
      scopes.push(trimmed);
    }
  }
  return scopes;
}

/**
 * @param {string} scopeString
 * @returns {string[]}
 */
function parseScopeString(scopeString) {
  if (typeof scopeString !== 'string' || !scopeString.trim()) {
    return [];
  }
  return scopeString
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {string[]} granted
 * @param {string[]} required
 * @returns {string[]}
 */
function missingScopes(granted, required) {
  const set = new Set(granted);
  return required.filter((scope) => !set.has(scope));
}

const PROVIDER_META = {
  github: {
    scopes: ['read:user', 'user:email'],
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userUrl: 'https://api.github.com/user',
    emailsUrl: 'https://api.github.com/user/emails',
    label: 'GitHub'
  },
  google: {
    scopes: ['openid', 'email', 'profile'],
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    label: 'Google'
  }
};

/**
 * Normalize provider user profile into a common shape for JWT claims.
 * @param {string} provider
 * @param {Object} profile
 * @returns {Object}
 */
function normalizeUser(provider, profile) {
  if (provider === 'github') {
    return {
      sub: `gh:${profile.id}`,
      login: profile.login,
      name: profile.name || profile.login,
      email: profile.email || null,
      provider: 'github',
      avatarUrl: profile.avatar_url || null
    };
  }

  return {
    sub: `google:${profile.sub}`,
    login: profile.email || profile.sub,
    name: profile.name || profile.email,
    email: profile.email || null,
    provider: 'google',
    avatarUrl: profile.picture || null
  };
}

/**
 * OAuth SSO and JWT session management for MCP servers.
 */
export class AuthManager {
  /**
   * @param {Object} options
   * @param {Object} options.providers - Map of provider name to { clientId, clientSecret }
   * @param {string} options.callbackUrl - Full redirect URI registered with each provider
   * @param {string} options.jwtSecret
   * @param {string} [options.jwtExpiresIn='7d']
   * @param {string} options.sessionSecret
   * @param {string} options.issuer - MCP OAuth authorization server issuer (e.g. https://host/mcp)
   * @param {string} [options.resourcePath='/mcp'] - MCP HTTP resource path (suffix under site origin)
   * @param {string} [options.origin] - Site origin for PRM discovery; derived from issuer when omitted
   * @param {Object} [options.logger] - Logger with info, warn, error, debug
   * @param {string[]} [options.allowedUsers] - Optional email/login allowlist (empty = allow all)
   * @param {string} [options.loginStateExpiresIn='10m'] - TTL for pending standalone login sessions
   * @param {function(user: Object, jwt: string, context: Object): (void|Promise<void>)} [options.onTokenIssued]
   * @param {string} [options.postLoginRedirectUrl] - Redirect browser after standalone OAuth (not MCP PKCE flow)
   * @param {string[]} [options.allowedRedirectUris] - Extra exact redirect URIs allowed for DCR
   * @param {string[]} [options.trustedRedirectHosts] - Extra https hosts merged with library defaults
   * @param {boolean} [options.allowAnyHttpsRedirect=false] - When true, accept any https redirect URI
   * @param {boolean} [options.showTokenOnSuccessPage=false] - Embed Bearer JWT in standalone success HTML (local dev only)
   * @param {boolean} [options.enableDebugEndpoint=false] - Mount GET /auth/debug
   * @param {import('../stores/inMemoryStandaloneSessionStore.js').InMemoryStandaloneSessionStore|import('../stores/redisStandaloneSessionStore.js').RedisStandaloneSessionStore} options.sessionStore
   * @param {string[]} [options.googleExtraScopes] - Extra Google scopes available via incremental consent (not requested on every login)
   * @param {string} [options.idpTokenEncryptionKey] - Secret (≥32 chars) used to encrypt stored Google refresh tokens; required when googleExtraScopes is set
   */
  constructor(options) {
    this.providers = options.providers || {};
    this.enabledProviders = SUPPORTED_OAUTH_PROVIDERS.filter(
      (name) => this.providers[name]?.clientId && this.providers[name]?.clientSecret
    );

    if (this.enabledProviders.length === 0) {
      throw new Error(
        'At least one OAuth provider with clientId and clientSecret is required'
      );
    }

    this.callbackUrl = options.callbackUrl;
    this.jwtSecret = options.jwtSecret;
    this.jwtExpiresIn = options.jwtExpiresIn || '7d';
    this.sessionSecret = options.sessionSecret;
    this.logger = options.logger || console;
    this.allowedUsers = options.allowedUsers || [];
    this.allowedRedirectUris = Array.isArray(options.allowedRedirectUris)
      ? options.allowedRedirectUris.filter((u) => typeof u === 'string')
      : [];
    this.trustedRedirectHosts = new Set([
      ...DEFAULT_TRUSTED_REDIRECT_HOSTS,
      ...(Array.isArray(options.trustedRedirectHosts) ? options.trustedRedirectHosts : [])
        .filter((h) => typeof h === 'string' && h.trim())
        .map((h) => h.trim().toLowerCase())
    ]);
    this.allowAnyHttpsRedirect = options.allowAnyHttpsRedirect === true;
    this.showTokenOnSuccessPage = options.showTokenOnSuccessPage === true;
    this.enableDebugEndpoint = options.enableDebugEndpoint === true;

    if (!options.issuer || typeof options.issuer !== 'string' || !options.issuer.trim()) {
      throw new Error('issuer is required for MCP OAuth authorization server');
    }
    this.issuer = options.issuer.replace(/\/$/, '');
    this.resourcePath = options.resourcePath || '/mcp';
    const normalizedResourcePath = this.resourcePath.startsWith('/')
      ? this.resourcePath
      : `/${this.resourcePath}`;
    this.normalizedResourcePath = normalizedResourcePath;
    if (options.origin) {
      this.origin = options.origin.replace(/\/$/, '');
    } else if (this.issuer.endsWith(normalizedResourcePath)) {
      this.origin = this.issuer.slice(0, this.issuer.length - normalizedResourcePath.length);
    } else {
      throw new Error(
        `issuer "${this.issuer}" must end with resourcePath "${normalizedResourcePath}" or provide origin`
      );
    }
    if (!this.origin) {
      throw new Error('origin could not be derived from issuer and resourcePath');
    }
    this.expectedResource = `${this.origin}${normalizedResourcePath}`;
    this.authPath = options.authPath || '/auth';
    this.loginStateExpiresIn = options.loginStateExpiresIn || '10m';
    this.onTokenIssued =
      typeof options.onTokenIssued === 'function' ? options.onTokenIssued : null;
    if (!options.sessionStore) {
      throw new Error('sessionStore is required for AuthManager');
    }
    this.sessionStore = options.sessionStore;
    this.postLoginRedirectUrl =
      typeof options.postLoginRedirectUrl === 'string' && options.postLoginRedirectUrl.trim()
        ? options.postLoginRedirectUrl.trim()
        : null;
    this.googleExtraScopes = normalizeGoogleExtraScopes(options.googleExtraScopes);
    if (this.googleExtraScopes.length > 0) {
      if (!this.enabledProviders.includes('google')) {
        throw new Error('googleExtraScopes requires the google OAuth provider');
      }
      if (
        typeof options.idpTokenEncryptionKey !== 'string' ||
        options.idpTokenEncryptionKey.length < 32
      ) {
        throw new Error(
          'idpTokenEncryptionKey (≥32 characters) is required when googleExtraScopes is set'
        );
      }
      this.idpSealKey = deriveSealKey(options.idpTokenEncryptionKey);
    } else {
      this.idpSealKey = null;
    }
    this.oauthClients = new OAuthClientRegistry();
    this.authorizationCodes = new AuthorizationCodeStore();
    this.pendingAuthStore = new PendingAuthStore();
  }

  /**
   * @param {string} provider
   * @returns {{ clientId: string, clientSecret: string, meta: Object }}
   */
  _getProviderCredentials(provider) {
    if (!this.enabledProviders.includes(provider)) {
      throw new Error(`OAuth provider not enabled: ${provider}`);
    }
    const creds = this.providers[provider];
    return {
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      meta: PROVIDER_META[provider]
    };
  }

  /**
   * Build OAuth authorization URL for a provider.
   * @param {string} provider
   * @param {string} state - CSRF state value
   * @param {{
   *   extraScopes?: string[],
   *   accessType?: 'online'|'offline',
   *   prompt?: string,
   *   includeGrantedScopes?: boolean
   * }} [options]
   * @returns {string}
   */
  getAuthorizationUrl(provider, state, options = {}) {
    const { clientId, meta } = this._getProviderCredentials(provider);
    const scopes = [...meta.scopes];
    if (Array.isArray(options.extraScopes)) {
      for (const scope of options.extraScopes) {
        if (typeof scope !== 'string' || !scope) {
          throw new Error('extraScopes must contain only non-empty strings');
        }
        if (!scopes.includes(scope)) {
          scopes.push(scope);
        }
      }
    }

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: this.callbackUrl,
      scope: scopes.join(' '),
      state
    });

    if (provider === 'google') {
      params.set('response_type', 'code');
      const accessType = options.accessType === 'offline' ? 'offline' : 'online';
      params.set('access_type', accessType);
      if (typeof options.prompt === 'string' && options.prompt) {
        params.set('prompt', options.prompt);
      } else {
        params.set('prompt', 'select_account');
      }
      if (options.includeGrantedScopes === true) {
        params.set('include_granted_scopes', 'true');
      }
    }

    return `${meta.authorizeUrl}?${params.toString()}`;
  }

  /**
   * Exchange authorization code for user profile from the provider.
   * @param {string} provider
   * @param {string} code
   * @returns {Promise<{ user: Object, tokenResponse: Object }>}
   */
  async exchangeCodeForUser(provider, code) {
    const tokenResponse = await this._exchangeCodeForToken(provider, code);
    const profile = await this._fetchUserProfile(provider, tokenResponse.access_token);
    return {
      user: normalizeUser(provider, profile),
      tokenResponse
    };
  }

  /**
   * @param {string} provider
   * @param {string} code
   * @returns {Promise<{ access_token: string, refresh_token?: string, scope?: string, expires_in?: number, token_type?: string }>}
   * @private
   */
  async _exchangeCodeForToken(provider, code) {
    const { clientId, clientSecret, meta } = this._getProviderCredentials(provider);

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: this.callbackUrl,
      grant_type: 'authorization_code'
    });

    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    };

    const response = await fetch(meta.tokenUrl, {
      method: 'POST',
      headers,
      body: body.toString()
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token exchange failed (${response.status}): ${text}`);
    }

    const data = await response.json();
    if (!data.access_token) {
      throw new Error('Token exchange did not return an access_token');
    }

    return data;
  }

  /**
   * Refresh a Google access token using a stored refresh token.
   * @param {string} refreshToken
   * @returns {Promise<{ access_token: string, scope?: string, expires_in?: number, token_type?: string }>}
   * @private
   */
  async _refreshGoogleAccessToken(refreshToken) {
    const { clientId, clientSecret, meta } = this._getProviderCredentials('google');
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    });
    const response = await fetch(meta.tokenUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: body.toString()
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Google token refresh failed (${response.status}): ${text}`);
    }
    const data = await response.json();
    if (!data.access_token) {
      throw new Error('Google token refresh did not return an access_token');
    }
    return data;
  }

  /**
   * Persist an encrypted Google refresh grant for a user.
   * @param {string} sub
   * @param {{ refresh_token?: string, scope?: string }} tokenResponse
   * @param {string[]} [requestedScopes]
   * @returns {Promise<void>}
   */
  async persistGoogleIdpGrant(sub, tokenResponse, requestedScopes = []) {
    if (typeof sub !== 'string' || !sub) {
      throw new Error('sub is required');
    }
    if (!this.idpSealKey) {
      throw new Error('idpTokenEncryptionKey is not configured');
    }
    if (typeof this.sessionStore.storeIdpGrant !== 'function') {
      throw new Error('sessionStore.storeIdpGrant is required for Google IdP grants');
    }
    if (!tokenResponse || typeof tokenResponse !== 'object') {
      throw new Error('tokenResponse is required');
    }
    if (typeof tokenResponse.refresh_token !== 'string' || !tokenResponse.refresh_token) {
      throw new Error('Google token response did not include a refresh_token');
    }
    const scopesFromToken = parseScopeString(tokenResponse.scope);
    const scopes = [...new Set([...requestedScopes, ...scopesFromToken])];
    if (scopes.length === 0) {
      throw new Error('Cannot persist Google IdP grant without scopes');
    }
    await this.sessionStore.storeIdpGrant(sub, {
      sealedRefreshToken: seal(tokenResponse.refresh_token, this.idpSealKey),
      scopes,
      updatedAt: new Date().toISOString()
    });
  }

  /**
   * Create a pending incremental Google consent URL for extra scopes.
   * @param {{ scopes: string[], context?: unknown, sub?: string }} input
   * @returns {Promise<{ session_id: string, grant_url: string }>}
   */
  async createGoogleGrantUrl(input) {
    if (!input || typeof input !== 'object') {
      throw new Error('createGoogleGrantUrl requires an input object');
    }
    if (!this.enabledProviders.includes('google')) {
      throw new Error('google OAuth provider is not enabled');
    }
    if (this.googleExtraScopes.length === 0) {
      throw new Error('googleExtraScopes is not configured');
    }
    if (!Array.isArray(input.scopes) || input.scopes.length === 0) {
      throw new Error('scopes is required');
    }
    for (const scope of input.scopes) {
      if (typeof scope !== 'string' || !scope) {
        throw new Error('scopes must contain only non-empty strings');
      }
      if (!this.googleExtraScopes.includes(scope)) {
        throw new Error(`scope is not in googleExtraScopes allowlist: ${scope}`);
      }
    }
    const sanitized = sanitizeHostContext(input.context);
    const sub =
      typeof input.sub === 'string' && input.sub ? input.sub : null;
    const sessionId = randomUUID();
    await this.sessionStore.createPending(
      sessionId,
      sanitized,
      'google',
      this._pendingSessionTtlSeconds(),
      {
        purpose: 'google_grant',
        scopes: input.scopes,
        sub
      }
    );
    const grantUrl = new URL(
      `${this.origin}${this.authPath}/login/google`,
      this.origin
    );
    grantUrl.searchParams.set('session_id', sessionId);
    return {
      session_id: sessionId,
      grant_url: grantUrl.toString()
    };
  }

  /**
   * Return a fresh Google access token for the given user sub.
   * Throws GoogleScopeGrantRequiredError when the grant is missing or incomplete.
   * @param {string} sub
   * @param {{ requiredScopes: string[] }} options
   * @returns {Promise<{ accessToken: string, scopes: string[], expiresIn: number|null }>}
   */
  async getGoogleAccessToken(sub, options) {
    if (typeof sub !== 'string' || !sub) {
      throw new Error('sub is required');
    }
    if (!options || typeof options !== 'object') {
      throw new Error('options is required');
    }
    if (!Array.isArray(options.requiredScopes) || options.requiredScopes.length === 0) {
      throw new Error('requiredScopes is required');
    }
    for (const scope of options.requiredScopes) {
      if (typeof scope !== 'string' || !scope) {
        throw new Error('requiredScopes must contain only non-empty strings');
      }
    }
    if (!this.idpSealKey) {
      throw new GoogleScopeGrantRequiredError(
        'Google IdP grants are not configured on this server',
        { sub, reason: 'not_configured', missingScopes: options.requiredScopes }
      );
    }
    if (typeof this.sessionStore.findIdpGrant !== 'function') {
      throw new Error('sessionStore.findIdpGrant is required for Google IdP grants');
    }
    const grant = await this.sessionStore.findIdpGrant(sub);
    if (!grant) {
      throw new GoogleScopeGrantRequiredError(
        'No Google Contacts grant for this user',
        { sub, reason: 'no_grant', missingScopes: options.requiredScopes }
      );
    }
    const missing = missingScopes(grant.scopes, options.requiredScopes);
    if (missing.length > 0) {
      throw new GoogleScopeGrantRequiredError(
        `Google grant is missing required scopes: ${missing.join(', ')}`,
        { sub, reason: 'missing_scopes', missingScopes: missing }
      );
    }
    let refreshToken;
    try {
      refreshToken = unseal(grant.sealedRefreshToken, this.idpSealKey);
    } catch (err) {
      throw new Error(`Failed to decrypt Google IdP grant: ${err.message}`);
    }
    let tokenResponse;
    try {
      tokenResponse = await this._refreshGoogleAccessToken(refreshToken);
    } catch (err) {
      throw new GoogleScopeGrantRequiredError(
        `Google grant refresh failed: ${err.message}`,
        { sub, reason: 'refresh_failed', missingScopes: options.requiredScopes }
      );
    }
    const refreshedScopes = parseScopeString(tokenResponse.scope);
    if (refreshedScopes.length > 0) {
      const merged = [...new Set([...grant.scopes, ...refreshedScopes])];
      const stillMissing = missingScopes(merged, options.requiredScopes);
      if (stillMissing.length > 0) {
        throw new GoogleScopeGrantRequiredError(
          `Refreshed Google token is missing required scopes: ${stillMissing.join(', ')}`,
          { sub, reason: 'missing_scopes', missingScopes: stillMissing }
        );
      }
    }
    return {
      accessToken: tokenResponse.access_token,
      scopes: grant.scopes,
      expiresIn:
        typeof tokenResponse.expires_in === 'number' ? tokenResponse.expires_in : null
    };
  }

  /**
   * @param {string} provider
   * @param {string} accessToken
   * @returns {Promise<Object>}
   * @private
   */
  async _fetchUserProfile(provider, accessToken) {
    const { meta } = this._getProviderCredentials(provider);

    const response = await fetch(meta.userUrl, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'express-mcp-auth'
      }
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`User profile fetch failed (${response.status}): ${text}`);
    }

    const profile = await response.json();

    if (provider === 'github' && !profile.email) {
      profile.email = await this._fetchGitHubPrimaryEmail(accessToken, meta);
    }

    return profile;
  }

  /**
   * @param {string} accessToken
   * @param {Object} meta
   * @returns {Promise<string|null>}
   * @private
   */
  async _fetchGitHubPrimaryEmail(accessToken, meta) {
    const response = await fetch(meta.emailsUrl, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'express-mcp-auth'
      }
    });

    if (!response.ok) {
      return null;
    }

    const emails = await response.json();
    const primary = emails.find((e) => e.primary && e.verified);
    const verified = emails.find((e) => e.verified);
    return (primary || verified || emails[0])?.email || null;
  }

  /**
   * Issue a signed JWT for an authenticated user.
   * @param {Object} user - Normalized user from exchangeCodeForUser
   * @returns {string}
   */
  issueJwt(user) {
    const payload = {
      jti: randomUUID(),
      sub: user.sub,
      login: user.login,
      name: user.name,
      email: user.email,
      provider: user.provider
    };

    return jwt.sign(payload, this.jwtSecret, {
      expiresIn: this.jwtExpiresIn,
      algorithm: 'HS256'
    });
  }

  /**
   * Persist Bearer access token as active standalone session keyed by JWT jti.
   * @param {string} accessToken
   * @param {Record<string, string>} [context]
   * @returns {Promise<void>}
   */
  async persistAccessTokenSession(accessToken, context = {}) {
    if (typeof accessToken !== 'string' || !accessToken) {
      throw new Error('accessToken is required');
    }
    const payload = this.verifyJwt(accessToken);
    if (!payload.jti) {
      throw new Error('JWT payload missing jti claim');
    }
    assertValidSessionId(payload.jti);
    const sanitized = sanitizeHostContext(context);
    await this.sessionStore.activate(
      payload.jti,
      payload,
      this._activeSessionTtlSeconds(),
      sanitized
    );
  }

  /**
   * Remove active standalone session for JWT jti (Cursor Bearer sign-out).
   * @param {string} jti
   * @returns {Promise<boolean>}
   */
  async deactivateVerifiedSessionByJti(jti) {
    if (!jti) {
      throw new Error('jti is required to deactivate a session');
    }
    assertValidSessionId(jti);
    return this.sessionStore.deactivate(jti);
  }

  /**
   * @returns {number}
   * @private
   */
  _activeSessionTtlSeconds() {
    return parseDurationToSeconds(this.jwtExpiresIn);
  }

  /**
   * @returns {number}
   * @private
   */
  _pendingSessionTtlSeconds() {
    return parseDurationToSeconds(this.loginStateExpiresIn);
  }

  /**
   * Load active standalone session by id.
   * @param {string} sessionId
   * @returns {Promise<{ user: Object, context: Record<string, string> }>}
   */
  async getVerifiedSession(sessionId) {
    assertValidSessionId(sessionId);
    const active = await this.sessionStore.findActive(sessionId);
    if (!active) {
      throw new ContextAuthRequiredError(`No active session for session_id ${sessionId}`);
    }
    return active;
  }

  /**
   * Load active standalone session by host context (alias lookup).
   * @param {unknown} context
   * @returns {Promise<{ user: Object, context: Record<string, string> }>}
   */
  async getVerifiedSessionByContext(context) {
    const sanitized = sanitizeHostContext(context);
    if (Object.keys(sanitized).length === 0) {
      throw new Error('context must be a non-empty object for session lookup');
    }
    const active = await this.sessionStore.findActiveByContext(sanitized);
    if (!active) {
      throw new ContextAuthRequiredError('No active session for the given context');
    }
    return active;
  }

  /**
   * Remove active standalone session for host context (e.g. Telegram sign-out).
   * @param {unknown} context
   * @returns {Promise<boolean>} true when a session was removed
   */
  async deactivateVerifiedSessionByContext(context) {
    const sanitized = sanitizeHostContext(context);
    if (Object.keys(sanitized).length === 0) {
      throw new Error('context must be a non-empty object for session deactivation');
    }
    return this.sessionStore.deactivateByContext(sanitized);
  }

  /**
   * Verify and decode a JWT.
   * @param {string} token
   * @returns {Object} Decoded payload
   */
  verifyJwt(token) {
    return jwt.verify(token, this.jwtSecret, { algorithms: ['HS256'] });
  }

  /**
   * @returns {import('express').RequestHandler}
   */
  _sessionMiddleware(sessionOptions = {}) {
    return session({
      secret: this.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: this.origin.startsWith('https:'),
        httpOnly: true,
        maxAge: 15 * 60 * 1000
      },
      ...sessionOptions
    });
  }

  /**
   * @param {string} redirectUri
   * @returns {boolean}
   * @private
   */
  _isHttpRedirectUri(redirectUri) {
    let parsed;
    try {
      parsed = new URL(redirectUri);
    } catch {
      return false;
    }
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  }

  /**
   * HTML interstitial for custom-scheme OAuth redirects (e.g. cursor://).
   * Triggers the deep link and attempts to close the browser tab.
   * @param {string} redirectTarget
   * @returns {string}
   * @private
   */
  _renderCustomSchemeOAuthCompletePage(redirectTarget) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Authentication complete</title>
</head>
<body>
  <p>Authentication complete. Return to Cursor.</p>
  <p id="status">Opening Cursor…</p>
  <script>
    (function () {
      var target = ${JSON.stringify(redirectTarget)};
      window.location.replace(target);
      setTimeout(function () {
        window.close();
      }, 500);
      setTimeout(function () {
        var status = document.getElementById('status');
        if (status) {
          status.textContent = 'You can close this tab and return to Cursor.';
        }
      }, 1500);
    })();
  </script>
</body>
</html>`;
  }

  /**
   * Redirect MCP client back to its redirect URI with an authorization code.
   * @param {import('express').Response} res
   * @param {Object} user
   * @param {Object} mcpAuthPending
   * @private
   */
  _completeMcpAuthorization(res, user, mcpAuthPending) {
    if (!mcpAuthPending) {
      throw new Error('MCP authorization pending state is missing');
    }
    if (typeof mcpAuthPending.state !== 'string' || !mcpAuthPending.state) {
      throw new Error('MCP authorization pending state is missing');
    }

    const code = this.authorizationCodes.issue({
      clientId: mcpAuthPending.client_id,
      redirectUri: mcpAuthPending.redirect_uri,
      codeChallenge: mcpAuthPending.code_challenge,
      user,
      resource: mcpAuthPending.resource
    });

    const rawState = mcpAuthPending.state;
    const redirectTarget = buildAuthorizationRedirectUrl(
      mcpAuthPending.redirect_uri,
      code,
      rawState
    );
    const redirectHost = new URL(mcpAuthPending.redirect_uri).hostname;
    const stateParam = `state=${rawState}`;
    const stateUnchanged = redirectTarget.includes(stateParam);

    this.logger.info?.(
      {
        redirectHost,
        locationLength: redirectTarget.length,
        inboundStateLength: rawState.length,
        outboundStateLength: rawState.length,
        stateUnchanged,
        queryKeys: ['code', 'state']
      },
      'MCP authorization code redirect issued'
    );

    if (this._isHttpRedirectUri(mcpAuthPending.redirect_uri)) {
      return res.redirect(redirectTarget);
    }

    return res
      .status(200)
      .type('html')
      .send(this._renderCustomSchemeOAuthCompletePage(redirectTarget));
  }

  /**
   * Map SDK AuthInfo to legacy req.mcpUser JWT payload shape.
   * @returns {import('express').RequestHandler}
   * @private
   */
  _mcpUserMiddleware() {
    return (req, _res, next) => {
      const user = req.auth?.extra?.user;
      if (user) {
        req.mcpUser = user;
      }
      next();
    };
  }

  /**
   * Express middleware: enforce optional allowlist after JWT verification.
   * @returns {import('express').RequestHandler}
   */
  authorizeMiddleware() {
    return (req, res, next) => {
      if (isUserAllowed(req.mcpUser, this.allowedUsers)) {
        return next();
      }

      this.logger.warn?.(
        userLogFields(req.mcpUser),
        'User not authorized (not on allowlist)'
      );
      return res.status(403).json({
        error: 'forbidden',
        message: 'User not authorized'
      });
    };
  }

  /**
   * Combined Bearer auth + allowlist for protected routes.
   * @returns {import('express').RequestHandler[]}
   */
  protectedMiddleware() {
    const resourceUrl = new URL(`${this.origin}${this.resourcePath}`);
    const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);

    return [
      requireBearerAuth({
        verifier: {
          verifyAccessToken: async (token) => {
            let payload;
            try {
              payload = this.verifyJwt(token);
            } catch (error) {
              throw new InvalidTokenError(error.message);
            }
            if (!payload.jti) {
              throw new InvalidTokenError('JWT payload missing jti claim');
            }
            const active = await this.sessionStore.findActive(payload.jti);
            if (!active) {
              throw new InvalidTokenError('Session expired or revoked');
            }
            if (typeof payload.exp !== 'number') {
              throw new InvalidTokenError('JWT payload missing exp claim');
            }
            return {
              token,
              clientId: payload.sub,
              scopes: ['mcp'],
              expiresAt: payload.exp,
              extra: { user: payload }
            };
          }
        },
        resourceMetadataUrl
      }),
      this._mcpUserMiddleware(),
      this.authorizeMiddleware()
    ];
  }

  _renderLoginPicker(pendingQuery = '') {
    const links = this.enabledProviders
      .map(
        (name) =>
          `<li><a href="${escapeHtml(this.authPath)}/login/${escapeHtml(name)}${pendingQuery}">Login with ${escapeHtml(PROVIDER_META[name].label)}</a></li>`
      )
      .join('\n');
    return `<!DOCTYPE html>
<html>
<head><title>Choose login provider</title></head>
<body>
  <h1>Sign in</h1>
  <ul>${links}</ul>
</body>
</html>`;
  }

  /**
   * @param {Object} user
   * @param {string} token
   * @param {{ sessionId?: string|null }} [options]
   * @returns {string}
   */
  _renderSuccessPage(user, token, options = {}) {
    const displayName = escapeHtml(user.name || user.login);
    const provider = escapeHtml(user.provider);
    const sessionId =
      typeof options.sessionId === 'string' && options.sessionId
        ? escapeHtml(options.sessionId)
        : null;

    let body = `
  <h1>Signed in as ${displayName}</h1>
  <p>Signed in via ${provider}</p>`;

    if (sessionId) {
      body += `
  <p>Session id for host apps: <code>${sessionId}</code></p>`;
    }

    if (this.showTokenOnSuccessPage && token) {
      const safeToken = escapeHtml(token);
      body += `
  <p>Copy this token into your MCP client configuration:</p>
  <pre style="background:#f4f4f4;padding:1em;overflow:auto;">${safeToken}</pre>
  <p>Example <code>mcp.json</code>:</p>
  <pre style="background:#f4f4f4;padding:1em;overflow:auto;">{
  "mcpServers": {
    "my-server": {
      "url": "${escapeHtml(this.expectedResource)}",
      "headers": {
        "Authorization": "Bearer ${safeToken}"
      }
    }
  }
}</pre>`;
    } else {
      body += `
  <p>You can close this tab. MCP clients should complete the OAuth token exchange; host apps can look up the session by session id.</p>`;
    }

    return `<!DOCTYPE html>
<html>
<head><title>Login successful</title></head>
<body>${body}
</body>
</html>`;
  }

  /**
   * RFC 9728 protected resource metadata at site origin (not under /mcp).
   * @param {import('express').Router} router
   * @private
   */
  _registerProtectedResourceMetadataRoute(router) {
    const resourceSuffix = this.resourcePath.replace(/^\//, '');
    const protectedResourcePath = resourceSuffix
      ? `/.well-known/oauth-protected-resource/${resourceSuffix}`
      : '/.well-known/oauth-protected-resource';

    router.get(protectedResourcePath, (_req, res) => {
      res.json(buildProtectedResourceMetadata(this.origin, this.resourcePath, this.issuer));
    });
  }

  /**
   * RFC 8414 path-based AS metadata (+ OIDC aliases) at site origin.
   * For issuer `https://host/mcp`, clients look up
   * `/.well-known/oauth-authorization-server/mcp` (load-bearing for Cursor).
   * OIDC insert-path aliases are defensive fallbacks.
   * @param {import('express').Router} router
   * @private
   */
  _registerPathBasedAuthorizationServerMetadataRoutes(router) {
    const resourceSuffix = this.resourcePath.replace(/^\//, '');
    if (!resourceSuffix) {
      return;
    }

    const sendAsMetadata = (_req, res) => {
      res.json(buildAuthorizationServerMetadata(this.issuer));
    };

    router.get(`/.well-known/oauth-authorization-server/${resourceSuffix}`, sendAsMetadata);
    router.get(`/.well-known/openid-configuration/${resourceSuffix}`, sendAsMetadata);
  }

  /**
   * MCP OAuth authorization server routes (mount under /mcp).
   * @param {import('express').Router} router
   * @private
   */
  _registerAuthorizationServerRoutes(router) {
    const sendAsMetadata = (_req, res) => {
      res.json(buildAuthorizationServerMetadata(this.issuer));
    };

    router.get('/.well-known/oauth-authorization-server', sendAsMetadata);
    // Defensive OIDC alias; under mcpPath becomes /mcp/.well-known/openid-configuration
    router.get('/.well-known/openid-configuration', sendAsMetadata);

    router.post('/register', (req, res) => {
      const { redirect_uris: redirectUris, client_name: clientName, grant_types: grantTypes, response_types: responseTypes } = req.body;

      if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
        return res.status(400).json({
          error: 'invalid_client_metadata',
          error_description: 'redirect_uris is required and must be a non-empty array'
        });
      }

      if (typeof clientName !== 'string' || !clientName.trim()) {
        return res.status(400).json({
          error: 'invalid_client_metadata',
          error_description: 'client_name is required'
        });
      }

      const rejected = redirectUris.filter(
        (uri) =>
          !isRedirectUriAllowedByPolicy(uri, {
            allowedRedirectUris: this.allowedRedirectUris,
            trustedHosts: this.trustedRedirectHosts,
            allowAnyHttps: this.allowAnyHttpsRedirect
          })
      );
      if (rejected.length > 0) {
        this.logger.info?.(
          {
            clientName: clientName.trim(),
            redirectUris,
            rejectedRedirectUris: rejected
          },
          'MCP OAuth client registration rejected'
        );
        return res.status(400).json({
          error: 'invalid_redirect_uri',
          error_description:
            'redirect_uris must be loopback http(s), a private-use URI scheme, an https host in the trusted agent list, or listed in auth.allowedRedirectUris (set auth.allowAnyHttpsRedirect to accept any https)'
        });
      }

      const record = this.oauthClients.register({
        client_name: clientName.trim(),
        redirect_uris: redirectUris,
        grant_types: grantTypes || ['authorization_code'],
        response_types: responseTypes || ['code']
      });

      this.logger.info?.(
        {
          clientId: record.client_id,
          clientName: record.client_name,
          redirectUris,
          rejectedRedirectUris: []
        },
        'MCP OAuth client registered'
      );
      return res.status(201).json(record);
    });

    router.get('/authorize', (req, res) => {
      const {
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: responseType,
        code_challenge: codeChallenge,
        code_challenge_method: codeChallengeMethod,
        resource
      } = req.query;
      const rawState = extractRawQueryParam(req.originalUrl, 'state');

      if (typeof clientId !== 'string' || !clientId) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'client_id is required' });
      }
      if (typeof redirectUri !== 'string' || !redirectUri) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri is required' });
      }
      if (responseType !== 'code') {
        return res.status(400).json({ error: 'unsupported_response_type', error_description: 'Only response_type=code is supported' });
      }
      if (codeChallengeMethod !== 'S256') {
        return res.status(400).json({ error: 'invalid_request', error_description: 'code_challenge_method must be S256' });
      }
      if (typeof codeChallenge !== 'string' || !codeChallenge) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'code_challenge is required' });
      }
      if (typeof rawState !== 'string' || !rawState) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'state is required' });
      }
      if (!this.oauthClients.isRedirectUriAllowed(clientId, redirectUri)) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri is not registered for this client' });
      }

      if (typeof resource === 'string' && resource && resource !== this.expectedResource) {
        return res.status(400).json({
          error: 'invalid_request',
          error_description: 'resource does not match this server'
        });
      }

      const mcpAuthPending = {
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: codeChallenge,
        state: rawState,
        resource: typeof resource === 'string' && resource ? resource : this.expectedResource
      };

      if (this.enabledProviders.length === 1) {
        const provider = this.enabledProviders[0];
        const idpState = this.pendingAuthStore.issue({
          provider,
          mcpAuthPending,
          mcpAuthFlow: true
        });
        return res.redirect(this.getAuthorizationUrl(provider, idpState));
      }

      const idpState = this.pendingAuthStore.issue({
        mcpAuthPending,
        mcpAuthFlow: true,
        requireProviderChoice: true
      });
      return res.redirect(`${this.authPath}/login?pending=${idpState}`);
    });

    router.post('/token', async (req, res) => {
      const {
        grant_type: grantType,
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: codeVerifier,
        refresh_token: refreshToken
      } = req.body;

      if (grantType === 'refresh_token') {
        return this._handleRefreshTokenGrant(req, res, { refreshToken, clientId });
      }

      if (grantType !== 'authorization_code') {
        return res.status(400).json({ error: 'unsupported_grant_type', error_description: 'Only authorization_code and refresh_token are supported' });
      }
      if (typeof code !== 'string' || !code) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'code is required' });
      }
      if (typeof redirectUri !== 'string' || !redirectUri) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri is required' });
      }
      if (typeof clientId !== 'string' || !clientId) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'client_id is required' });
      }
      if (typeof codeVerifier !== 'string' || !codeVerifier) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'code_verifier is required' });
      }

      const authCode = this.authorizationCodes.consume(code);
      if (!authCode) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code is invalid or expired' });
      }
      if (authCode.clientId !== clientId || authCode.redirectUri !== redirectUri) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code does not match client or redirect URI' });
      }
      if (!verifyPkceChallenge(codeVerifier, authCode.codeChallenge)) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
      }

      try {
        const tokens = await this._issueAccessAndRefreshTokens(authCode.user, clientId);
        return res.json(tokens);
      } catch (persistErr) {
        this.logger.error?.(
          { err: persistErr.message, clientId },
          'persistAccessTokenSession failed'
        );
        return res.status(500).json({
          error: 'server_error',
          error_description: 'Failed to persist access token session'
        });
      }
    });
  }

  /**
   * Issue access + refresh tokens and persist both.
   * @param {Object} user
   * @param {string} clientId
   * @returns {Promise<{ access_token: string, token_type: string, expires_in: number, refresh_token: string }>}
   * @private
   */
  async _issueAccessAndRefreshTokens(user, clientId) {
    if (!user || typeof user !== 'object') {
      throw new Error('user is required to issue tokens');
    }
    if (typeof clientId !== 'string' || !clientId) {
      throw new Error('clientId is required to issue tokens');
    }
    if (typeof this.sessionStore.storeRefreshToken !== 'function') {
      throw new Error('sessionStore.storeRefreshToken is required for OAuth refresh tokens');
    }

    const accessToken = this.issueJwt(user);
    await this.persistAccessTokenSession(accessToken, {
      oauth_client_id: clientId,
      oauth_sub: user.sub
    });

    const refreshToken = randomBytes(32).toString('base64url');
    await this.sessionStore.storeRefreshToken(
      refreshToken,
      { user, clientId },
      DEFAULT_REFRESH_TOKEN_TTL_SECONDS
    );

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: jwtExpiresInSeconds(accessToken),
      refresh_token: refreshToken
    };
  }

  /**
   * Handle grant_type=refresh_token.
   * @param {import('express').Request} _req
   * @param {import('express').Response} res
   * @param {{ refreshToken: unknown, clientId: unknown }} params
   * @returns {Promise<void>}
   * @private
   */
  async _handleRefreshTokenGrant(_req, res, { refreshToken, clientId }) {
    if (typeof refreshToken !== 'string' || !refreshToken) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'refresh_token is required' });
    }
    if (typeof clientId !== 'string' || !clientId) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'client_id is required' });
    }
    if (typeof this.sessionStore.findRefreshToken !== 'function' || typeof this.sessionStore.deleteRefreshToken !== 'function') {
      throw new Error('sessionStore refresh token methods are required');
    }

    const stored = await this.sessionStore.findRefreshToken(refreshToken);
    if (!stored) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Refresh token is invalid or expired' });
    }
    if (stored.clientId !== clientId) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Refresh token does not match client' });
    }

    await this.sessionStore.deleteRefreshToken(refreshToken);

    try {
      const tokens = await this._issueAccessAndRefreshTokens(stored.user, clientId);
      return res.json(tokens);
    } catch (persistErr) {
      this.logger.error?.(
        { err: persistErr.message, clientId },
        'persistAccessTokenSession failed'
      );
      return res.status(500).json({
        error: 'server_error',
        error_description: 'Failed to persist access token session'
      });
    }
  }

  /**
   * MCP OAuth 2.1 authorization server routes for MCP clients (DCR, PKCE, metadata).
   * Mount at `/` on the host app (e.g. `app.use(expressMcp.mcpOAuthRouter())`).
   * @param {Object} [sessionOptions] - Passed to express-session (except secret)
   * @returns {import('express').Router}
   */
  createMcpOAuthRouter(sessionOptions = {}) {
    const router = Router();
    router.use(express.json());
    router.use(express.urlencoded({ extended: false }));
    router.use(this._sessionMiddleware(sessionOptions));
    this._registerProtectedResourceMetadataRoute(router);
    this._registerPathBasedAuthorizationServerMetadataRoutes(router);
    this._registerAuthorizationServerRoutes(router);
    return router;
  }

  /**
   * Register IdP browser login routes on a router (mount at /auth).
   * @param {import('express').Router} router
   * @private
   */
  _registerAuthRoutes(router) {
    if (this.enableDebugEndpoint) {
      router.get('/debug', (req, res) => {
        const providers = this.enabledProviders.map((name) => {
          const url = this.getAuthorizationUrl(name, 'debug');
          const parsed = new URL(url);
          return {
            name,
            label: PROVIDER_META[name].label,
            clientId: this.providers[name].clientId,
            redirectUri: parsed.searchParams.get('redirect_uri'),
            authorizeUrl: url
          };
        });

        res.json({
          callbackUrl: this.callbackUrl,
          enabledProviders: this.enabledProviders,
          providers
        });
      });
    }

    router.get('/login', (req, res) => {
      const pendingQuery =
        typeof req.query.pending === 'string' && req.query.pending
          ? `?pending=${encodeURIComponent(req.query.pending)}`
          : '';

      if (this.enabledProviders.length === 1) {
        return res.redirect(`${this.authPath}/login/${this.enabledProviders[0]}${pendingQuery}`);
      }
      res.send(this._renderLoginPicker(pendingQuery));
    });

    router.post('/login-url', async (req, res) => {
      const { provider, context } = req.body || {};
      let sanitized;
      try {
        sanitized = sanitizeHostContext(context);
      } catch (err) {
        return res.status(400).json({
          error: 'invalid_request',
          error_description: err.message
        });
      }

      const oauthProvider =
        typeof provider === 'string' && this.enabledProviders.includes(provider)
          ? provider
          : this.enabledProviders[0];

      const sessionId = randomUUID();
      try {
        await this.sessionStore.createPending(
          sessionId,
          sanitized,
          oauthProvider,
          this._pendingSessionTtlSeconds()
        );
      } catch (err) {
        return res.status(400).json({
          error: 'invalid_request',
          error_description: err.message
        });
      }

      const loginUrl = new URL(
        `${this.origin}${this.authPath}/login/${oauthProvider}`,
        this.origin
      );
      loginUrl.searchParams.set('session_id', sessionId);

      return res.json({
        session_id: sessionId,
        login_url: loginUrl.toString()
      });
    });

    router.get('/login/:provider', async (req, res) => {
      const { provider } = req.params;
      if (!this.enabledProviders.includes(provider)) {
        return res.status(404).send(
          `<html><body><h1>Unknown provider</h1><p>Provider "${escapeHtml(provider)}" is not enabled.</p></body></html>`
        );
      }

      const pendingId = typeof req.query.pending === 'string' ? req.query.pending : null;
      if (pendingId) {
        const existing = this.pendingAuthStore.get(pendingId);
        if (!existing || !existing.requireProviderChoice || !existing.mcpAuthPending) {
          return res.status(400).send(
            `<html><body><h1>Invalid login</h1><p>Pending MCP authorization expired or is invalid. Start again from ${this.authPath}/login.</p></body></html>`
          );
        }
        this.pendingAuthStore.consume(pendingId);
        const idpState = this.pendingAuthStore.issue({
          provider,
          mcpAuthPending: existing.mcpAuthPending,
          mcpAuthFlow: true
        });
        return res.redirect(this.getAuthorizationUrl(provider, idpState));
      }

      const sessionId =
        typeof req.query.session_id === 'string' ? req.query.session_id : null;
      if (sessionId) {
        try {
          assertValidSessionId(sessionId);
          const pending = await this.sessionStore.peekPending(sessionId);
          if (!pending || pending.provider !== provider) {
            return res.status(400).send(
              '<html><body><h1>Invalid or expired login link</h1><p>Request a new one.</p></body></html>'
            );
          }
          if (pending.purpose === 'google_grant') {
            if (provider !== 'google') {
              return res.status(400).send(
                '<html><body><h1>Invalid grant link</h1><p>Google grant requires the google provider.</p></body></html>'
              );
            }
            return res.redirect(
              this.getAuthorizationUrl(provider, sessionId, {
                extraScopes: pending.scopes,
                accessType: 'offline',
                prompt: 'consent',
                includeGrantedScopes: true
              })
            );
          }
          return res.redirect(this.getAuthorizationUrl(provider, sessionId));
        } catch {
          return res.status(400).send(
            '<html><body><h1>Invalid or expired login link</h1><p>Request a new one.</p></body></html>'
          );
        }
      }

      const state = randomBytes(16).toString('hex');
      req.session.oauthProvider = provider;
      req.session.oauthState = state;
      req.session.loginContext = {};
      const url = this.getAuthorizationUrl(provider, state);
      res.redirect(url);
    });

    router.get('/callback', async (req, res) => {
      const { code, state, error, error_description: errorDescription } = req.query;

      if (error) {
        return res.status(400).send(
          `<html><body><h1>Authentication failed</h1><p>${escapeHtml(error)}: ${escapeHtml(errorDescription || '')}</p></body></html>`
        );
      }

      if (typeof state !== 'string' || !state) {
        return res.status(400).send(
          '<html><body><h1>Invalid callback</h1><p>Missing state parameter.</p></body></html>'
        );
      }

      if (typeof code !== 'string' || !code) {
        return res.status(400).send(
          '<html><body><h1>Invalid callback</h1><p>Missing authorization code.</p></body></html>'
        );
      }

      const pending = this.pendingAuthStore.consume(state);
      let oauthProvider;
      let mcpAuthFlow = false;
      let mcpAuthPending = null;
      /** @type {{ context: Record<string, string>, provider: string }|null} */
      let standalonePending = null;

      if (pending) {
        if (!pending.provider || !this.enabledProviders.includes(pending.provider)) {
          return res.status(400).send(
            `<html><body><h1>Invalid callback</h1><p>Unknown OAuth provider in pending state. Start login again from ${this.authPath}/login.</p></body></html>`
          );
        }
        oauthProvider = pending.provider;
        mcpAuthFlow = pending.mcpAuthFlow === true;
        mcpAuthPending = pending.mcpAuthPending || null;
      } else if (this.sessionStore && isUuidV4SessionId(state)) {
        standalonePending = await this.sessionStore.consumePending(state);
        if (!standalonePending) {
          return res.status(400).send(
            '<html><body><h1>Invalid callback</h1><p>Login session expired or already used. Request a new login link.</p></body></html>'
          );
        }
        oauthProvider = standalonePending.provider;
      } else {
        oauthProvider = req.session.oauthProvider;
        if (!oauthProvider || !this.enabledProviders.includes(oauthProvider)) {
          return res.status(400).send(
            `<html><body><h1>Invalid callback</h1><p>Missing or expired OAuth state. Start login again from ${this.authPath}/login.</p></body></html>`
          );
        }
        if (state !== req.session.oauthState) {
          return res.status(400).send(
            '<html><body><h1>Invalid callback</h1><p>Missing or invalid state parameter.</p></body></html>'
          );
        }
        delete req.session.oauthState;
        delete req.session.oauthProvider;
        mcpAuthFlow = req.session.mcpAuthFlow === true;
        mcpAuthPending = req.session.mcpAuthPending || null;
        delete req.session.mcpAuthFlow;
        delete req.session.mcpAuthPending;
      }

      try {
        const { user, tokenResponse } = await this.exchangeCodeForUser(oauthProvider, code);

        if (!isUserAllowed(user, this.allowedUsers)) {
          this.logger.warn?.(userLogFields(user), 'OAuth login denied (not on allowlist)');
          return res.status(403).send(
            '<html><body><h1>Not authorized</h1><p>Your account is not allowed to use this MCP server.</p></body></html>'
          );
        }

        if (
          standalonePending &&
          standalonePending.purpose === 'google_grant' &&
          oauthProvider === 'google'
        ) {
          try {
            await this.persistGoogleIdpGrant(
              user.sub,
              tokenResponse,
              standalonePending.scopes || []
            );
          } catch (grantErr) {
            this.logger.error?.(
              { err: grantErr.message, provider: oauthProvider, sub: user.sub },
              'Failed to persist Google IdP grant'
            );
            return res.status(500).send(
              `<html><body><h1>Grant failed</h1><p>${escapeHtml(grantErr.message)}</p></body></html>`
            );
          }
          if (this.postLoginRedirectUrl) {
            return res.redirect(this.postLoginRedirectUrl);
          }
          return res.send(
            `<html><body><h1>Google Contacts connected</h1><p>Signed in as ${escapeHtml(user.email || user.login)}. You can close this window.</p></body></html>`
          );
        }

        if (mcpAuthFlow && mcpAuthPending) {
          return this._completeMcpAuthorization(res, user, mcpAuthPending);
        }

        const token = this.issueJwt(user);
        const sessionUser = this.verifyJwt(token);
        const ctx = standalonePending
          ? standalonePending.context
          : req.session.loginContext || {};
        delete req.session.loginContext;

        if (standalonePending) {
          try {
            await this.sessionStore.activate(
              state,
              sessionUser,
              this._activeSessionTtlSeconds(),
              ctx
            );
          } catch (storeErr) {
            this.logger.error?.(
              { err: storeErr.message, provider: oauthProvider },
              'sessionStore activate failed'
            );
          }
        }

        if (this.onTokenIssued) {
          try {
            await this.onTokenIssued(user, token, ctx);
          } catch (callbackErr) {
            this.logger.error?.(
              { err: callbackErr.message, provider: oauthProvider },
              'onTokenIssued callback failed'
            );
          }
        }
        if (this.postLoginRedirectUrl) {
          return res.redirect(this.postLoginRedirectUrl);
        }
        res.send(
          this._renderSuccessPage(user, token, {
            sessionId: standalonePending ? state : null
          })
        );
      } catch (err) {
        this.logger.error?.({ err: err.message, provider: oauthProvider }, 'OAuth callback failed');
        res.status(500).send(
          `<html><body><h1>Authentication failed</h1><p>${escapeHtml(err.message)}</p></body></html>`
        );
      }
    });

    router.post('/google-grant-url', async (req, res) => {
      try {
        const { scopes, context, sub } = req.body || {};
        const result = await this.createGoogleGrantUrl({ scopes, context, sub });
        return res.json(result);
      } catch (err) {
        return res.status(400).json({
          error: 'invalid_request',
          error_description: err.message
        });
      }
    });

    router.get('/logout', (req, res) => {
      req.session.destroy(() => {
        res.json({ success: true, message: 'Session cleared' });
      });
    });

    router.get('/me', ...this.protectedMiddleware(), (req, res) => {
      res.json({ user: req.mcpUser });
    });
  }

  /**
   * Create Express router for OAuth login flow and session helpers.
   * Mount at `/auth` (e.g. `app.use('/auth', authManager.createAuthRouter())`).
   * @param {Object} [sessionOptions] - Passed to express-session (except secret)
   * @returns {import('express').Router}
   */
  createAuthRouter(sessionOptions = {}) {
    const router = Router();
    router.use(this._sessionMiddleware(sessionOptions));
    this._registerAuthRoutes(router);
    return router;
  }

  /**
   * Combined HTTP router: PRM at site root; MCP OAuth AS, IdP, and protocol under mcpPath.
   * @param {Object} options
   * @param {import('express').Router} options.mcpRouter - MCP JSON-RPC router from ExpressMcp.router()
   * @param {string} [options.mcpPath='/mcp'] - Mount path for MCP OAuth, IdP, and protocol
   * @param {Object} [options.sessionOptions] - Passed to express-session (except secret)
   * @returns {import('express').Router}
   */
  createHttpRouter({ mcpRouter, mcpPath = '/mcp', sessionOptions = {} }) {
    if (!mcpRouter) {
      throw new Error('mcpRouter is required for createHttpRouter');
    }

    this.authPath = `${mcpPath}/auth`;

    const root = Router();
    root.use(express.json());
    root.use(express.urlencoded({ extended: false }));
    root.use(this._sessionMiddleware(sessionOptions));

    this._registerProtectedResourceMetadataRoute(root);
    this._registerPathBasedAuthorizationServerMetadataRoutes(root);

    // Some MCP clients (e.g. Cursor) still call OAuth AS routes at site root even when
    // issuer is under mcpPath. Canonical routes remain under mcpPath; these are aliases.
    this._registerAuthorizationServerRoutes(root);

    const mcpMount = Router();
    this._registerAuthorizationServerRoutes(mcpMount);

    const authRouter = Router();
    this._registerAuthRoutes(authRouter);
    mcpMount.use('/auth', authRouter);

    mcpMount.use('/', mcpRouter);

    root.use(mcpPath, mcpMount);
    return root;
  }
}
