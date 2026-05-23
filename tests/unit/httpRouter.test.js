import { assert } from 'chai';
import { createHash, randomBytes } from 'crypto';
import request from 'supertest';
import express from 'express';
import { ExpressMcp, BaseTool } from '../../src/index.js';
import { buildWwwAuthenticateHeader } from '../../src/mcpOAuth.js';
import { getTestExpressMcpOptions } from '../config.js';

const JWT_SECRET = 'test-jwt-secret';
const SESSION_SECRET = 'test-session-secret';
const ISSUER = 'http://localhost:3000';

class HelloTool extends BaseTool {
  constructor() {
    super('hello', 'Says hello');
  }

  async execute() {
    return 'Hello!';
  }
}

function createExpressMcpWithAuth() {
  return new ExpressMcp(
    getTestExpressMcpOptions({
      enableKnowledgeBase: false,
      auth: {
        enabled: true,
        provider: 'github',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        callbackUrl: `${ISSUER}/auth/callback`,
        issuer: ISSUER,
        jwtSecret: JWT_SECRET,
        jwtExpiresIn: '1h',
        sessionSecret: SESSION_SECRET
      }
    })
  );
}

describe('ExpressMcp.httpRouter', () => {
  it('mounts MCP protocol at /mcp when auth is disabled', async () => {
    const expressMcp = new ExpressMcp(
      getTestExpressMcpOptions({ enableKnowledgeBase: false })
    );
    expressMcp.registerTool(new HelloTool());

    const app = express();
    app.use(express.json());
    app.use(expressMcp.httpRouter());

    const res = await request(app)
      .post('/mcp')
      .send({ jsonrpc: '2.0', method: 'initialize', id: 1 });

    assert.strictEqual(res.status, 200);
  });

  it('exposes OAuth discovery, register, and protected MCP via single mount', async () => {
    const expressMcp = createExpressMcpWithAuth();
    expressMcp.registerTool(new HelloTool());

    const app = express();
    app.use(expressMcp.httpRouter());

    const prm = await request(app).get('/.well-known/oauth-protected-resource/mcp');
    assert.strictEqual(prm.status, 200);

    const register = await request(app)
      .post('/register')
      .send({
        client_name: 'Cursor',
        redirect_uris: ['cursor://callback'],
        grant_types: ['authorization_code'],
        response_types: ['code']
      });
    assert.strictEqual(register.status, 201);

    const mcp = await request(app)
      .post('/mcp')
      .send({ jsonrpc: '2.0', method: 'initialize', id: 1 });
    assert.strictEqual(mcp.status, 401);
    assert.strictEqual(
      mcp.headers['www-authenticate'],
      buildWwwAuthenticateHeader(ISSUER, '/mcp')
    );

    const login = await request(app).get('/auth/login');
    assert.strictEqual(login.status, 302);
    assert.include(login.headers.location, '/auth/login/github');
  });
});
