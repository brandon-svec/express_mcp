import { assert } from 'chai';
import request from 'supertest';
import express from 'express';
import { ExpressMcp } from '../../src/index.js';
import { InMemoryStandaloneSessionStore } from '../../src/stores/inMemoryStandaloneSessionStore.js';
import {
  createToolCallRequest,
  getTestExpressMcpOptions,
  MCP_SESSION_ID_HEADER,
  MCP_STREAMABLE_HTTP_ACCEPT,
  createMcpSession,
  mcpPostWithSession
} from '../config.js';
import {
  createTestAuthMcp,
  issueTestJwtWithSession,
  TEST_GITHUB_USER
} from '../authTestUtils.js';
import { HelloTool } from '../testUtils.js';

describe('MCP transport session recovery', () => {
  /**
   * @param {InMemoryStandaloneSessionStore} sessionStore
   * @param {Record<string, unknown>} [authOverrides]
   */
  function mountAuthMcp(sessionStore, authOverrides = {}) {
    const expressMcp = createTestAuthMcp({
      sessionStore,
      ...authOverrides
    });
    expressMcp.registerTool(new HelloTool());
    const app = express();
    app.use(express.json());
    app.use('/mcp', expressMcp.router());
    return { app, expressMcp };
  }

  it('recovers tools/call after a process restart using the shared session store', async () => {
    const sessionStore = new InMemoryStandaloneSessionStore();
    const first = mountAuthMcp(sessionStore);
    const token = await issueTestJwtWithSession(first.expressMcp.authManager, TEST_GITHUB_USER);
    const authorization = `Bearer ${token}`;

    const sessionId = await createMcpSession(request(first.app), '/mcp', { authorization });
    const before = await sessionStore.findMcpTransportSession(sessionId);
    assert.isNotNull(before);
    const createdAt = before.createdAt;

    // Simulate dyno restart: new ExpressMcp / Map, same store.
    const second = mountAuthMcp(sessionStore);
    const recovered = await mcpPostWithSession(request(second.app), sessionId)
      .set('Authorization', authorization)
      .send(createToolCallRequest('hello', {}, 10));

    assert.strictEqual(recovered.status, 200);
    assert.strictEqual(recovered.body.result.content[0].text, 'Hello!');

    const after = await sessionStore.findMcpTransportSession(sessionId);
    assert.isNotNull(after);
    assert.strictEqual(after.createdAt, createdAt);
  });

  it('returns 404 Session not found for an unknown Mcp-Session-Id', async () => {
    const sessionStore = new InMemoryStandaloneSessionStore();
    const { app, expressMcp } = mountAuthMcp(sessionStore);
    const token = await issueTestJwtWithSession(expressMcp.authManager, TEST_GITHUB_USER);

    const res = await mcpPostWithSession(
      request(app),
      '550e8400-e29b-41d4-a716-446655440000'
    )
      .set('Authorization', `Bearer ${token}`)
      .send(createToolCallRequest('hello', { name: 'Nope' }, 11));

    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.error.message, 'Session not found');
  });

  it('DELETE on the live Map removes the store row so a restarted instance 404s', async () => {
    const sessionStore = new InMemoryStandaloneSessionStore();
    const first = mountAuthMcp(sessionStore);
    const token = await issueTestJwtWithSession(first.expressMcp.authManager, TEST_GITHUB_USER);
    const authorization = `Bearer ${token}`;
    const sessionId = await createMcpSession(request(first.app), '/mcp', { authorization });

    const deleted = await request(first.app)
      .delete('/mcp')
      .set('Accept', MCP_STREAMABLE_HTTP_ACCEPT)
      .set(MCP_SESSION_ID_HEADER, sessionId)
      .set('Authorization', authorization);
    assert.strictEqual(deleted.status, 200);
    assert.isNull(await sessionStore.findMcpTransportSession(sessionId));

    const second = mountAuthMcp(sessionStore);
    const res = await mcpPostWithSession(request(second.app), sessionId)
      .set('Authorization', authorization)
      .send(createToolCallRequest('hello', { name: 'Gone' }, 12));
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.error.message, 'Session not found');
  });

  it('DELETE after restart short-circuits without rebuilding and clears the store', async () => {
    const sessionStore = new InMemoryStandaloneSessionStore();
    const first = mountAuthMcp(sessionStore);
    const token = await issueTestJwtWithSession(first.expressMcp.authManager, TEST_GITHUB_USER);
    const authorization = `Bearer ${token}`;
    const sessionId = await createMcpSession(request(first.app), '/mcp', { authorization });
    assert.isNotNull(await sessionStore.findMcpTransportSession(sessionId));

    const second = mountAuthMcp(sessionStore);
    const deleted = await request(second.app)
      .delete('/mcp')
      .set('Accept', MCP_STREAMABLE_HTTP_ACCEPT)
      .set(MCP_SESSION_ID_HEADER, sessionId)
      .set('Authorization', authorization);
    assert.strictEqual(deleted.status, 200);
    assert.isNull(await sessionStore.findMcpTransportSession(sessionId));

    const res = await mcpPostWithSession(request(second.app), sessionId)
      .set('Authorization', authorization)
      .send(createToolCallRequest('hello', { name: 'Gone' }, 13));
    assert.strictEqual(res.status, 404);
  });

  it('rejects recovery when a different user presents the saved Mcp-Session-Id', async () => {
    const sessionStore = new InMemoryStandaloneSessionStore();
    const first = mountAuthMcp(sessionStore);
    const ownerToken = await issueTestJwtWithSession(first.expressMcp.authManager, TEST_GITHUB_USER);
    const sessionId = await createMcpSession(request(first.app), '/mcp', {
      authorization: `Bearer ${ownerToken}`
    });

    const second = mountAuthMcp(sessionStore);
    const otherToken = await issueTestJwtWithSession(second.expressMcp.authManager, {
      ...TEST_GITHUB_USER,
      sub: 'gh:2',
      email: 'other@example.com',
      login: 'other-user'
    });

    const res = await mcpPostWithSession(request(second.app), sessionId)
      .set('Authorization', `Bearer ${otherToken}`)
      .send(createToolCallRequest('hello', { name: 'Foreign' }, 14));
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.error.message, 'Session not found');
  });

  it('rejects recovery when resourcePath does not match', async () => {
    const sessionStore = new InMemoryStandaloneSessionStore();
    const primary = mountAuthMcp(sessionStore);
    const token = await issueTestJwtWithSession(primary.expressMcp.authManager, TEST_GITHUB_USER);
    const authorization = `Bearer ${token}`;
    const sessionId = await createMcpSession(request(primary.app), '/mcp', { authorization });

    const adminMcp = createTestAuthMcp({
      sessionStore,
      resourcePath: '/mcp/admin',
      issuer: 'http://localhost:3000/mcp/admin',
      callbackUrl: 'http://localhost:3000/mcp/admin/auth/callback'
    });
    adminMcp.registerTool(new HelloTool());
    const adminApp = express();
    adminApp.use(express.json());
    adminApp.use('/mcp/admin', adminMcp.router());

    // Admin mount needs its own JWT issuer; reuse the same store row but wrong resourcePath.
    const adminToken = await issueTestJwtWithSession(adminMcp.authManager, TEST_GITHUB_USER);
    const res = await mcpPostWithSession(request(adminApp), sessionId, '/mcp/admin')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(createToolCallRequest('hello', { name: 'Admin' }, 15));
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.error.message, 'Session not found');
  });

  it('keeps Map-miss 404 when auth is disabled (no transport session store)', async () => {
    const app = express();
    app.use(express.json());
    const expressMcp = new ExpressMcp(
      getTestExpressMcpOptions({ enableKnowledgeBase: false })
    );
    expressMcp.registerTool(new HelloTool());
    app.use('/mcp', expressMcp.router());

    const sessionId = await createMcpSession(request(app));
    const restarted = express();
    restarted.use(express.json());
    const second = new ExpressMcp(
      getTestExpressMcpOptions({ enableKnowledgeBase: false })
    );
    second.registerTool(new HelloTool());
    restarted.use('/mcp', second.router());

    const res = await mcpPostWithSession(request(restarted), sessionId)
      .send(createToolCallRequest('hello', { name: 'NoStore' }, 16));
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.error.message, 'Session not found');
  });
});
