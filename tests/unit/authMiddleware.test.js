import { assert } from 'chai';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { ExpressMcp, BaseTool } from '../../src/index.js';
import { getTestExpressMcpOptions, MCP_STREAMABLE_HTTP_ACCEPT, createInitializeRequest } from '../config.js';

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

  class WhoAmITool extends BaseTool {
    constructor() {
      super('whoami', 'Returns caller identity');
    }

    async execute(_args, context) {
      return { login: context.user?.login, email: context.user?.email };
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
          callbackUrl: 'http://localhost:3000/mcp/auth/callback',
          issuer: 'http://localhost:3000/mcp',
          resourcePath: '/mcp',
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

  const initializeBody = createInitializeRequest(1);

  beforeEach(() => {
    expressMcp = createAuthMcp();
    expressMcp.registerTool(new HelloTool());

    app = express();
    app.use(express.json());
    app.use('/mcp', expressMcp.router());
  });

  it('returns 401 when Authorization header is missing', async () => {
    const res = await request(app).post('/mcp').set('Accept', MCP_STREAMABLE_HTTP_ACCEPT).send(initializeBody);

    assert.strictEqual(res.status, 401);
    assert.property(res.body, 'error');
    assert.include(res.headers['www-authenticate'], 'resource_metadata=');
  });

  it('returns 401 when token is invalid', async () => {
    const res = await request(app)
      .post('/mcp').set('Accept', MCP_STREAMABLE_HTTP_ACCEPT)
      .set('Authorization', 'Bearer not-a-valid-jwt')
      .send(initializeBody);

    assert.strictEqual(res.status, 401);
    assert.property(res.body, 'error');
  });

  it('returns 401 when token is expired', async () => {
    const expired = issueToken(
      { sub: 'gh:1', login: 'user', name: 'User', email: 'u@example.com', provider: 'github' },
      '-1s'
    );

    const res = await request(app)
      .post('/mcp').set('Accept', MCP_STREAMABLE_HTTP_ACCEPT)
      .set('Authorization', `Bearer ${expired}`)
      .send(initializeBody);

    assert.strictEqual(res.status, 401);
    assert.property(res.body, 'error');
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
      .post('/mcp').set('Accept', MCP_STREAMABLE_HTTP_ACCEPT)
      .set('Authorization', `Bearer ${token}`)
      .send(initializeBody);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.jsonrpc, '2.0');
    assert.property(res.body, 'result');
    assert.property(res.body.result, 'serverInfo');
  });

  it('initialize returns providers array when multi-provider configured', async () => {
    expressMcp = createAuthMcp({
      providers: {
        github: { clientId: 'gh', clientSecret: 'ghs' },
        google: { clientId: 'go', clientSecret: 'gos' }
      }
    });
    expressMcp.registerTool(new HelloTool());
    app = express();
    app.use(express.json());
    app.use('/mcp', expressMcp.router());

    const token = issueToken({
      sub: 'gh:1',
      login: 'user',
      name: 'User',
      email: 'u@example.com',
      provider: 'github'
    });

    const res = await request(app)
      .post('/mcp').set('Accept', MCP_STREAMABLE_HTTP_ACCEPT)
      .set('Authorization', `Bearer ${token}`)
      .send(initializeBody);

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
      /missing required options/
    );
  });

  it('returns 403 when user is not on allowlist', async () => {
    expressMcp = createAuthMcp({ allowedUsers: ['allowed@example.com'] });
    expressMcp.registerTool(new HelloTool());
    app = express();
    app.use(express.json());
    app.use('/mcp', expressMcp.router());

    const token = issueToken({
      sub: 'gh:1',
      login: 'blocked',
      name: 'Blocked',
      email: 'blocked@example.com',
      provider: 'github'
    });

    const res = await request(app)
      .post('/mcp').set('Accept', MCP_STREAMABLE_HTTP_ACCEPT)
      .set('Authorization', `Bearer ${token}`)
      .send(initializeBody);

    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.error, 'forbidden');
  });

  it('allows MCP when email is on allowlist', async () => {
    expressMcp = createAuthMcp({ allowedUsers: ['allowed@example.com'] });
    expressMcp.registerTool(new HelloTool());
    app = express();
    app.use(express.json());
    app.use('/mcp', expressMcp.router());

    const token = issueToken({
      sub: 'gh:2',
      login: 'alloweduser',
      name: 'Allowed',
      email: 'allowed@example.com',
      provider: 'github'
    });

    const res = await request(app)
      .post('/mcp').set('Accept', MCP_STREAMABLE_HTTP_ACCEPT)
      .set('Authorization', `Bearer ${token}`)
      .send(initializeBody);

    assert.strictEqual(res.status, 200);
  });

  it('allows MCP when login is on allowlist', async () => {
    expressMcp = createAuthMcp({ allowedUsers: ['mygithublogin'] });
    expressMcp.registerTool(new HelloTool());
    app = express();
    app.use(express.json());
    app.use('/mcp', expressMcp.router());

    const token = issueToken({
      sub: 'gh:3',
      login: 'mygithublogin',
      name: 'Git User',
      email: 'other@example.com',
      provider: 'github'
    });

    const res = await request(app)
      .post('/mcp').set('Accept', MCP_STREAMABLE_HTTP_ACCEPT)
      .set('Authorization', `Bearer ${token}`)
      .send(initializeBody);

    assert.strictEqual(res.status, 200);
  });

  it('passes user into tool context', async () => {
    expressMcp = createAuthMcp();
    expressMcp.registerTool(new WhoAmITool());
    app = express();
    app.use(express.json());
    app.use('/mcp', expressMcp.router());

    const token = issueToken({
      sub: 'gh:4',
      login: 'ctxuser',
      name: 'Ctx',
      email: 'ctx@example.com',
      provider: 'github'
    });

    const res = await request(app)
      .post('/mcp').set('Accept', MCP_STREAMABLE_HTTP_ACCEPT)
      .set('Authorization', `Bearer ${token}`)
      .send({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'whoami', arguments: {} },
        id: 10
      });

    assert.strictEqual(res.status, 200);
    const text = res.body.result.content[0].text;
    const parsed = JSON.parse(text);
    assert.strictEqual(parsed.login, 'ctxuser');
    assert.strictEqual(parsed.email, 'ctx@example.com');
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
      issuer: 'http://localhost:3000/mcp',
      resourcePath: '/mcp',
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
      providers: {
        github: { clientId: 'gh-id', clientSecret: 'gh-secret' }
      },
      callbackUrl: 'http://localhost:3000/mcp/auth/callback',
      issuer: 'http://localhost:3000/mcp',
      resourcePath: '/mcp',
      jwtSecret: JWT_SECRET,
      sessionSecret: SESSION_SECRET
    });

    const url = auth.getAuthorizationUrl('github', 'state-abc');
    assert.include(url, 'github.com/login/oauth/authorize');
    assert.include(url, 'client_id=gh-id');
    assert.include(url, 'state=state-abc');
    assert.include(url, 'read%3Auser');
  });
});
