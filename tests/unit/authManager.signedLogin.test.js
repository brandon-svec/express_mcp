import { expect } from 'chai';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import {
  createTestAuthManager,
  createOAuthTestApp,
  createPkcePair,
  mockExchangeCodeForUser,
  registerOAuthTestClient,
  TEST_AUTH
} from '../authTestUtils.js';

function createAuthRouterApp(authManager) {
  const app = express();
  app.use(express.json());
  app.use('/mcp/auth', authManager.createAuthRouter());
  return app;
}

describe('AuthManager signed login state', () => {
  describe('POST /mcp/auth/login-url', () => {
    it('returns login_url with signed state for valid context', async () => {
      const authManager = createTestAuthManager({
        loginContextParams: ['telegram_chat_id', 'telegram_user_id'],
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
      expect(res.body.login_url).to.be.a('string');
      expect(res.body.login_url).to.include('?state=');
      expect(res.body.login_url).not.to.include('telegram_chat_id');
      expect(res.body.login_url).not.to.include('telegram_user_id');

      const url = new URL(res.body.login_url);
      const token = url.searchParams.get('state');
      const payload = jwt.verify(token, TEST_AUTH.jwtSecret);
      expect(payload.purpose).to.equal('login_state');
      expect(payload.context).to.deep.equal({
        telegram_chat_id: '12345',
        telegram_user_id: '67890'
      });
    });

    it('rejects context keys not in loginContextParams', async () => {
      const authManager = createTestAuthManager({
        loginContextParams: ['telegram_chat_id']
      });
      const app = createAuthRouterApp(authManager);

      const res = await request(app)
        .post('/mcp/auth/login-url')
        .send({ context: { telegram_user_id: '67890' } });

      expect(res.status).to.equal(400);
    });

    it('rejects non-empty context when loginContextParams is empty', async () => {
      const authManager = createTestAuthManager({
        loginContextParams: []
      });
      const app = createAuthRouterApp(authManager);

      const res = await request(app)
        .post('/mcp/auth/login-url')
        .send({ context: { telegram_chat_id: '12345' } });

      expect(res.status).to.equal(400);
    });
  });

  describe('GET /mcp/auth/login/google?state=', () => {
    it('redirects to Google when state token is valid', async () => {
      const authManager = createTestAuthManager({
        loginContextParams: ['telegram_chat_id', 'telegram_user_id'],
        providers: { google: TEST_AUTH.google }
      });
      const app = createAuthRouterApp(authManager);
      const stateToken = authManager.issueLoginStateToken({
        telegram_chat_id: '12345',
        telegram_user_id: '67890'
      });

      const res = await request(app)
        .get(`/mcp/auth/login/google?state=${encodeURIComponent(stateToken)}`)
        .redirects(0);

      expect(res.status).to.equal(302);
      expect(res.headers.location).to.include('accounts.google.com');
    });

    it('returns 400 for expired state token', async () => {
      const authManager = createTestAuthManager({
        loginContextParams: ['telegram_chat_id'],
        loginStateExpiresIn: '0s'
      });
      const app = createAuthRouterApp(authManager);
      const stateToken = authManager.issueLoginStateToken({
        telegram_chat_id: '12345'
      });

      await new Promise((resolve) => setTimeout(resolve, 1100));

      const res = await request(app)
        .get(`/mcp/auth/login/github?state=${encodeURIComponent(stateToken)}`);

      expect(res.status).to.equal(400);
      expect(res.text).to.include('Invalid or expired login link');
    });

    it('returns 400 for wrong-purpose JWT', async () => {
      const authManager = createTestAuthManager({
        loginContextParams: ['telegram_chat_id']
      });
      const app = createAuthRouterApp(authManager);
      const badToken = jwt.sign(
        { context: {}, purpose: 'other' },
        TEST_AUTH.jwtSecret,
        { expiresIn: '10m' }
      );

      const res = await request(app)
        .get(`/mcp/auth/login/github?state=${encodeURIComponent(badToken)}`);

      expect(res.status).to.equal(400);
    });

    it('returns 400 for tampered state token', async () => {
      const authManager = createTestAuthManager({
        loginContextParams: ['telegram_chat_id']
      });
      const app = createAuthRouterApp(authManager);
      const stateToken = authManager.issueLoginStateToken({
        telegram_chat_id: '12345'
      });
      const tampered = `${stateToken}x`;

      const res = await request(app)
        .get(`/mcp/auth/login/github?state=${encodeURIComponent(tampered)}`);

      expect(res.status).to.equal(400);
    });

    it('allows login without state (empty loginContext)', async () => {
      const authManager = createTestAuthManager({
        loginContextParams: ['telegram_chat_id']
      });
      const app = createAuthRouterApp(authManager);

      const res = await request(app)
        .get('/mcp/auth/login/github')
        .redirects(0);

      expect(res.status).to.equal(302);
    });
  });

  describe('onTokenIssued callback', () => {
    it('invokes callback with context on standalone OAuth success', async () => {
      let callbackCalls = 0;
      let capturedContext = null;
      const authManager = createTestAuthManager({
        loginContextParams: ['telegram_chat_id', 'telegram_user_id'],
        onTokenIssued: async (user, token, context) => {
          callbackCalls += 1;
          capturedContext = context;
          expect(user.email).to.equal('test@example.com');
          expect(token).to.be.a('string');
        }
      });
      mockExchangeCodeForUser(authManager);

      const app = createAuthRouterApp(authManager);
      const agent = request.agent(app);
      const stateToken = authManager.issueLoginStateToken({
        telegram_chat_id: '12345',
        telegram_user_id: '67890'
      });

      const loginRes = await agent
        .get(`/mcp/auth/login/github?state=${encodeURIComponent(stateToken)}`)
        .redirects(0);

      expect(loginRes.status).to.equal(302);
      const oauthState = new URL(loginRes.headers.location).searchParams.get('state');
      expect(oauthState).to.be.a('string');

      const cbRes = await agent
        .get('/mcp/auth/callback')
        .query({ code: 'github-auth-code', state: oauthState });

      expect(cbRes.status).to.equal(200);
      expect(callbackCalls).to.equal(1);
      expect(capturedContext).to.deep.equal({
        telegram_chat_id: '12345',
        telegram_user_id: '67890'
      });
    });

    it('redirects to postLoginRedirectUrl after standalone OAuth when configured', async () => {
      const authManager = createTestAuthManager({
        loginContextParams: ['telegram_chat_id'],
        postLoginRedirectUrl: 'https://t.me/echoharvest_bot'
      });
      mockExchangeCodeForUser(authManager);

      const app = createAuthRouterApp(authManager);
      const agent = request.agent(app);
      const loginRes = await agent.get('/mcp/auth/login/github').redirects(0);
      const oauthState = new URL(loginRes.headers.location).searchParams.get('state');

      const cbRes = await agent
        .get('/mcp/auth/callback')
        .query({ code: 'github-auth-code', state: oauthState })
        .redirects(0);

      expect(cbRes.status).to.equal(302);
      expect(cbRes.headers.location).to.equal('https://t.me/echoharvest_bot');
    });

    it('does not invoke onTokenIssued during PKCE MCP authorize flow', async () => {
      let callbackCalls = 0;
      const authManager = createTestAuthManager({
        loginContextParams: ['telegram_chat_id'],
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

    it('still returns success page when onTokenIssued throws', async () => {
      const authManager = createTestAuthManager({
        loginContextParams: ['telegram_chat_id'],
        onTokenIssued: async () => {
          throw new Error('callback failed');
        }
      });
      mockExchangeCodeForUser(authManager);

      const app = createAuthRouterApp(authManager);
      const agent = request.agent(app);
      const loginRes = await agent.get('/mcp/auth/login/github').redirects(0);
      const oauthState = new URL(loginRes.headers.location).searchParams.get('state');

      const cbRes = await agent
        .get('/mcp/auth/callback')
        .query({ code: 'github-auth-code', state: oauthState });

      expect(cbRes.status).to.equal(200);
      expect(cbRes.text).to.include('Signed in');
    });
  });
});
