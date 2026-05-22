import { Router } from 'express';
import session from 'express-session';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'crypto';

const PROVIDERS = {
  github: {
    scopes: ['read:user', 'user:email'],
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userUrl: 'https://api.github.com/user',
    emailsUrl: 'https://api.github.com/user/emails'
  },
  google: {
    scopes: ['openid', 'email', 'profile'],
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userUrl: 'https://openidconnect.googleapis.com/v1/userinfo'
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
   * @param {string} options.provider - 'github' | 'google'
   * @param {string} options.clientId
   * @param {string} options.clientSecret
   * @param {string} options.callbackUrl - Full redirect URI registered with the provider
   * @param {string} options.jwtSecret
   * @param {string} [options.jwtExpiresIn='7d']
   * @param {string} options.sessionSecret
   * @param {Object} [options.logger] - Logger with info, warn, error, debug
   */
  constructor(options) {
    const provider = options.provider || 'github';
    if (!PROVIDERS[provider]) {
      throw new Error(`Unsupported auth provider: ${provider}. Use 'github' or 'google'.`);
    }

    this.provider = provider;
    this.providerConfig = PROVIDERS[provider];
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.callbackUrl = options.callbackUrl;
    this.jwtSecret = options.jwtSecret;
    this.jwtExpiresIn = options.jwtExpiresIn || '7d';
    this.sessionSecret = options.sessionSecret;
    this.logger = options.logger || console;
  }

  /**
   * Build OAuth authorization URL for the configured provider.
   * @param {string} state - CSRF state value
   * @returns {string}
   */
  getAuthorizationUrl(state) {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.callbackUrl,
      scope: this.providerConfig.scopes.join(' '),
      state
    });

    if (this.provider === 'google') {
      params.set('response_type', 'code');
      params.set('access_type', 'online');
      params.set('prompt', 'select_account');
    }

    return `${this.providerConfig.authorizeUrl}?${params.toString()}`;
  }

  /**
   * Exchange authorization code for user profile from the provider.
   * @param {string} code
   * @returns {Promise<Object>} Normalized user object
   */
  async exchangeCodeForUser(code) {
    const accessToken = await this._exchangeCodeForToken(code);
    const profile = await this._fetchUserProfile(accessToken);
    return normalizeUser(this.provider, profile);
  }

  /**
   * @param {string} code
   * @returns {Promise<string>}
   * @private
   */
  async _exchangeCodeForToken(code) {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      redirect_uri: this.callbackUrl,
      grant_type: 'authorization_code'
    });

    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    };

    const response = await fetch(this.providerConfig.tokenUrl, {
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
   * @param {string} accessToken
   * @returns {Promise<Object>}
   * @private
   */
  async _fetchUserProfile(accessToken) {
    const response = await fetch(this.providerConfig.userUrl, {
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

    if (this.provider === 'github' && !profile.email) {
      profile.email = await this._fetchGitHubPrimaryEmail(accessToken);
    }

    return profile;
  }

  /**
   * @param {string} accessToken
   * @returns {Promise<string|null>}
   * @private
   */
  async _fetchGitHubPrimaryEmail(accessToken) {
    const response = await fetch(this.providerConfig.emailsUrl, {
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

    router.get('/login', (req, res) => {
      const state = randomBytes(16).toString('hex');
      req.session.oauthState = state;
      const url = this.getAuthorizationUrl(state);
      res.redirect(url);
    });

    router.get('/callback', async (req, res) => {
      const { code, state, error, error_description: errorDescription } = req.query;

      if (error) {
        return res.status(400).send(
          `<html><body><h1>Authentication failed</h1><p>${error}: ${errorDescription || ''}</p></body></html>`
        );
      }

      if (!code || !state || state !== req.session.oauthState) {
        return res.status(400).send(
          '<html><body><h1>Invalid callback</h1><p>Missing or invalid state parameter.</p></body></html>'
        );
      }

      delete req.session.oauthState;

      try {
        const user = await this.exchangeCodeForUser(code);
        const token = this.issueJwt(user);

        const displayName = user.name || user.login;
        res.send(`<!DOCTYPE html>
<html>
<head><title>Login successful</title></head>
<body>
  <h1>Signed in as ${displayName}</h1>
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
</html>`);
      } catch (err) {
        this.logger.error?.({ err: err.message }, 'OAuth callback failed');
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

    router.get('/me', this.bearerAuthMiddleware(), (req, res) => {
      res.json({ user: req.mcpUser });
    });

    return router;
  }
}
