import { assert } from 'chai';
import request from 'supertest';
import express from 'express';
import { ExpressMcp } from '../../src/index.js';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import {
  createInitializeRequest,
  getTestExpressMcpOptions,
  mcpPost
} from '../config.js';
import { createTestAuthMcp, issueTestJwtWithSession, TEST_AUTH } from '../authTestUtils.js';
import { InMemoryStandaloneSessionStore } from '../../src/stores/inMemoryStandaloneSessionStore.js';
import { HelloTool } from '../testUtils.js';

describe('ExpressMcp.httpRouter', () => {
  it('mounts MCP protocol at /mcp when auth is disabled', async () => {
    const expressMcp = new ExpressMcp(
      getTestExpressMcpOptions({ enableKnowledgeBase: false })
    );
    expressMcp.registerTool(new HelloTool());

    const app = express();
    app.use(express.json());
    app.use(expressMcp.httpRouter());

    const res = await mcpPost(request(app))
      .send(createInitializeRequest(1));

    assert.strictEqual(res.status, 200);
  });

  it('exposes OAuth discovery, register, and protected MCP via single mount', async () => {
    const expressMcp = createTestAuthMcp();
    expressMcp.registerTool(new HelloTool());

    const app = express();
    app.use(expressMcp.httpRouter());

    const prm = await request(app).get('/.well-known/oauth-protected-resource/mcp');
    assert.strictEqual(prm.status, 200);

    // Load-bearing: RFC 8414 path-based AS metadata (Cursor after PRM)
    const pathAs = await request(app).get('/.well-known/oauth-authorization-server/mcp');
    assert.strictEqual(pathAs.status, 200);
    assert.strictEqual(pathAs.body.issuer, TEST_AUTH.issuer);
    assert.strictEqual(pathAs.body.registration_endpoint, `${TEST_AUTH.issuer}/register`);

    // Defensive OIDC aliases
    const pathOidc = await request(app).get('/.well-known/openid-configuration/mcp');
    assert.strictEqual(pathOidc.status, 200);
    assert.deepEqual(pathOidc.body, pathAs.body);

    const mcpOidc = await request(app).get('/mcp/.well-known/openid-configuration');
    assert.strictEqual(mcpOidc.status, 200);
    assert.deepEqual(mcpOidc.body, pathAs.body);

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

    const mcp = await mcpPost(request(app)).send(createInitializeRequest(1));
    assert.strictEqual(mcp.status, 401);
    assert.include(
      mcp.headers['www-authenticate'],
      getOAuthProtectedResourceMetadataUrl(new URL(`${TEST_AUTH.origin}/mcp`))
    );

    const login = await request(app).get('/mcp/auth/login');
    assert.strictEqual(login.status, 302);
    assert.include(login.headers.location, '/mcp/auth/login/github');
  });

  it('isolates a secondary /mcp/admin mount from primary auth and root aliases', async () => {
    const sessionStore = new InMemoryStandaloneSessionStore();

    const primary = createTestAuthMcp({ sessionStore });
    primary.registerTool(new HelloTool());

    const admin = createTestAuthMcp({
      sessionStore,
      resourcePath: '/mcp/admin',
      callbackUrl: 'http://localhost:3000/mcp/admin/auth/callback',
      issuer: 'http://localhost:3000/mcp/admin',
      allowedUsers: ['operator@example.com'],
    });
    admin.registerTool(new HelloTool());

    const app = express();
    app.use(admin.httpRouter({ mcpPath: '/mcp/admin', rootAliases: false }));
    app.use(primary.httpRouter({ mcpPath: '/mcp' }));

    const adminUnauth = await mcpPost(request(app), '/mcp/admin')
      .send(createInitializeRequest(1));
    assert.strictEqual(adminUnauth.status, 401);
    assert.include(
      adminUnauth.headers['www-authenticate'],
      getOAuthProtectedResourceMetadataUrl(new URL(`${TEST_AUTH.origin}/mcp/admin`)),
    );

    const primaryUnauth = await mcpPost(request(app), '/mcp')
      .send(createInitializeRequest(1));
    assert.strictEqual(primaryUnauth.status, 401);
    assert.include(
      primaryUnauth.headers['www-authenticate'],
      getOAuthProtectedResourceMetadataUrl(new URL(`${TEST_AUTH.origin}/mcp`)),
    );

    const rootAs = await request(app).get('/.well-known/oauth-authorization-server');
    assert.strictEqual(rootAs.status, 200);
    assert.strictEqual(rootAs.body.issuer, TEST_AUTH.issuer);

    const adminPathAs = await request(app).get('/.well-known/oauth-authorization-server/mcp/admin');
    assert.strictEqual(adminPathAs.status, 200);
    assert.strictEqual(adminPathAs.body.issuer, 'http://localhost:3000/mcp/admin');

    const nonOperatorToken = await issueTestJwtWithSession(admin.authManager, {
      sub: 'gh:2',
      login: 'user',
      name: 'User',
      email: 'user@example.com',
      provider: 'github',
    });
    const forbidden = await mcpPost(request(app), '/mcp/admin')
      .set('Authorization', `Bearer ${nonOperatorToken}`)
      .send(createInitializeRequest(2));
    assert.strictEqual(forbidden.status, 403);

    const operatorToken = await issueTestJwtWithSession(admin.authManager, {
      sub: 'gh:3',
      login: 'ops',
      name: 'Ops',
      email: 'operator@example.com',
      provider: 'github',
    });
    const allowed = await mcpPost(request(app), '/mcp/admin')
      .set('Authorization', `Bearer ${operatorToken}`)
      .send(createInitializeRequest(3));
    assert.strictEqual(allowed.status, 200);
  });

  it('exposes RFC 8414 path-based AS metadata via mcpOAuthRouter', async () => {
    const expressMcp = createTestAuthMcp();

    const app = express();
    app.use(express.json());
    app.use(expressMcp.mcpOAuthRouter());

    const pathAs = await request(app).get('/.well-known/oauth-authorization-server/mcp');
    assert.strictEqual(pathAs.status, 200);
    assert.strictEqual(pathAs.body.issuer, TEST_AUTH.issuer);
    assert.strictEqual(pathAs.body.registration_endpoint, `${TEST_AUTH.issuer}/register`);

    const pathOidc = await request(app).get('/.well-known/openid-configuration/mcp');
    assert.strictEqual(pathOidc.status, 200);
    assert.deepEqual(pathOidc.body, pathAs.body);
  });
});
