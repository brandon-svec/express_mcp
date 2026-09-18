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
 * @param {string} refreshToken
 * @returns {string}
 */
function refreshKey(refreshToken) {
  return `mcp:refresh:${refreshToken}`;
}

/**
 * @param {string} sub
 * @returns {string}
 */
function idpGrantKey(sub) {
  return `mcp:idp-grant:${sub}`;
}

/**
 * @param {unknown} details
 * @returns {{ purpose: string, scopes: string[], sub: string|null }}
 */
function normalizePendingDetails(details) {
  if (details === undefined || details === null) {
    return { purpose: 'login', scopes: [], sub: null };
  }
  if (typeof details !== 'object' || Array.isArray(details)) {
    throw new Error('pending details must be an object when provided');
  }
  const purpose =
    typeof details.purpose === 'string' && details.purpose
      ? details.purpose
      : 'login';
  const scopes = Array.isArray(details.scopes)
    ? details.scopes.filter((s) => typeof s === 'string' && s)
    : [];
  const sub =
    typeof details.sub === 'string' && details.sub ? details.sub : null;
  return { purpose, scopes, sub };
}

/**
 * @param {{ context: Record<string, string>, provider: string, purpose?: string, scopes?: string[], sub?: string|null }} parsed
 * @returns {{ context: Record<string, string>, provider: string, purpose: string, scopes: string[], sub: string|null }}
 */
function pendingPublicView(parsed) {
  return {
    context: parsed.context,
    provider: parsed.provider,
    purpose: parsed.purpose || 'login',
    scopes: Array.isArray(parsed.scopes) ? parsed.scopes : [],
    sub: parsed.sub || null
  };
}

/**
 * @param {string} raw
 * @param {string} sessionId
 * @returns {{ context: Record<string, string>, provider: string, purpose: string, scopes: string[], sub: string|null }}
 */
