import { assert } from 'chai';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import {
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
  PendingAuthStore,
  verifyPkceChallenge
} from '../../src/mcpOAuth.js';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { createInitializeRequest, mcpPost } from '../config.js';
import {
  createOAuthTestApp,
  createPkcePair,
  createTestAuthManager,
  mockExchangeCodeForUser,
  registerOAuthTestClient,
  TEST_AUTH,
  TEST_GITHUB_USER
} from '../authTestUtils.js';

describe('MCP OAuth authorization server', () => {
  it('builds protected resource metadata', () => {
    assert.deepEqual(buildProtectedResourceMetadata(TEST_AUTH.origin, TEST_AUTH.resourcePath, TEST_AUTH.issuer), {
      resource: `${TEST_AUTH.origin}/mcp`,
      authorization_servers: [TEST_AUTH.issuer],
      scopes_supported: ['mcp'],
      bearer_methods_supported: ['header']
    });
  });

  it('builds authorization server metadata', () => {
    assert.deepEqual(buildAuthorizationServerMetadata(TEST_AUTH.issuer), {
      issuer: TEST_AUTH.issuer,
      authorization_endpoint: `${TEST_AUTH.issuer}/authorize`,
      token_endpoint: `${TEST_AUTH.issuer}/token`,
      registration_endpoint: `${TEST_AUTH.issuer}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none']
    });
  });

  it('issues and consumes pending auth state', () => {
    const store = new PendingAuthStore();
    const id = store.issue({
      provider: 'google',
      mcpAuthFlow: true,
      mcpAuthPending: { client_id: 'c1', state: 's1' }
    });
    assert.isString(id);
    assert.deepEqual(store.get(id), {
      provider: 'google',
      mcpAuthFlow: true,
      mcpAuthPending: { client_id: 'c1', state: 's1' },
      expiresAt: store.get(id).expiresAt
    });
    const consumed = store.consume(id);
    assert.strictEqual(consumed.provider, 'google');
    assert.isNull(store.get(id));
    assert.isNull(store.consume(id));
  });

  it('stores pending auth on authorize and completes callback without session cookie', async () => {
    const authManager = createTestAuthManager();
    const { codeChallenge } = createPkcePair();
    const client = registerOAuthTestClient(authManager);
    const mcpClientState = 'mcp-client-state-xyz';

    mockExchangeCodeForUser(authManager);

    const app = createOAuthTestApp(authManager);
    const authorizeRes = await request(app)
      .get('/mcp/authorize')
      .query({
        client_id: client.client_id,
        redirect_uri: 'cursor://callback',
        response_type: 'code',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state: mcpClientState
      });
    assert.strictEqual(authorizeRes.status, 302);
    const idpState = new URL(authorizeRes.headers.location).searchParams.get('state');
    assert.isString(idpState);
    assert.isNotNull(authManager.pendingAuthStore.get(idpState));

    const callbackRes = await request(app)
      .get('/mcp/auth/callback')
      .query({ state: idpState, code: 'github-auth-code' });

    assert.strictEqual(callbackRes.status, 200);
    assert.include(callbackRes.headers['content-type'], 'text/html');
    assert.include(callbackRes.text, 'cursor://callback');
    assert.include(callbackRes.text, 'window.close');
    assert.include(callbackRes.text, `state=${mcpClientState}`);
    const codeMatch = callbackRes.text.match(/code=([A-Za-z0-9_-]+)/);
    assert.isNotNull(codeMatch);
  });

  it('uses HTTP redirect for https redirect_uri callbacks', async () => {
    const authManager = createTestAuthManager();
    const { codeChallenge } = createPkcePair();
    const client = registerOAuthTestClient(authManager, 'https://example.com/oauth/callback');
    const mcpClientState = 'web-client-state';

    mockExchangeCodeForUser(authManager);

    const app = createOAuthTestApp(authManager);
    const authorizeRes = await request(app)
      .get('/mcp/authorize')
      .query({
        client_id: client.client_id,
        redirect_uri: 'https://example.com/oauth/callback',
        response_type: 'code',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state: mcpClientState
      });
    assert.strictEqual(authorizeRes.status, 302);
    const idpState = new URL(authorizeRes.headers.location).searchParams.get('state');

    const callbackRes = await request(app)
      .get('/mcp/auth/callback')
      .query({ state: idpState, code: 'github-auth-code' });

    assert.strictEqual(callbackRes.status, 302);
    assert.include(callbackRes.headers.location, 'https://example.com/oauth/callback');
    const callbackUrl = new URL(callbackRes.headers.location);
    assert.strictEqual(callbackUrl.searchParams.get('state'), mcpClientState);
    assert.isString(callbackUrl.searchParams.get('code'));
  });

  it('verifies PKCE S256 challenges', () => {
    const { codeVerifier, codeChallenge } = createPkcePair();
    assert.strictEqual(verifyPkceChallenge(codeVerifier, codeChallenge), true);
    assert.strictEqual(verifyPkceChallenge('wrong', codeChallenge), false);
  });

  it('registers MCP OAuth clients via POST /register', async () => {
    const app = createOAuthTestApp(createTestAuthManager());
    const res = await request(app)
      .post('/mcp/register')
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

  it('rejects non-loopback http(s) redirect_uris unless allowlisted', async () => {
    const app = createOAuthTestApp(createTestAuthManager());
    const rejected = await request(app)
      .post('/mcp/register')
      .send({
        client_name: 'Evil',
        redirect_uris: ['https://evil.example/cb'],
        grant_types: ['authorization_code'],
        response_types: ['code']
      });
    assert.strictEqual(rejected.status, 400);
    assert.strictEqual(rejected.body.error, 'invalid_redirect_uri');

    const allowed = createOAuthTestApp(
      createTestAuthManager({ allowedRedirectUris: ['https://app.example/cb'] })
    );
    const ok = await request(allowed)
      .post('/mcp/register')
      .send({
        client_name: 'App',
        redirect_uris: ['https://app.example/cb'],
        grant_types: ['authorization_code'],
        response_types: ['code']
      });
    assert.strictEqual(ok.status, 201);
  });

  it('returns protected resource and authorization server metadata', async () => {
    const app = createOAuthTestApp(createTestAuthManager());

    const prm = await request(app).get('/.well-known/oauth-protected-resource/mcp');
    assert.strictEqual(prm.status, 200);
    assert.strictEqual(prm.body.resource, `${TEST_AUTH.origin}/mcp`);

    const asm = await request(app).get('/mcp/.well-known/oauth-authorization-server');
    assert.strictEqual(asm.status, 200);
    assert.strictEqual(asm.body.registration_endpoint, `${TEST_AUTH.issuer}/register`);

    // Load-bearing RFC 8414 path (Cursor after PRM)
    const pathAs = await request(app).get('/.well-known/oauth-authorization-server/mcp');
    assert.strictEqual(pathAs.status, 200);
    assert.strictEqual(pathAs.body.issuer, TEST_AUTH.issuer);
    assert.deepEqual(pathAs.body, asm.body);

    // Defensive OIDC aliases
    const pathOidc = await request(app).get('/.well-known/openid-configuration/mcp');
    assert.strictEqual(pathOidc.status, 200);
    assert.deepEqual(pathOidc.body, asm.body);

    const mcpOidc = await request(app).get('/mcp/.well-known/openid-configuration');
    assert.strictEqual(mcpOidc.status, 200);
    assert.deepEqual(mcpOidc.body, asm.body);
  });

  it('returns WWW-Authenticate on unauthorized MCP requests', async () => {
    const app = createOAuthTestApp(createTestAuthManager());
    const res = await mcpPost(request(app)).send(createInitializeRequest(1));

    assert.strictEqual(res.status, 401);
    assert.include(
      res.headers['www-authenticate'],
      getOAuthProtectedResourceMetadataUrl(new URL(`${TEST_AUTH.origin}/mcp`))
    );
  });

  it('exchanges authorization code for access token', async () => {
    const authManager = createTestAuthManager();
    const { codeVerifier, codeChallenge } = createPkcePair();
    const client = registerOAuthTestClient(authManager);
    const code = authManager.authorizationCodes.issue({
      clientId: client.client_id,
      redirectUri: 'cursor://callback',
      codeChallenge,
      user: TEST_GITHUB_USER,
      resource: `${TEST_AUTH.origin}/mcp`
    });

    const app = createOAuthTestApp(authManager);
    const res = await request(app)
      .post('/mcp/token')
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

    const payload = jwt.verify(res.body.access_token, TEST_AUTH.jwtSecret);
    assert.strictEqual(payload.login, TEST_GITHUB_USER.login);
    assert.isString(payload.jti);

    const active = await authManager.sessionStore.findActive(payload.jti);
    assert.isNotNull(active);
    assert.strictEqual(active.user.login, TEST_GITHUB_USER.login);
    assert.strictEqual(active.context.oauth_client_id, client.client_id);
    assert.strictEqual(active.context.oauth_sub, TEST_GITHUB_USER.sub);
  });
});
