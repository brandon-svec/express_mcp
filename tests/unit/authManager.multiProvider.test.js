import { assert } from 'chai';
import request from 'supertest';
import express from 'express';
import { AuthManager } from '../../src/classes/authManager.js';
import { normalizeAuthProviders } from '../../src/authConfig.js';

const JWT_SECRET = 'test-jwt-secret';
const SESSION_SECRET = 'test-session-secret';

function createMultiAuthManager() {
  return new AuthManager({
    providers: {
      github: { clientId: 'gh-id', clientSecret: 'gh-secret' },
      google: { clientId: 'go-id', clientSecret: 'go-secret' }
    },
    callbackUrl: 'http://localhost:3000/auth/callback',
    issuer: 'http://localhost:3000',
    jwtSecret: JWT_SECRET,
    sessionSecret: SESSION_SECRET,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  });
}

describe('AuthManager multi-provider', () => {
  it('normalizeAuthProviders accepts providers map', () => {
    const { enabledProviders } = normalizeAuthProviders({
      callbackUrl: 'http://localhost/cb',
      jwtSecret: 'x',
      sessionSecret: 'y',
      providers: {
        github: { clientId: 'a', clientSecret: 'b' }
      }
    });
    assert.deepEqual(enabledProviders, ['github']);
  });

  it('normalizeAuthProviders maps legacy single-provider config', () => {
    const { providers, enabledProviders } = normalizeAuthProviders({
      provider: 'google',
      clientId: 'cid',
      clientSecret: 'csec'
    });
    assert.deepEqual(enabledProviders, ['google']);
    assert.strictEqual(providers.google.clientId, 'cid');
  });

  it('GET /login shows picker when multiple providers', async () => {
    const auth = createMultiAuthManager();
    const app = express();
    app.use('/auth', auth.createAuthRouter());

    const res = await request(app).get('/auth/login');
    assert.strictEqual(res.status, 200);
    assert.include(res.text, '/auth/login/github');
    assert.include(res.text, '/auth/login/google');
  });

  it('GET /login/:provider redirects to IdP', async () => {
    const auth = createMultiAuthManager();
    const app = express();
    app.use('/auth', auth.createAuthRouter());

    const gh = await request(app).get('/auth/login/github');
    assert.strictEqual(gh.status, 302);
    assert.include(gh.headers.location, 'github.com/login/oauth/authorize');
    assert.include(gh.headers.location, 'client_id=gh-id');

    const go = await request(app).get('/auth/login/google');
    assert.strictEqual(go.status, 302);
    assert.include(go.headers.location, 'accounts.google.com');
    assert.include(go.headers.location, 'client_id=go-id');
  });

  it('GET /login/:provider returns 404 for unknown provider', async () => {
    const auth = createMultiAuthManager();
    const app = express();
    app.use('/auth', auth.createAuthRouter());

    const res = await request(app).get('/auth/login/foo');
    assert.strictEqual(res.status, 404);
  });

  it('GET /login redirects when only one provider enabled', async () => {
    const auth = new AuthManager({
      providers: {
        github: { clientId: 'gh-id', clientSecret: 'gh-secret' }
      },
      callbackUrl: 'http://localhost:3000/auth/callback',
      issuer: 'http://localhost:3000',
      jwtSecret: JWT_SECRET,
      sessionSecret: SESSION_SECRET
    });
    const app = express();
    app.use('/auth', auth.createAuthRouter());

    const res = await request(app).get('/auth/login');
    assert.strictEqual(res.status, 302);
    assert.include(res.headers.location, '/auth/login/github');
  });

  it('GET /debug lists all enabled providers', async () => {
    const auth = createMultiAuthManager();
    const app = express();
    app.use('/auth', auth.createAuthRouter());

    const res = await request(app).get('/auth/debug');
    assert.strictEqual(res.status, 200);
    assert.deepEqual(res.body.enabledProviders, ['github', 'google']);
    assert.lengthOf(res.body.providers, 2);
  });
});
