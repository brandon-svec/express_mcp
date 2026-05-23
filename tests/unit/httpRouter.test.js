import { assert } from 'chai';
import { createHash, randomBytes } from 'crypto';
import request from 'supertest';
import express from 'express';
import { ExpressMcp, BaseTool } from '../../src/index.js';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { getTestExpressMcpOptions, MCP_STREAMABLE_HTTP_ACCEPT, createInitializeRequest } from '../config.js';

const JWT_SECRET = 'test-jwt-secret';
const SESSION_SECRET = 'test-session-secret';
const ORIGIN = 'http://localhost:3000';
const ISSUER = `${ORIGIN}/mcp`;

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
        resourcePath: '/mcp',
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
      .set('Accept', MCP_STREAMABLE_HTTP_ACCEPT)
      .send(createInitializeRequest(1));

    assert.strictEqual(res.status, 200);
  });

  it('exposes OAuth discovery, register, and protected MCP via single mount', async () => {
    const expressMcp = createExpressMcpWithAuth();
    expressMcp.registerTool(new HelloTool());

    const app = express();
    app.use(expressMcp.httpRouter());

    const prm = await request(app).get('/.well-known/oauth-protected-resource/mcp');
    assert.strictEqual(prm.status, 200);

    const registerBody = {
      client_name: 'Cursor',
      redirect_uris: ['cursor://callback'],
      grant_types: ['authorization_code'],
      response_types: ['code']
    };

    const register = await request(app).post('/mcp/register').send(registerBody);
    assert.strictEqual(register.status, 201);

    const registerRoot = await request(app).post('/register').send(registerBody);
    assert.strictEqual(registerRoot.status, 201);

    const mcp = await request(app)
      .post('/mcp')
      .set('Accept', MCP_STREAMABLE_HTTP_ACCEPT)
      .send(createInitializeRequest(1));
    assert.strictEqual(mcp.status, 401);
    assert.include(
      mcp.headers['www-authenticate'],
      getOAuthProtectedResourceMetadataUrl(new URL(`${ORIGIN}/mcp`))
    );

    const login = await request(app).get('/mcp/auth/login');
    assert.strictEqual(login.status, 302);
    assert.include(login.headers.location, '/mcp/auth/login/github');
  });
});
