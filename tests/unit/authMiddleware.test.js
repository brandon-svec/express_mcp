import { assert } from 'chai';
import request from 'supertest';
import express from 'express';
import { ExpressMcp } from '../../src/index.js';
import {
  createInitializeRequest,
  createMcpRequest,
  createMcpSession,
  createToolCallRequest,
  getTestExpressMcpOptions,
  mcpPost,
  mcpPostWithSession
} from '../config.js';
import {
  createTestAuthMcp,
  issueTestJwt,
  TEST_AUTH,
  TEST_GITHUB_USER
} from '../authTestUtils.js';
import { HelloTool } from '../testUtils.js';

describe('MCP Auth Middleware', () => {
  let app;
  let expressMcp;

  beforeEach(() => {
    expressMcp = createTestAuthMcp();
    expressMcp.registerTool(new HelloTool());

    app = express();
    app.use(express.json());
    app.use('/mcp', expressMcp.router());
  });

  it('returns 401 when Authorization header is missing', async () => {
    const res = await mcpPost(request(app)).send(createInitializeRequest(1));

    assert.strictEqual(res.status, 401);
    assert.property(res.body, 'error');
    assert.include(res.headers['www-authenticate'], 'resource_metadata=');
  });

  it('returns 401 when token is invalid', async () => {
    const res = await mcpPost(request(app))
      .set('Authorization', 'Bearer not-a-valid-jwt')
      .send(createInitializeRequest(1));

    assert.strictEqual(res.status, 401);
    assert.property(res.body, 'error');
  });

  it('returns 401 when token is expired', async () => {
    const expired = issueTestJwt(TEST_GITHUB_USER, '-1s');
    const res = await mcpPost(request(app))
      .set('Authorization', `Bearer ${expired}`)
      .send(createInitializeRequest(1));

    assert.strictEqual(res.status, 401);
    assert.property(res.body, 'error');
  });

  it('allows MCP requests with a valid Bearer token', async () => {
    const token = issueTestJwt({
      sub: 'gh:1',
      login: 'testuser',
      name: 'Test User',
      email: 'test@example.com',
      provider: 'github'
    });

    const res = await mcpPost(request(app))
      .set('Authorization', `Bearer ${token}`)
      .send(createInitializeRequest(1));

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.jsonrpc, '2.0');
    assert.property(res.body, 'result');
    assert.property(res.body.result, 'serverInfo');
  });

  it('initialize returns providers array when multi-provider configured', async () => {
    expressMcp = createTestAuthMcp({
      providers: {
        github: TEST_AUTH.githubAlt,
        google: TEST_AUTH.google
      }
    });
    expressMcp.registerTool(new HelloTool());
    app = express();
    app.use(express.json());
    app.use('/mcp', expressMcp.router());

    const token = issueTestJwt(TEST_GITHUB_USER);
    const res = await mcpPost(request(app))
      .set('Authorization', `Bearer ${token}`)
      .send(createInitializeRequest(1));

    assert.strictEqual(res.status, 200);
    assert.property(res.body.result, 'serverInfo');
  });

  it('authRouter throws when auth is disabled', () => {
    const noAuth = new ExpressMcp(getTestExpressMcpOptions({ enableKnowledgeBase: false }));
    assert.throws(() => noAuth.authRouter(), /Auth is not enabled/);
  });

  it('constructor throws when auth enabled but secrets missing', () => {
    assert.throws(
      () =>
        new ExpressMcp(
          getTestExpressMcpOptions({
            auth: { enabled: true, clientId: 'x' }
          })
        ),
      /callbackUrl is missing or empty/
    );
  });

  it('returns 403 when user is not on allowlist', async () => {
    expressMcp = createTestAuthMcp({ allowedUsers: ['allowed@example.com'] });
    expressMcp.registerTool(new HelloTool());
    app = express();
    app.use(express.json());
    app.use('/mcp', expressMcp.router());

    const token = issueTestJwt({
      sub: 'gh:1',
      login: 'blocked',
      name: 'Blocked',
      email: 'blocked@example.com',
      provider: 'github'
    });

    const res = await mcpPost(request(app))
      .set('Authorization', `Bearer ${token}`)
      .send(createInitializeRequest(1));

    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.error, 'forbidden');
  });

  it('allows MCP when email is on allowlist', async () => {
    expressMcp = createTestAuthMcp({ allowedUsers: ['allowed@example.com'] });
    expressMcp.registerTool(new HelloTool());
    app = express();
    app.use(express.json());
    app.use('/mcp', expressMcp.router());

    const token = issueTestJwt({
      sub: 'gh:2',
      login: 'alloweduser',
      name: 'Allowed',
      email: 'allowed@example.com',
      provider: 'github'
    });

    const res = await mcpPost(request(app))
      .set('Authorization', `Bearer ${token}`)
      .send(createInitializeRequest(1));

    assert.strictEqual(res.status, 200);
  });

  it('allows MCP when login is on allowlist', async () => {
    expressMcp = createTestAuthMcp({ allowedUsers: ['mygithublogin'] });
    expressMcp.registerTool(new HelloTool());
    app = express();
    app.use(express.json());
    app.use('/mcp', expressMcp.router());

    const token = issueTestJwt({
      sub: 'gh:3',
      login: 'mygithublogin',
      name: 'Git User',
      email: 'other@example.com',
      provider: 'github'
    });

    const res = await mcpPost(request(app))
      .set('Authorization', `Bearer ${token}`)
      .send(createInitializeRequest(1));

    assert.strictEqual(res.status, 200);
  });

  it('passes user into tool context via session tool who_am_i', async () => {
    expressMcp = createTestAuthMcp();
    app = express();
    app.use(express.json());
    app.use('/mcp', expressMcp.router());

    const token = issueTestJwt({
      sub: 'gh:4',
      login: 'ctxuser',
      name: 'Ctx',
      email: 'ctx@example.com',
      provider: 'github'
    });

    const baseAgent = request(app);
    const sessionId = await createMcpSession(baseAgent, '/mcp', {
      authorization: `Bearer ${token}`
    });

    const res = await mcpPostWithSession(baseAgent, sessionId)
      .set('Authorization', `Bearer ${token}`)
      .send(createToolCallRequest('session', { action: 'who_am_i' }, 10));

    assert.strictEqual(res.status, 200);
    const parsed = JSON.parse(res.body.result.content[0].text);
    assert.strictEqual(parsed.authenticated, true);
    assert.strictEqual(parsed.login, 'ctxuser');
    assert.strictEqual(parsed.email, 'ctx@example.com');
    assert.ok(typeof parsed.issuedAt === 'string');
    assert.ok(typeof parsed.expiresAt === 'string');
    assert.ok(parsed.expiresAt > parsed.issuedAt);
  });

  it('reset_session revokes token and subsequent requests return 401', async () => {
    expressMcp = createTestAuthMcp();
    app = express();
    app.use(express.json());
    app.use('/mcp', expressMcp.router());

    const token = issueTestJwt({
      sub: 'gh:5',
      login: 'logoutuser',
      name: 'Logout',
      email: 'logout@example.com',
      provider: 'github'
    });

    const baseAgent = request(app);
    const sessionId = await createMcpSession(baseAgent, '/mcp', {
      authorization: `Bearer ${token}`
    });

    const resetRes = await mcpPostWithSession(baseAgent, sessionId)
      .set('Authorization', `Bearer ${token}`)
      .send(createToolCallRequest('session', { action: 'reset_session' }, 11));

    assert.strictEqual(resetRes.status, 200);
    const resetParsed = JSON.parse(resetRes.body.result.content[0].text);
    assert.strictEqual(resetParsed.revoked, true);

    const afterRes = await mcpPostWithSession(baseAgent, sessionId)
      .set('Authorization', `Bearer ${token}`)
      .send(createMcpRequest('tools/list', {}, 12));

    assert.strictEqual(afterRes.status, 401);
  });
});

