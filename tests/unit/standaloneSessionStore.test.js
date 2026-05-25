import { expect } from 'chai';
import { InMemoryStandaloneSessionStore } from '../../src/stores/inMemoryStandaloneSessionStore.js';
import { RedisStandaloneSessionStore } from '../../src/stores/redisStandaloneSessionStore.js';
import { ContextAuthRequiredError } from '../../src/stores/errors.js';
import { createTestAuthManager } from '../authTestUtils.js';

const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';

describe('InMemoryStandaloneSessionStore', () => {
  it('creates pending, consumes once, then activates and finds active session', async () => {
    const store = new InMemoryStandaloneSessionStore();
    const context = { telegram_chat_id: 'c1', telegram_user_id: 'u1' };

    await store.createPending(SESSION_ID, context, 'github', 600);
    expect(await store.hasPending(SESSION_ID)).to.equal(true);
    expect(await store.peekPending(SESSION_ID)).to.deep.equal({
      context,
      provider: 'github'
    });

    const pending = await store.consumePending(SESSION_ID);
    expect(pending).to.deep.equal({ context, provider: 'github' });
    expect(await store.hasPending(SESSION_ID)).to.equal(false);
    expect(await store.consumePending(SESSION_ID)).to.equal(null);

    const user = { sub: 'gh:1', email: 'a@b.com', jti: 'jti-1' };
    await store.activate(SESSION_ID, user, 3600, context);

    const active = await store.findActive(SESSION_ID);
    expect(active).to.deep.equal({ user, context });
  });

  it('returns null for missing or expired active session', async () => {
    const store = new InMemoryStandaloneSessionStore();
    expect(await store.findActive(SESSION_ID)).to.equal(null);

    const user = { sub: 'gh:1', email: 'a@b.com' };
    await store.activate(SESSION_ID, user, 1, {});
    await new Promise((resolve) => {
      setTimeout(resolve, 1100);
    });
    expect(await store.findActive(SESSION_ID)).to.equal(null);
  });
});

describe('RedisStandaloneSessionStore', () => {
  it('stores pending and active records with EX ttl', async () => {
    const storage = new Map();
    const redis = {
      async set(key, value, flag, ttl) {
        storage.set(key, { value, flag, ttl });
      },
      async get(key) {
        const entry = storage.get(key);
        return entry ? entry.value : null;
      },
      async getdel(key) {
        const entry = storage.get(key);
        if (!entry) {
          return null;
        }
        storage.delete(key);
        return entry.value;
      },
      async del(key) {
        storage.delete(key);
      },
      async exists(key) {
        return storage.has(key) ? 1 : 0;
      }
    };

    const store = new RedisStandaloneSessionStore(redis);
    const context = { client_ref: 'abc' };
    await store.createPending(SESSION_ID, context, 'google', 120);
    expect(await store.hasPending(SESSION_ID)).to.equal(true);

    const pending = await store.consumePending(SESSION_ID);
    expect(pending).to.deep.equal({ context, provider: 'google' });

    const user = { sub: 'google:1', email: 'a@b.com' };
    await store.activate(SESSION_ID, user, 3600, context);
    const active = await store.findActive(SESSION_ID);
    expect(active).to.deep.equal({ user, context });
  });
});

describe('findActiveByContext', () => {
  it('resolves session via context alias in InMemoryStandaloneSessionStore', async () => {
    const store = new InMemoryStandaloneSessionStore();
    const context = { telegram_chat_id: 'c1', telegram_user_id: 'u1' };
    const user = { sub: 'gh:1', email: 'a@b.com' };
    await store.activate(SESSION_ID, user, 3600, context);

    const active = await store.findActiveByContext(context);
    expect(active).to.deep.equal({ user, context });
  });

  it('returns null when context has no alias', async () => {
    const store = new InMemoryStandaloneSessionStore();
    expect(await store.findActiveByContext({ telegram_chat_id: 'missing' })).to.equal(null);
  });
});

describe('AuthManager getVerifiedSession', () => {
  it('throws ContextAuthRequiredError when session is missing', async () => {
    const store = new InMemoryStandaloneSessionStore();
    const authManager = createTestAuthManager({ sessionStore: store });

    try {
      await authManager.getVerifiedSession(SESSION_ID);
      expect.fail('expected ContextAuthRequiredError');
    } catch (err) {
      expect(err).to.be.instanceOf(ContextAuthRequiredError);
    }
  });

  it('returns user and context for active session', async () => {
    const store = new InMemoryStandaloneSessionStore();
    const authManager = createTestAuthManager({ sessionStore: store });
    const context = { telegram_chat_id: 'c1', telegram_user_id: 'u1' };
    const token = authManager.issueJwt({
      sub: 'google:1',
      login: 'user@example.com',
      email: 'user@example.com',
      provider: 'google'
    });
    const sessionUser = authManager.verifyJwt(token);

    await store.activate(SESSION_ID, sessionUser, 3600, context);

    const session = await authManager.getVerifiedSession(SESSION_ID);
    expect(session.user.email).to.equal('user@example.com');
    expect(session.context).to.deep.equal(context);
  });

  it('throws when sessionStore is not configured', async () => {
    const authManager = createTestAuthManager();

    try {
      await authManager.getVerifiedSession(SESSION_ID);
      expect.fail('expected Error');
    } catch (err) {
      expect(err.message).to.include('sessionStore is not configured');
    }
  });
});

describe('AuthManager getVerifiedSessionByContext', () => {
  it('returns user and context for active session by context alias', async () => {
    const store = new InMemoryStandaloneSessionStore();
    const authManager = createTestAuthManager({ sessionStore: store });
    const context = { telegram_chat_id: 'c1', telegram_user_id: 'u1' };
    const token = authManager.issueJwt({
      sub: 'google:1',
      login: 'user@example.com',
      email: 'user@example.com',
      provider: 'google'
    });
    const sessionUser = authManager.verifyJwt(token);
    await store.activate(SESSION_ID, sessionUser, 3600, context);

    const session = await authManager.getVerifiedSessionByContext(context);
    expect(session.user.email).to.equal('user@example.com');
    expect(session.context).to.deep.equal(context);
  });

  it('throws ContextAuthRequiredError when no active session for context', async () => {
    const store = new InMemoryStandaloneSessionStore();
    const authManager = createTestAuthManager({ sessionStore: store });

    try {
      await authManager.getVerifiedSessionByContext({
        telegram_chat_id: 'c1',
        telegram_user_id: 'u1'
      });
      expect.fail('expected ContextAuthRequiredError');
    } catch (err) {
      expect(err).to.be.instanceOf(ContextAuthRequiredError);
    }
  });
});
