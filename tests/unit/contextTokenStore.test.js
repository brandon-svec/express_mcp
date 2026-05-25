import { expect } from 'chai';
import jwt from 'jsonwebtoken';
import { InMemoryContextTokenStore } from '../../src/stores/inMemoryContextTokenStore.js';
import { RedisContextTokenStore } from '../../src/stores/redisContextTokenStore.js';
import { ContextAuthRequiredError } from '../../src/stores/errors.js';
import { createTestAuthManager } from '../authTestUtils.js';
import { redisContextKey } from '../../src/stores/contextKey.js';

const JWT_SECRET = 'test-jwt-secret';

describe('InMemoryContextTokenStore', () => {
  it('upserts and finds jwt by context (key order independent)', async () => {
    const store = new InMemoryContextTokenStore();
    const token = jwt.sign({ sub: 'u1' }, JWT_SECRET, { expiresIn: '1h' });
    await store.upsert(
      { telegram_chat_id: 'c1', telegram_user_id: 'u1' },
      { email: 'a@b.com' },
      token
    );

    const found = await store.find({
      telegram_user_id: 'u1',
      telegram_chat_id: 'c1'
    });

    expect(found).to.equal(token);
  });

  it('returns null when context is missing', async () => {
    const store = new InMemoryContextTokenStore();
    const token = jwt.sign({ sub: 'u1' }, JWT_SECRET, { expiresIn: '1h' });
    await store.upsert(
      { telegram_chat_id: 'c1', telegram_user_id: 'u1' },
      {},
      token
    );

    const found = await store.find({
      telegram_chat_id: 'c1',
      telegram_user_id: 'other'
    });

    expect(found).to.equal(null);
  });

  it('returns null after jwt expires', async () => {
    const store = new InMemoryContextTokenStore();
    const token = jwt.sign({ sub: 'u1' }, JWT_SECRET, { expiresIn: -1 });
    await store.upsert(
      { telegram_chat_id: 'c1', telegram_user_id: 'u1' },
      {},
      token
    );

    const found = await store.find({
      telegram_chat_id: 'c1',
      telegram_user_id: 'u1'
    });

    expect(found).to.equal(null);
  });
});

describe('RedisContextTokenStore', () => {
  it('stores jwt with EX ttl derived from exp claim', async () => {
    const storage = new Map();
    const redis = {
      async set(key, value, flag, ttl) {
        storage.set(key, { value, flag, ttl });
      },
      async get(key) {
        const entry = storage.get(key);
        return entry ? entry.value : null;
      }
    };

    const store = new RedisContextTokenStore(redis);
    const token = jwt.sign({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 3600 }, JWT_SECRET);
    const context = { telegram_chat_id: 'c1', telegram_user_id: 'u1' };

    await store.upsert(context, {}, token);

    const key = redisContextKey(context);
    const entry = storage.get(key);
    expect(entry.flag).to.equal('EX');
    expect(entry.ttl).to.be.a('number');
    expect(entry.ttl).to.be.greaterThan(0);

    const found = await store.find(context);
    expect(found).to.equal(token);
  });
});

describe('AuthManager getVerifiedContextUser', () => {
  it('throws ContextAuthRequiredError when no stored session', async () => {
    const store = new InMemoryContextTokenStore();
    const authManager = createTestAuthManager({ contextTokenStore: store });

    try {
      await authManager.getVerifiedContextUser({
        telegram_chat_id: 'c1',
        telegram_user_id: 'u1'
      });
      expect.fail('expected ContextAuthRequiredError');
    } catch (err) {
      expect(err).to.be.instanceOf(ContextAuthRequiredError);
    }
  });

  it('returns verified JWT payload when session exists', async () => {
    const store = new InMemoryContextTokenStore();
    const authManager = createTestAuthManager({ contextTokenStore: store });
    const token = authManager.issueJwt({
      sub: 'google:1',
      login: 'user@example.com',
      email: 'user@example.com',
      provider: 'google'
    });

    await store.upsert(
      { telegram_chat_id: 'c1', telegram_user_id: 'u1' },
      { email: 'user@example.com' },
      token
    );

    const user = await authManager.getVerifiedContextUser({
      telegram_chat_id: 'c1',
      telegram_user_id: 'u1'
    });

    expect(user.email).to.equal('user@example.com');
    expect(user.sub).to.equal('google:1');
  });

  it('throws when contextTokenStore is not configured', async () => {
    const authManager = createTestAuthManager();

    try {
      await authManager.getVerifiedContextUser({
        telegram_chat_id: 'c1',
        telegram_user_id: 'u1'
      });
      expect.fail('expected Error');
    } catch (err) {
      expect(err.message).to.include('contextTokenStore is not configured');
    }
  });
});
