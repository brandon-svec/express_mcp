import { assert } from 'chai';
import { createHash, randomBytes } from 'crypto';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { AuthManager } from '../../src/classes/authManager.js';
import {
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
  buildWwwAuthenticateHeader,
  verifyPkceChallenge
} from '../../src/mcpOAuth.js';

const JWT_SECRET = 'test-jwt-secret';
const SESSION_SECRET = 'test-session-secret';
const ISSUER = 'http://localhost:3000';

function createAuthManager() {
  return new AuthManager({
    providers: {
      github: { clientId: 'gh-id', clientSecret: 'gh-secret' }
    },
    callbackUrl: `${ISSUER}/auth/callback`,
    issuer: ISSUER,
    jwtSecret: JWT_SECRET,
    sessionSecret: SESSION_SECRET,
    jwtExpiresIn: '1h',
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  });
}

function createOAuthApp(authManager) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(authManager.createMcpOAuthRouter());
  app.use('/auth', authManager.createAuthRouter());
  app.post('/mcp', ...authManager.protectedMiddleware(), (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('MCP OAuth authorization server', () => {
  it('builds protected resource metadata', () => {
    assert.deepEqual(buildProtectedResourceMetadata(ISSUER, '/mcp'), {
      resource: `${ISSUER}/mcp`,
      authorization_servers: [ISSUER],
      scopes_supported: ['mcp'],
      bearer_methods_supported: ['header']
    });
  });

  it('builds authorization server metadata', () => {
    assert.deepEqual(buildAuthorizationServerMetadata(ISSUER), {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      registration_endpoint: `${ISSUER}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none']
    });
  });

  it('verifies PKCE S256 challenges', () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    assert.strictEqual(verifyPkceChallenge(verifier, challenge), true);
    assert.strictEqual(verifyPkceChallenge('wrong', challenge), false);
  });

  it('registers MCP OAuth clients via POST /register', async () => {
    const app = createOAuthApp(createAuthManager());
    const res = await request(app)
      .post('/register')
      .send({
        client_name: 'Cursor',
        redirect_uris: ['cursor://anysphere.cursor-mcp/oauth/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code']
      });

    assert.strictEqual(res.status, 201);
    assert.property(res.body, 'client_id');
    assert.deepEqual(res.body.redirect_uris, ['cursor://anysphere.cursor-mcp/oauth/callback']);
  });

  it('returns protected resource and authorization server metadata', async () => {
    const app = createOAuthApp(createAuthManager());

    const prm = await request(app).get('/.well-known/oauth-protected-resource/mcp');
    assert.strictEqual(prm.status, 200);
    assert.strictEqual(prm.body.resource, `${ISSUER}/mcp`);

    const asm = await request(app).get('/.well-known/oauth-authorization-server');
    assert.strictEqual(asm.status, 200);
    assert.strictEqual(asm.body.registration_endpoint, `${ISSUER}/register`);
  });

  it('returns WWW-Authenticate on unauthorized MCP requests', async () => {
    const app = createOAuthApp(createAuthManager());
    const res = await request(app).post('/mcp').send({ jsonrpc: '2.0', method: 'initialize', id: 1 });

    assert.strictEqual(res.status, 401);
    assert.strictEqual(
      res.headers['www-authenticate'],
      buildWwwAuthenticateHeader(ISSUER, '/mcp')
    );
  });

  it('exchanges authorization code for access token', async () => {
    const authManager = createAuthManager();
    const user = {
      sub: 'gh:1',
      login: 'test-user',
      name: 'Test User',
      email: 'test@example.com',
      provider: 'github'
    };
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const client = authManager.oauthClients.register({
      client_name: 'Cursor',
      redirect_uris: ['cursor://callback'],
      grant_types: ['authorization_code'],
      response_types: ['code']
    });
    const code = authManager.authorizationCodes.issue({
      clientId: client.client_id,
      redirectUri: 'cursor://callback',
      codeChallenge,
      user,
      resource: `${ISSUER}/mcp`
    });

    const app = createOAuthApp(authManager);
    const res = await request(app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'cursor://callback',
        client_id: client.client_id,
        code_verifier: codeVerifier
      });

    assert.strictEqual(res.status, 200);
    assert.property(res.body, 'access_token');
    assert.strictEqual(res.body.token_type, 'Bearer');
    assert.isAbove(res.body.expires_in, 0);

    const payload = jwt.verify(res.body.access_token, JWT_SECRET);
    assert.strictEqual(payload.login, 'test-user');
  });
});
