import { expect } from 'chai';
import request from 'supertest';
import express from 'express';
import {
  createTestAuthManager,
  createOAuthTestApp,
  createPkcePair,
  mockExchangeCodeForUser,
  registerOAuthTestClient,
  TEST_AUTH
} from '../authTestUtils.js';
import { InMemoryStandaloneSessionStore } from '../../src/stores/inMemoryStandaloneSessionStore.js';
import { isUuidV4SessionId } from '../../src/stores/sessionContext.js';

function createAuthRouterApp(authManager) {
  const app = express();
  app.use(express.json());
  app.use('/mcp/auth', authManager.createAuthRouter());
  return app;
}

describe('AuthManager standalone session login', () => {
  describe('POST /mcp/auth/login-url', () => {
    it('returns session_id and login_url with session_id query param', async () => {
      const store = new InMemoryStandaloneSessionStore();
      const authManager = createTestAuthManager({
        sessionStore: store,
        enabledProviders: ['google'],
        providers: { google: TEST_AUTH.google }
      });
      const app = createAuthRouterApp(authManager);

      const res = await request(app)
        .post('/mcp/auth/login-url')
        .send({
          context: {
            telegram_chat_id: '12345',
            telegram_user_id: '67890'
          }
        });

      expect(res.status).to.equal(200);
      expect(res.body.session_id).to.be.a('string');
      expect(isUuidV4SessionId(res.body.session_id)).to.equal(true);
      expect(res.body.login_url).to.be.a('string');
      expect(res.body.login_url).to.include('session_id=');
      expect(res.body.login_url).to.include(res.body.session_id);
      expect(res.body.login_url).not.to.include('telegram_chat_id');
    });

    it('rejects invalid context values', async () => {
      const store = new InMemoryStandaloneSessionStore();
      const authManager = createTestAuthManager({ sessionStore: store });
      const app = createAuthRouterApp(authManager);

      const res = await request(app)
        .post('/mcp/auth/login-url')
        .send({ context: { telegram_chat_id: '' } });

      expect(res.status).to.equal(400);
    });
  });

  describe('GET /mcp/auth/login with session_id', () => {
    it('redirects to provider when pending session exists', async () => {
      const store = new InMemoryStandaloneSessionStore();
      const authManager = createTestAuthManager({ sessionStore: store });
      const app = createAuthRouterApp(authManager);

      const created = await request(app)
        .post('/mcp/auth/login-url')
        .send({ context: { ref: 'abc' } });

      const sessionId = created.body.session_id;
      const loginRes = await request(app)
        .get(`/mcp/auth/login/github?session_id=${encodeURIComponent(sessionId)}`)
        .redirects(0);

      expect(loginRes.status).to.equal(302);
      const location = new URL(loginRes.headers.location);
      expect(location.searchParams.get('state')).to.equal(sessionId);
    });

    it('returns 400 for unknown or expired session_id', async () => {
      const store = new InMemoryStandaloneSessionStore();
      const authManager = createTestAuthManager({ sessionStore: store });
      const app = createAuthRouterApp(authManager);

      const loginRes = await request(app)
        .get('/mcp/auth/login/github?session_id=550e8400-e29b-41d4-a716-446655440000')
        .redirects(0);

      expect(loginRes.status).to.equal(400);
    });
  });

  describe('standalone OAuth callback', () => {
    it('activates session and returns user + context via getVerifiedSession', async () => {
      const store = new InMemoryStandaloneSessionStore();
      const authManager = createTestAuthManager({ sessionStore: store });
      mockExchangeCodeForUser(authManager);
      const app = createAuthRouterApp(authManager);

      const created = await request(app)
        .post('/mcp/auth/login-url')
        .send({
          context: {
            telegram_chat_id: '12345',
            telegram_user_id: '67890'
          }
        });

      const sessionId = created.body.session_id;
      const loginRes = await request(app)
        .get(`/mcp/auth/login/github?session_id=${encodeURIComponent(sessionId)}`)
        .redirects(0);
      const oauthState = new URL(loginRes.headers.location).searchParams.get('state');

      const cbRes = await request(app)
        .get('/mcp/auth/callback')
        .query({ code: 'github-auth-code', state: oauthState });

      expect(cbRes.status).to.equal(200);

      const session = await authManager.getVerifiedSession(sessionId);
      expect(session.user.email).to.equal('test@example.com');
      expect(session.context).to.deep.equal({
        telegram_chat_id: '12345',
        telegram_user_id: '67890'
      });
    });

    it('invokes onTokenIssued with stored context', async () => {
      let capturedContext = null;
      const store = new InMemoryStandaloneSessionStore();
      const authManager = createTestAuthManager({
        sessionStore: store,
        onTokenIssued: async (_user, _token, context) => {
          capturedContext = context;
        }
      });
      mockExchangeCodeForUser(authManager);
      const app = createAuthRouterApp(authManager);

      const created = await request(app)
        .post('/mcp/auth/login-url')
        .send({ context: { telegram_chat_id: '1', telegram_user_id: '2' } });

      const sessionId = created.body.session_id;
      const loginRes = await request(app)
        .get(`/mcp/auth/login/github?session_id=${encodeURIComponent(sessionId)}`)
        .redirects(0);
      const oauthState = new URL(loginRes.headers.location).searchParams.get('state');

      await request(app)
        .get('/mcp/auth/callback')
        .query({ code: 'github-auth-code', state: oauthState });

      expect(capturedContext).to.deep.equal({
        telegram_chat_id: '1',
        telegram_user_id: '2'
      });
    });

    it('rejects callback replay for the same session_id', async () => {
      const store = new InMemoryStandaloneSessionStore();
      const authManager = createTestAuthManager({ sessionStore: store });
      mockExchangeCodeForUser(authManager);
      const app = createAuthRouterApp(authManager);

      const created = await request(app)
        .post('/mcp/auth/login-url')
        .send({ context: { ref: 'x' } });

      const sessionId = created.body.session_id;
      const loginRes = await request(app)
        .get(`/mcp/auth/login/github?session_id=${encodeURIComponent(sessionId)}`)
        .redirects(0);
      const oauthState = new URL(loginRes.headers.location).searchParams.get('state');

      await request(app)
        .get('/mcp/auth/callback')
        .query({ code: 'github-auth-code', state: oauthState });

      const replay = await request(app)
        .get('/mcp/auth/callback')
        .query({ code: 'github-auth-code', state: oauthState });

      expect(replay.status).to.equal(400);
    });

    it('does not invoke onTokenIssued during PKCE MCP authorize flow', async () => {
      let callbackCalls = 0;
      const store = new InMemoryStandaloneSessionStore();
      const authManager = createTestAuthManager({
        sessionStore: store,
        onTokenIssued: async () => {
          callbackCalls += 1;
        }
      });
      mockExchangeCodeForUser(authManager);
      const { codeChallenge } = createPkcePair();
      const client = registerOAuthTestClient(authManager);
      const app = createOAuthTestApp(authManager);

      const authorizeRes = await request(app)
        .get('/mcp/authorize')
        .query({
          client_id: client.client_id,
          redirect_uri: 'cursor://callback',
          response_type: 'code',
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          state: 'mcp-client-state'
        });

      const idpState = new URL(authorizeRes.headers.location).searchParams.get('state');
      await request(app)
        .get('/mcp/auth/callback')
        .query({ state: idpState, code: 'github-auth-code' });

      expect(callbackCalls).to.equal(0);
    });
  });
});
