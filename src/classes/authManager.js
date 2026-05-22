import { Router } from 'express';
import session from 'express-session';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'crypto';
import { isUserAllowed, userLogFields } from '../authz.js';

export const SUPPORTED_OAUTH_PROVIDERS = ['github', 'google'];

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
   * @param {Object} [options.logger] - Logger with info, warn, error, debug
   * @param {string[]} [options.allowedUsers] - Optional email/login allowlist (empty = allow all)
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
   * @returns {string}
   */
  getAuthorizationUrl(provider, state) {
    const { clientId, meta } = this._getProviderCredentials(provider);

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: this.callbackUrl,
      scope: meta.scopes.join(' '),
      state
    });

    if (provider === 'google') {
      params.set('response_type', 'code');
      params.set('access_type', 'online');
      params.set('prompt', 'select_account');
    }

    return `${meta.authorizeUrl}?${params.toString()}`;
  }

  /**
   * Exchange authorization code for user profile from the provider.
   * @param {string} provider
   * @param {string} code
   * @returns {Promise<Object>} Normalized user object
   */
  async exchangeCodeForUser(provider, code) {
    const accessToken = await this._exchangeCodeForToken(provider, code);
    const profile = await this._fetchUserProfile(provider, accessToken);
    return normalizeUser(provider, profile);
  }

  /**
   * @param {string} provider
   * @param {string} code
   * @returns {Promise<string>}
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

    return data.access_token;
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
      sub: user.sub,
      login: user.login,
      name: user.name,
      email: user.email,
      provider: user.provider
    };

    return jwt.sign(payload, this.jwtSecret, {
      expiresIn: this.jwtExpiresIn
    });
  }

  /**
   * Verify and decode a JWT.
   * @param {string} token
   * @returns {Object} Decoded payload
   */
  verifyJwt(token) {
    return jwt.verify(token, this.jwtSecret);
  }

  /**
   * Express middleware: require Bearer JWT and set req.mcpUser.
   * @returns {import('express').RequestHandler}
   */
  bearerAuthMiddleware() {
    return (req, res, next) => {
      const authHeader = req.headers.authorization;

      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
          error: 'unauthorized',
          message: 'Authorization required. Use Bearer token.'
        });
      }

      const token = authHeader.slice(7).trim();

      try {
        req.mcpUser = this.verifyJwt(token);
        return next();
      } catch (error) {
        this.logger.debug?.({ err: error.message }, 'JWT verification failed');
        return res.status(401).json({
          error: 'unauthorized',
          message: 'Invalid or expired token'
        });
      }
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
    return [this.bearerAuthMiddleware(), this.authorizeMiddleware()];
  }

  _renderLoginPicker() {
    const links = this.enabledProviders
      .map(
        (name) =>
          `<li><a href="/auth/login/${name}">Login with ${PROVIDER_META[name].label}</a></li>`
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

  _renderSuccessPage(user, token) {
    const displayName = user.name || user.login;
    return `<!DOCTYPE html>
<html>
<head><title>Login successful</title></head>
<body>
  <h1>Signed in as ${displayName}</h1>
  <p>Signed in via ${user.provider}</p>
  <p>Copy this token into your MCP client configuration:</p>
  <pre style="background:#f4f4f4;padding:1em;overflow:auto;">${token}</pre>
  <p>Example <code>mcp.json</code>:</p>
  <pre style="background:#f4f4f4;padding:1em;overflow:auto;">{
  "mcpServers": {
    "my-server": {
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer ${token}"
      }
    }
  }
}</pre>
</body>
</html>`;
  }

  /**
   * Create Express router for OAuth login flow and session helpers.
   * Mount at `/auth` (e.g. `app.use('/auth', authManager.createAuthRouter())`).
   * @param {Object} [sessionOptions] - Passed to express-session (except secret)
   * @returns {import('express').Router}
   */
  createAuthRouter(sessionOptions = {}) {
    const router = Router();

    router.use(
      session({
        secret: this.sessionSecret,
        resave: false,
        saveUninitialized: false,
        cookie: {
          secure: process.env.NODE_ENV === 'production',
          httpOnly: true,
          maxAge: 15 * 60 * 1000
        },
        ...sessionOptions
      })
    );

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

    router.get('/login', (req, res) => {
      if (this.enabledProviders.length === 1) {
        return res.redirect(`/auth/login/${this.enabledProviders[0]}`);
      }
      res.send(this._renderLoginPicker());
    });

    router.get('/login/:provider', (req, res) => {
      const { provider } = req.params;
      if (!this.enabledProviders.includes(provider)) {
        return res.status(404).send(
          `<html><body><h1>Unknown provider</h1><p>Provider "${provider}" is not enabled.</p></body></html>`
        );
      }

      const state = randomBytes(16).toString('hex');
      req.session.oauthProvider = provider;
      req.session.oauthState = state;
      const url = this.getAuthorizationUrl(provider, state);
      res.redirect(url);
    });

    router.get('/callback', async (req, res) => {
      const { code, state, error, error_description: errorDescription } = req.query;
      const oauthProvider = req.session.oauthProvider;

      if (error) {
        return res.status(400).send(
          `<html><body><h1>Authentication failed</h1><p>${error}: ${errorDescription || ''}</p></body></html>`
        );
      }

      if (!oauthProvider || !this.enabledProviders.includes(oauthProvider)) {
        return res.status(400).send(
          '<html><body><h1>Invalid callback</h1><p>Missing or unknown OAuth provider in session. Start login again from /auth/login.</p></body></html>'
        );
      }

      if (!code || !state || state !== req.session.oauthState) {
        return res.status(400).send(
          '<html><body><h1>Invalid callback</h1><p>Missing or invalid state parameter.</p></body></html>'
        );
      }

      delete req.session.oauthState;
      delete req.session.oauthProvider;

      try {
        const user = await this.exchangeCodeForUser(oauthProvider, code);

        if (!isUserAllowed(user, this.allowedUsers)) {
          this.logger.warn?.(userLogFields(user), 'OAuth login denied (not on allowlist)');
          return res.status(403).send(
            '<html><body><h1>Not authorized</h1><p>Your account is not allowed to use this MCP server.</p></body></html>'
          );
        }

        const token = this.issueJwt(user);
        res.send(this._renderSuccessPage(user, token));
      } catch (err) {
        this.logger.error?.({ err: err.message, provider: oauthProvider }, 'OAuth callback failed');
        res.status(500).send(
          `<html><body><h1>Authentication failed</h1><p>${err.message}</p></body></html>`
        );
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

    return router;
  }
}
