import { assert } from 'chai';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { ExpressMcp, BaseTool } from '../../src/index.js';
import { getTestExpressMcpOptions } from '../config.js';

const JWT_SECRET = 'test-jwt-secret-for-unit-tests';
const SESSION_SECRET = 'test-session-secret';

describe('MCP Auth Middleware', () => {
  let app;
  let expressMcp;

  class HelloTool extends BaseTool {
    constructor() {
      super('hello', 'Says hello');
    }

    async execute() {
      return 'Hello!';
    }
  }

  function createAuthMcp(overrides = {}) {
    return new ExpressMcp(
      getTestExpressMcpOptions({
        enableKnowledgeBase: false,
        auth: {
          enabled: true,
          provider: 'github',
          clientId: 'test-client-id',
          clientSecret: 'test-client-secret',
          callbackUrl: 'http://localhost:3000/auth/callback',
          jwtSecret: JWT_SECRET,
          jwtExpiresIn: '1h',
          sessionSecret: SESSION_SECRET,
          ...overrides
        }
      })
    );
  }

  function issueToken(payload, expiresIn = '1h') {
    return jwt.sign(payload, JWT_SECRET, { expiresIn });
  }

  const initializeBody = {
    jsonrpc: '2.0',
    method: 'initialize',
    id: 1
  };

  beforeEach(() => {
    expressMcp = createAuthMcp();
    expressMcp.registerTool(new HelloTool());

    app = express();
    app.use(express.json());
    app.use('/mcp', expressMcp.router());
  });

  it('returns 401 when Authorization header is missing', async () => {
    const res = await request(app).post('/mcp').send(initializeBody);

    assert.strictEqual(res.status, 401);
    assert.property(res.body, 'error');
    assert.strictEqual(res.body.error, 'unauthorized');
  });

  it('returns 401 when token is invalid', async () => {
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', 'Bearer not-a-valid-jwt')
      .send(initializeBody);

    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error, 'unauthorized');
  });

  it('returns 401 when token is expired', async () => {
    const expired = issueToken(
      { sub: 'gh:1', login: 'user', name: 'User', email: 'u@example.com', provider: 'github' },
      '-1s'
    );

    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${expired}`)
      .send(initializeBody);

    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error, 'unauthorized');
  });

  it('allows MCP requests with a valid Bearer token', async () => {
    const token = issueToken({
      sub: 'gh:1',
      login: 'testuser',
      name: 'Test User',
      email: 'test@example.com',
      provider: 'github'
    });

    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${token}`)
      .send(initializeBody);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.jsonrpc, '2.0');
    assert.property(res.body, 'result');
    assert.property(res.body.result, 'serverInfo');
    assert.deepInclude(res.body.result.serverInfo, {
      auth: { required: true, provider: 'github' }
    });
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
      /missing required options/
    );
  });
});

describe('AuthManager', () => {
  it('issues and verifies JWT with user claims', async () => {
    const { AuthManager } = await import('../../src/classes/authManager.js');
    const auth = new AuthManager({
      provider: 'github',
      clientId: 'id',
      clientSecret: 'secret',
      callbackUrl: 'http://localhost/cb',
      jwtSecret: JWT_SECRET,
      jwtExpiresIn: '1h',
      sessionSecret: SESSION_SECRET
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
  });

  it('builds GitHub authorization URL with state', async () => {
    const { AuthManager } = await import('../../src/classes/authManager.js');
    const auth = new AuthManager({
      provider: 'github',
      clientId: 'gh-id',
      clientSecret: 'gh-secret',
      callbackUrl: 'http://localhost:3000/auth/callback',
      jwtSecret: JWT_SECRET,
      sessionSecret: SESSION_SECRET
    });

    const url = auth.getAuthorizationUrl('state-abc');
    assert.include(url, 'github.com/login/oauth/authorize');
    assert.include(url, 'client_id=gh-id');
    assert.include(url, 'state=state-abc');
    assert.include(url, 'read%3Auser');
  });
});
