/**
 * Shared auth and OAuth test fixtures for ExpressMcp test suite.
 */

import { createHash, randomBytes, randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import express, { Router } from 'express';
import { AuthManager } from '../src/classes/authManager.js';
import { ExpressMcp } from '../src/index.js';
import { InMemoryStandaloneSessionStore } from '../src/stores/inMemoryStandaloneSessionStore.js';
import { getTestExpressMcpOptions } from './config.js';

export const TEST_AUTH = {
  jwtSecret: 'test-jwt-secret-at-least-32-chars!!',
  sessionSecret: 'test-session-secret-at-least-32!!',
  origin: 'http://localhost:3000',
  issuer: 'http://localhost:3000/mcp',
  resourcePath: '/mcp',
  callbackUrl: 'http://localhost:3000/mcp/auth/callback',
  authPath: '/mcp/auth',
  jwtExpiresIn: '1h',
  github: {
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret'
  },
  githubAlt: {
    clientId: 'gh-id',
    clientSecret: 'gh-secret'
  },
  google: {
    clientId: 'go-id',
    clientSecret: 'go-secret'
  }
};

export const TEST_GITHUB_USER = {
  sub: 'gh:1',
  login: 'test-user',
  name: 'Test User',
  email: 'test@example.com',
  provider: 'github'
};

export const silentTestLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {}
};

/**
 * @param {Object} [overrides]
 * @returns {AuthManager}
 */
export function createTestAuthManager(overrides = {}) {
  const sessionStore = Object.hasOwn(overrides, 'sessionStore')
    ? overrides.sessionStore
    : new InMemoryStandaloneSessionStore();
  const rest = { ...overrides };
  delete rest.sessionStore;
  return new AuthManager({
    providers: {
      github: TEST_AUTH.githubAlt
    },
    callbackUrl: TEST_AUTH.callbackUrl,
    issuer: TEST_AUTH.issuer,
    resourcePath: TEST_AUTH.resourcePath,
    authPath: TEST_AUTH.authPath,
    jwtSecret: TEST_AUTH.jwtSecret,
    sessionSecret: TEST_AUTH.sessionSecret,
    jwtExpiresIn: TEST_AUTH.jwtExpiresIn,
    logger: silentTestLogger,
    sessionStore,
    ...rest
  });
}

/**
 * @param {Object} [authOverrides]
 * @returns {ExpressMcp}
 */
export function createTestAuthMcp(authOverrides = {}) {
  return new ExpressMcp(
    getTestExpressMcpOptions({
      enableKnowledgeBase: false,
      auth: {
        enabled: true,
        provider: 'github',
        clientId: TEST_AUTH.github.clientId,
        clientSecret: TEST_AUTH.github.clientSecret,
        callbackUrl: TEST_AUTH.callbackUrl,
        issuer: TEST_AUTH.issuer,
        resourcePath: TEST_AUTH.resourcePath,
        jwtSecret: TEST_AUTH.jwtSecret,
        jwtExpiresIn: TEST_AUTH.jwtExpiresIn,
        sessionSecret: TEST_AUTH.sessionSecret,
        sessionStore: authOverrides.sessionStore || new InMemoryStandaloneSessionStore(),
        ...authOverrides
      }
    })
  );
}

/**
 * @param {Object} payload
 * @param {string} [expiresIn]
 * @returns {string}
 */
export function issueTestJwt(payload, expiresIn = TEST_AUTH.jwtExpiresIn) {
  return jwt.sign({ jti: randomUUID(), ...payload }, TEST_AUTH.jwtSecret, { expiresIn });
}

/**
 * Issue a test JWT and persist it in the auth manager session store (required for Bearer auth).
 * @param {AuthManager} authManager
 * @param {Object} payload
 * @param {string} [expiresIn]
 * @returns {Promise<string>}
 */
export async function issueTestJwtWithSession(authManager, payload, expiresIn = TEST_AUTH.jwtExpiresIn) {
  const token = issueTestJwt(payload, expiresIn);
  await authManager.persistAccessTokenSession(token, {});
  return token;
}

/**
 * @returns {{ codeVerifier: string, codeChallenge: string }}
 */
export function createPkcePair() {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

/**
 * @param {AuthManager} authManager
 * @param {string} [redirectUri]
 * @returns {Object}
 */
export function registerOAuthTestClient(authManager, redirectUri = 'cursor://callback') {
  return authManager.oauthClients.register({
    client_name: 'Cursor',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code'],
    response_types: ['code']
  });
}

/**
 * @param {AuthManager} authManager
 * @param {Object} [user]
 */
export function mockExchangeCodeForUser(authManager, user = TEST_GITHUB_USER) {
  authManager.exchangeCodeForUser = async () => user;
}

/**
 * @param {AuthManager} authManager
 * @param {{ mcpRouter?: import('express').Router }} [options]
 * @returns {import('express').Express}
 */
export function createOAuthTestApp(authManager, { mcpRouter } = {}) {
  const router = mcpRouter ?? Router();
  if (!mcpRouter) {
    router.post('/', ...authManager.protectedMiddleware(), (_req, res) => {
      res.json({ ok: true });
    });
  }

  const app = express();
  app.use(express.json());
  app.use(authManager.createHttpRouter({ mcpRouter: router }));
  return app;
}