describe('AuthManager', () => {
  it('issues and verifies JWT with user claims', async () => {
    const { AuthManager } = await import('../../src/classes/authManager.js');
    const auth = new AuthManager({
      providers: {
        github: { clientId: 'id', clientSecret: 'secret' }
      },
      callbackUrl: 'http://localhost/cb',
      issuer: TEST_AUTH.issuer,
      resourcePath: TEST_AUTH.resourcePath,
      jwtSecret: TEST_AUTH.jwtSecret,
      jwtExpiresIn: TEST_AUTH.jwtExpiresIn,
      sessionSecret: TEST_AUTH.sessionSecret
    });

    const user = {
      sub: 'gh:99',
      login: 'octocat',
      name: 'The Octocat',
      email: 'octocat@github.com',
      provider: 'github'
    };

    const token = auth.issueJwt(user);
    const decoded = auth.verifyJwt(token);

    assert.strictEqual(decoded.sub, user.sub);
    assert.strictEqual(decoded.login, user.login);
    assert.strictEqual(decoded.email, user.email);
    assert.isString(decoded.jti);
  });

  it('builds GitHub authorization URL with state', async () => {
    const { AuthManager } = await import('../../src/classes/authManager.js');
    const auth = new AuthManager({
      providers: {
        github: { clientId: 'gh-id', clientSecret: 'gh-secret' }
      },
      callbackUrl: TEST_AUTH.callbackUrl,
      issuer: TEST_AUTH.issuer,
      resourcePath: TEST_AUTH.resourcePath,
      jwtSecret: TEST_AUTH.jwtSecret,
      sessionSecret: TEST_AUTH.sessionSecret
    });

    const url = auth.getAuthorizationUrl('github', 'state-abc');
    assert.include(url, 'github.com/login/oauth/authorize');
    assert.include(url, 'client_id=gh-id');
    assert.include(url, 'state=state-abc');
    assert.include(url, 'read%3Auser');
  });
});
