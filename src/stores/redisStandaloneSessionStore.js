import { assertValidSessionId, contextAliasKey } from './sessionContext.js';

/**
 * @param {string} sessionId
 * @returns {string}
 */
function pendingKey(sessionId) {
  return `mcp:pending:${sessionId}`;
}

/**
 * @param {string} sessionId
 * @returns {string}
 */
function activeKey(sessionId) {
  return `mcp:session:${sessionId}`;
}

/**
 * Redis-backed standalone OAuth session store.
 *
 * @param {import('ioredis').Redis} redis
 */
export class RedisStandaloneSessionStore {
  /**
   * @param {import('ioredis').Redis} redis
   */
  constructor(redis) {
    if (!redis) {
      throw new Error('redis client is required for RedisStandaloneSessionStore');
    }
    this._redis = redis;
  }

  /**
   * @param {string} sessionId
   * @param {Record<string, string>} context
   * @param {string} provider
   * @param {number} pendingTtlSeconds
   * @returns {Promise<void>}
   */
  async createPending(sessionId, context, provider, pendingTtlSeconds) {
    assertValidSessionId(sessionId);
    if (typeof provider !== 'string' || !provider) {
      throw new Error('provider is required');
    }
    if (typeof pendingTtlSeconds !== 'number' || pendingTtlSeconds <= 0) {
      throw new Error('pendingTtlSeconds must be a positive number');
    }
    const value = JSON.stringify({ context, provider });
    await this._redis.set(pendingKey(sessionId), value, 'EX', pendingTtlSeconds);
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<boolean>}
   */
  async hasPending(sessionId) {
    assertValidSessionId(sessionId);
    const exists = await this._redis.exists(pendingKey(sessionId));
    return exists === 1;
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<{ context: Record<string, string>, provider: string }|null>}
   */
  async peekPending(sessionId) {
    assertValidSessionId(sessionId);
    const raw = await this._redis.get(pendingKey(sessionId));
    if (raw === null) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.provider !== 'string') {
      throw new Error(`Invalid pending session payload for ${sessionId}`);
    }
    const context = parsed.context;
    if (!context || typeof context !== 'object' || Array.isArray(context)) {
      throw new Error(`Invalid pending session context for ${sessionId}`);
    }
    return { context, provider: parsed.provider };
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<{ context: Record<string, string>, provider: string }|null>}
   */
  async consumePending(sessionId) {
    assertValidSessionId(sessionId);
    const raw = await this._redis.getdel(pendingKey(sessionId));
    if (raw === null) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.provider !== 'string') {
      throw new Error(`Invalid pending session payload for ${sessionId}`);
    }
    const context = parsed.context;
    if (!context || typeof context !== 'object' || Array.isArray(context)) {
      throw new Error(`Invalid pending session context for ${sessionId}`);
    }
    return { context, provider: parsed.provider };
  }

  /**
   * @param {string} sessionId
   * @param {Object} user
   * @param {number} activeTtlSeconds
   * @param {Record<string, string>} context
   * @returns {Promise<void>}
   */
  async activate(sessionId, user, activeTtlSeconds, context) {
    assertValidSessionId(sessionId);
    if (!user || typeof user !== 'object') {
      throw new Error('user is required');
    }
    if (typeof activeTtlSeconds !== 'number' || activeTtlSeconds <= 0) {
      throw new Error('activeTtlSeconds must be a positive number');
    }
    const value = JSON.stringify({ user, context });
    await this._redis.set(activeKey(sessionId), value, 'EX', activeTtlSeconds);
    if (Object.keys(context).length > 0) {
      await this._redis.set(
        contextAliasKey(context),
        sessionId,
        'EX',
        activeTtlSeconds
      );
    }
  }

  /**
   * @param {Record<string, string>} context
   * @returns {Promise<{ user: Object, context: Record<string, string> }|null>}
   */
  async findActiveByContext(context) {
    if (!context || Object.keys(context).length === 0) {
      return null;
    }
    const sessionId = await this._redis.get(contextAliasKey(context));
    if (sessionId === null || typeof sessionId !== 'string' || !sessionId) {
      return null;
    }
    return this.findActive(sessionId);
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<{ user: Object, context: Record<string, string> }|null>}
   */
  async findActive(sessionId) {
    assertValidSessionId(sessionId);
    const raw = await this._redis.get(activeKey(sessionId));
    if (raw === null) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.user || typeof parsed.user !== 'object') {
      throw new Error(`Invalid active session payload for ${sessionId}`);
    }
    const context = parsed.context;
    if (!context || typeof context !== 'object' || Array.isArray(context)) {
      throw new Error(`Invalid active session context for ${sessionId}`);
    }
    return { user: parsed.user, context };
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<boolean>}
   */
  async deactivate(sessionId) {
    assertValidSessionId(sessionId);
    const raw = await this._redis.get(activeKey(sessionId));
    if (raw === null) {
      return false;
    }
    const parsed = JSON.parse(raw);
    const context = parsed?.context;
    await this._redis.del(activeKey(sessionId));
    await this._redis.del(pendingKey(sessionId));
    if (context && typeof context === 'object' && !Array.isArray(context) && Object.keys(context).length > 0) {
      await this._redis.del(contextAliasKey(context));
    }
    return true;
  }

  /**
   * @param {Record<string, string>} context
   * @returns {Promise<boolean>}
   */
  async deactivateByContext(context) {
    if (!context || Object.keys(context).length === 0) {
      return false;
    }
    const sessionId = await this._redis.get(contextAliasKey(context));
    if (sessionId === null || typeof sessionId !== 'string' || !sessionId) {
      return false;
    }
    return this.deactivate(sessionId);
  }
}
