import { assert } from 'chai';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import {
  buildAuthorizationRedirectUrl,
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
  extractRawQueryParam,
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
  silentTestLogger,
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
      grant_types_supported: ['authorization_code', 'refresh_token'],
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

  it('rejects unknown remote https redirect_uris unless allowlisted or allowAnyHttps', async () => {
    const logs = [];
    const logger = {
      ...silentTestLogger,
      info: (fields, message) => {
        logs.push({ fields, message });
      }
    };
    const app = createOAuthTestApp(
      createTestAuthManager({
        logger,
        trustedRedirectHosts: ['oauth-redirect.googleusercontent.com']
      })
    );
    const rejected = await request(app)
      .post('/mcp/register')
      .send({
        client_name: 'Evil',
        redirect_uris: ['https://evil.example/cb', 'https://oauth-redirect.googleusercontent.com/r/ok'],
        grant_types: ['authorization_code'],
        response_types: ['code']
      });
    assert.strictEqual(rejected.status, 400);
    assert.strictEqual(rejected.body.error, 'invalid_redirect_uri');
    const rejectLog = logs.find((entry) => entry.message === 'MCP OAuth client registration rejected');
    assert.isOk(rejectLog);
    assert.deepEqual(rejectLog.fields.redirectUris, [
      'https://evil.example/cb',
      'https://oauth-redirect.googleusercontent.com/r/ok'
    ]);
    assert.deepEqual(rejectLog.fields.rejectedRedirectUris, ['https://evil.example/cb']);
    assert.strictEqual(rejectLog.fields.clientName, 'Evil');

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

    const anyHttps = createOAuthTestApp(
      createTestAuthManager({ allowAnyHttpsRedirect: true })
    );
    const anyOk = await request(anyHttps)
      .post('/mcp/register')
      .send({
        client_name: 'AnyHttps',
        redirect_uris: ['https://evil.example/cb'],
        grant_types: ['authorization_code'],
        response_types: ['code']
      });
    assert.strictEqual(anyOk.status, 201);
  });

  it('logs redirect_uris on successful DCR registration', async () => {
    const logs = [];
    const logger = {
      ...silentTestLogger,
      info: (fields, message) => {
        logs.push({ fields, message });
      }
    };
    const app = createOAuthTestApp(createTestAuthManager({ logger }));
    const res = await request(app)
      .post('/mcp/register')
      .send({
        client_name: 'Google',
        redirect_uris: ['https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-x'],
        grant_types: ['authorization_code'],
        response_types: ['code']
      });
    // Default trusted hosts do not include googleusercontent — use allowAny for this success path
    assert.strictEqual(res.status, 400);

    const anyApp = createOAuthTestApp(
      createTestAuthManager({ logger, allowAnyHttpsRedirect: true })
    );
    const ok = await request(anyApp)
      .post('/mcp/register')
      .send({
        client_name: 'Google',
        redirect_uris: [
          'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-x',
          'https://gemini.google.com/oauth'
        ],
        grant_types: ['authorization_code'],
        response_types: ['code']
      });
    assert.strictEqual(ok.status, 201);
    const successLog = logs.find((entry) => entry.message === 'MCP OAuth client registered');
    assert.isOk(successLog);
    assert.deepEqual(successLog.fields.redirectUris, [
      'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-x',
      'https://gemini.google.com/oauth'
    ]);
    assert.deepEqual(successLog.fields.rejectedRedirectUris, []);
  });

  it('echoes wire-encoded state unmodified on https callback redirect', async () => {
    const logs = [];
    const logger = {
      ...silentTestLogger,
      info: (fields, message) => {
        logs.push({ fields, message });
      }
    };
    const authManager = createTestAuthManager({
      logger,
      allowedRedirectUris: ['https://oauth-redirect.googleusercontent.com/r/spark']
    });
    const { codeChallenge } = createPkcePair();
    const client = registerOAuthTestClient(
      authManager,
      'https://oauth-redirect.googleusercontent.com/r/spark'
    );
    // Spark-like state: plus, slash, equals, and already-encoded %2B
    const rawStateOnWire = 'abc%2Bdef/ghi=end';
    mockExchangeCodeForUser(authManager);

    const app = createOAuthTestApp(authManager);
    const authorizeRes = await request(app).get(
      `/mcp/authorize?client_id=${client.client_id}` +
        `&redirect_uri=${encodeURIComponent('https://oauth-redirect.googleusercontent.com/r/spark')}` +
        `&response_type=code` +
        `&code_challenge=${codeChallenge}` +
        `&code_challenge_method=S256` +
        `&state=${rawStateOnWire}`
    );
    assert.strictEqual(authorizeRes.status, 302);
    const idpState = new URL(authorizeRes.headers.location).searchParams.get('state');

    const callbackRes = await request(app)
      .get('/mcp/auth/callback')
      .query({ state: idpState, code: 'github-auth-code' });

    assert.strictEqual(callbackRes.status, 302);
    const location = callbackRes.headers.location;
    assert.include(location, `state=${rawStateOnWire}`);
    assert.match(location, /^https:\/\/oauth-redirect\.googleusercontent\.com\/r\/spark\?code=[^&]+&state=/);

    const redirectLog = logs.find((entry) => entry.message === 'MCP authorization code redirect issued');
    assert.isOk(redirectLog);
    assert.strictEqual(redirectLog.fields.stateUnchanged, true);
    assert.strictEqual(redirectLog.fields.inboundStateLength, rawStateOnWire.length);
    assert.deepEqual(redirectLog.fields.queryKeys, ['code', 'state']);
    assert.strictEqual(redirectLog.fields.redirectHost, 'oauth-redirect.googleusercontent.com');
  });

  it('extractRawQueryParam and buildAuthorizationRedirectUrl preserve encoding', () => {
    const raw = extractRawQueryParam('/mcp/authorize?state=a%2Bb%2Fc%3D&client_id=x', 'state');
    assert.strictEqual(raw, 'a%2Bb%2Fc%3D');
    const url = buildAuthorizationRedirectUrl(
      'https://oauth-redirect.googleusercontent.com/r/x',
      'authcode',
      raw
    );
    assert.strictEqual(
      url,
      'https://oauth-redirect.googleusercontent.com/r/x?code=authcode&state=a%2Bb%2Fc%3D'
    );
  });

  it('accepts Cursor-style multi-URI DCR with trusted https host', async () => {
    const app = createOAuthTestApp(createTestAuthManager());
    const res = await request(app)
      .post('/mcp/register')
      .send({
        client_name: 'Cursor',
        redirect_uris: [
          'cursor://anysphere.cursor-mcp/oauth/callback',
          'http://localhost:8787/callback',
          'https://www.cursor.com/agents/mcp/oauth/callback'
        ],
        grant_types: ['authorization_code'],
        response_types: ['code']
      });

    assert.strictEqual(res.status, 201);
    assert.property(res.body, 'client_id');
    assert.deepEqual(res.body.redirect_uris, [
      'cursor://anysphere.cursor-mcp/oauth/callback',
      'http://localhost:8787/callback',
      'https://www.cursor.com/agents/mcp/oauth/callback'
    ]);
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
    assert.property(res.body, 'refresh_token');
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

    const storedRefresh = await authManager.sessionStore.findRefreshToken(res.body.refresh_token);
    assert.isNotNull(storedRefresh);
    assert.strictEqual(storedRefresh.clientId, client.client_id);
    assert.strictEqual(storedRefresh.user.sub, TEST_GITHUB_USER.sub);
  });

  it('exchanges refresh_token for a new access token and rotates refresh_token', async () => {
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
    const first = await request(app)
      .post('/mcp/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'cursor://callback',
        client_id: client.client_id,
        code_verifier: codeVerifier
      });
    assert.strictEqual(first.status, 200);
    const oldRefresh = first.body.refresh_token;

    const refreshed = await request(app)
      .post('/mcp/token')
      .type('form')
      .send({
        grant_type: 'refresh_token',
        refresh_token: oldRefresh,
        client_id: client.client_id
      });
    assert.strictEqual(refreshed.status, 200);
    assert.property(refreshed.body, 'access_token');
    assert.property(refreshed.body, 'refresh_token');
    assert.notStrictEqual(refreshed.body.refresh_token, oldRefresh);
    assert.isNull(await authManager.sessionStore.findRefreshToken(oldRefresh));
    assert.isNotNull(await authManager.sessionStore.findRefreshToken(refreshed.body.refresh_token));

    const missing = await request(app)
      .post('/mcp/token')
      .type('form')
      .send({
        grant_type: 'refresh_token',
        refresh_token: oldRefresh,
        client_id: client.client_id
      });
    assert.strictEqual(missing.status, 400);
    assert.strictEqual(missing.body.error, 'invalid_grant');
  });
});
