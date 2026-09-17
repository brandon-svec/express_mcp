import { assertValidSessionId, contextAliasKey } from './sessionContext.js';

/**
 * In-process standalone OAuth session store (pending + active).
 */
export class InMemoryStandaloneSessionStore {
  constructor() {
    /** @type {Map<string, { context: Record<string, string>, provider: string, expiresAt: number }>} */
    this._pending = new Map();
    /** @type {Map<string, { user: Object, context: Record<string, string>, expiresAt: number }>} */
    this._active = new Map();
    /** @type {Map<string, string>} */
    this._contextAlias = new Map();
    /** @type {Map<string, { user: Object, clientId: string, expiresAt: number }>} */
    this._refreshTokens = new Map();
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
    const expiresAt = Math.floor(Date.now() / 1000) + pendingTtlSeconds;
    this._pending.set(sessionId, { context, provider, expiresAt });
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<boolean>}
   */
  async hasPending(sessionId) {
    assertValidSessionId(sessionId);
    const entry = this._getPendingEntry(sessionId);
    return entry !== null;
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<{ context: Record<string, string>, provider: string }|null>}
   */
  async peekPending(sessionId) {
    assertValidSessionId(sessionId);
    const entry = this._getPendingEntry(sessionId);
    if (!entry) {
      return null;
    }
    return { context: entry.context, provider: entry.provider };
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<{ context: Record<string, string>, provider: string }|null>}
   */
  async consumePending(sessionId) {
    assertValidSessionId(sessionId);
    const entry = this._getPendingEntry(sessionId);
    if (!entry) {
      return null;
    }
    this._pending.delete(sessionId);
    return { context: entry.context, provider: entry.provider };
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
    const expiresAt = Math.floor(Date.now() / 1000) + activeTtlSeconds;
    this._active.set(sessionId, { user, context, expiresAt });
    if (Object.keys(context).length > 0) {
      this._contextAlias.set(contextAliasKey(context), sessionId);
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
    const sessionId = this._contextAlias.get(contextAliasKey(context));
    if (!sessionId) {
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
    const entry = this._active.get(sessionId);
    if (!entry) {
      return null;
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (entry.expiresAt <= nowSeconds) {
      this._active.delete(sessionId);
      if (entry.context && Object.keys(entry.context).length > 0) {
        this._contextAlias.delete(contextAliasKey(entry.context));
      }
      return null;
    }
    return { user: entry.user, context: entry.context };
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<boolean>}
   */
  async deactivate(sessionId) {
    assertValidSessionId(sessionId);
    const entry = this._active.get(sessionId);
    if (!entry) {
      return false;
    }
    this._active.delete(sessionId);
    if (entry.context && Object.keys(entry.context).length > 0) {
      this._contextAlias.delete(contextAliasKey(entry.context));
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
    const sessionId = this._contextAlias.get(contextAliasKey(context));
    if (!sessionId) {
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
    const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
    this._refreshTokens.set(refreshToken, {
      user: entry.user,
      clientId: entry.clientId,
      expiresAt
    });
  }

  /**
   * @param {string} refreshToken
   * @returns {Promise<{ user: Object, clientId: string }|null>}
   */
  async findRefreshToken(refreshToken) {
    if (typeof refreshToken !== 'string' || !refreshToken) {
      throw new Error('refreshToken is required');
    }
    const entry = this._refreshTokens.get(refreshToken);
    if (!entry) {
      return null;
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (entry.expiresAt <= nowSeconds) {
      this._refreshTokens.delete(refreshToken);
      return null;
    }
    return { user: entry.user, clientId: entry.clientId };
  }

  /**
   * @param {string} refreshToken
   * @returns {Promise<boolean>}
   */
  async deleteRefreshToken(refreshToken) {
    if (typeof refreshToken !== 'string' || !refreshToken) {
      throw new Error('refreshToken is required');
    }
    return this._refreshTokens.delete(refreshToken);
  }

  /**
   * @param {string} sessionId
   * @returns {{ context: Record<string, string>, provider: string, expiresAt: number }|null}
   * @private
   */
  _getPendingEntry(sessionId) {
    const entry = this._pending.get(sessionId);
    if (!entry) {
      return null;
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (entry.expiresAt <= nowSeconds) {
      this._pending.delete(sessionId);
      return null;
    }
    return entry;
  }
}