function parsePendingPayload(raw, sessionId) {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed.provider !== 'string') {
    throw new Error(`Invalid pending session payload for ${sessionId}`);
  }
  const context = parsed.context;
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw new Error(`Invalid pending session context for ${sessionId}`);
  }
  return pendingPublicView(parsed);
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
   * @param {{ purpose?: string, scopes?: string[], sub?: string }} [details]
   * @returns {Promise<void>}
   */
  async createPending(sessionId, context, provider, pendingTtlSeconds, details) {
    assertValidSessionId(sessionId);
    if (typeof provider !== 'string' || !provider) {
      throw new Error('provider is required');
    }
    if (typeof pendingTtlSeconds !== 'number' || pendingTtlSeconds <= 0) {
      throw new Error('pendingTtlSeconds must be a positive number');
    }
    const normalized = normalizePendingDetails(details);
    const value = JSON.stringify({
      context,
      provider,
      purpose: normalized.purpose,
      scopes: normalized.scopes,
      sub: normalized.sub
    });
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
   * @returns {Promise<{ context: Record<string, string>, provider: string, purpose: string, scopes: string[], sub: string|null }|null>}
   */
  async peekPending(sessionId) {
    assertValidSessionId(sessionId);
    const raw = await this._redis.get(pendingKey(sessionId));
    if (raw === null) {
      return null;
    }
    return parsePendingPayload(raw, sessionId);
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<{ context: Record<string, string>, provider: string, purpose: string, scopes: string[], sub: string|null }|null>}
   */
  async consumePending(sessionId) {
    assertValidSessionId(sessionId);
    const raw = await this._redis.getdel(pendingKey(sessionId));
    if (raw === null) {
      return null;
    }
    return parsePendingPayload(raw, sessionId);
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

  /**
   * Persist an opaque OAuth refresh token bound to user + DCR client.
   * @param {string} refreshToken
   * @param {{ user: Object, clientId: string }} entry
   * @param {number} ttlSeconds
   * @returns {Promise<void>}
   */
  async storeRefreshToken(refreshToken, entry, ttlSeconds) {
    if (typeof refreshToken !== 'string' || !refreshToken) {
      throw new Error('refreshToken is required');
    }
    if (!entry || typeof entry !== 'object' || !entry.user || typeof entry.clientId !== 'string' || !entry.clientId) {
      throw new Error('refresh token entry requires user and clientId');
    }
    if (typeof ttlSeconds !== 'number' || ttlSeconds <= 0) {
      throw new Error('ttlSeconds must be a positive number');
    }
    const value = JSON.stringify({ user: entry.user, clientId: entry.clientId });
    await this._redis.set(refreshKey(refreshToken), value, 'EX', ttlSeconds);
  }

  /**
   * @param {string} refreshToken
   * @returns {Promise<{ user: Object, clientId: string }|null>}
   */
  async findRefreshToken(refreshToken) {
    if (typeof refreshToken !== 'string' || !refreshToken) {
      throw new Error('refreshToken is required');
    }
    const raw = await this._redis.get(refreshKey(refreshToken));
    if (raw === null) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.user || typeof parsed.user !== 'object') {
      throw new Error('Invalid refresh token payload');
    }
    if (typeof parsed.clientId !== 'string' || !parsed.clientId) {
      throw new Error('Invalid refresh token payload: missing clientId');
    }
    return { user: parsed.user, clientId: parsed.clientId };
  }

  /**
   * @param {string} refreshToken
   * @returns {Promise<boolean>}
   */
  async deleteRefreshToken(refreshToken) {
    if (typeof refreshToken !== 'string' || !refreshToken) {
      throw new Error('refreshToken is required');
    }
    const deleted = await this._redis.del(refreshKey(refreshToken));
    return deleted > 0;
  }

  /**
   * Persist an encrypted Google IdP refresh grant for a user sub.
   * @param {string} sub
   * @param {{ sealedRefreshToken: string, scopes: string[], updatedAt: string }} grant
   * @returns {Promise<void>}
   */
  async storeIdpGrant(sub, grant) {
    if (typeof sub !== 'string' || !sub) {
      throw new Error('sub is required');
    }
    if (!grant || typeof grant !== 'object') {
      throw new Error('grant is required');
    }
    if (typeof grant.sealedRefreshToken !== 'string' || !grant.sealedRefreshToken) {
      throw new Error('grant.sealedRefreshToken is required');
    }
    if (!Array.isArray(grant.scopes)) {
      throw new Error('grant.scopes must be an array');
    }
    if (typeof grant.updatedAt !== 'string' || !grant.updatedAt) {
      throw new Error('grant.updatedAt is required');
    }
    const value = JSON.stringify({
      sealedRefreshToken: grant.sealedRefreshToken,
      scopes: grant.scopes,
      updatedAt: grant.updatedAt
    });
    await this._redis.set(idpGrantKey(sub), value);
  }

  /**
   * @param {string} sub
   * @returns {Promise<{ sealedRefreshToken: string, scopes: string[], updatedAt: string }|null>}
   */
  async findIdpGrant(sub) {
    if (typeof sub !== 'string' || !sub) {
      throw new Error('sub is required');
    }
    const raw = await this._redis.get(idpGrantKey(sub));
    if (raw === null) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.sealedRefreshToken !== 'string' || !parsed.sealedRefreshToken) {
      throw new Error('Invalid idp grant payload: missing sealedRefreshToken');
    }
    if (!Array.isArray(parsed.scopes)) {
      throw new Error('Invalid idp grant payload: scopes must be an array');
    }
    if (typeof parsed.updatedAt !== 'string' || !parsed.updatedAt) {
      throw new Error('Invalid idp grant payload: missing updatedAt');
    }
    return {
      sealedRefreshToken: parsed.sealedRefreshToken,
      scopes: parsed.scopes,
      updatedAt: parsed.updatedAt
    };
  }

  /**
   * @param {string} sub
   * @returns {Promise<boolean>}
   */
  async deleteIdpGrant(sub) {
    if (typeof sub !== 'string' || !sub) {
      throw new Error('sub is required');
    }
    const deleted = await this._redis.del(idpGrantKey(sub));
    return deleted > 0;
  }
}
