import { assertValidSessionId, contextAliasKey } from './sessionContext.js';

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
 * @param {{ context: Record<string, string>, provider: string, purpose?: string, scopes?: string[], sub?: string|null }} entry
 * @returns {{ context: Record<string, string>, provider: string, purpose: string, scopes: string[], sub: string|null }}
 */
function pendingPublicView(entry) {
  return {
    context: entry.context,
    provider: entry.provider,
    purpose: entry.purpose || 'login',
    scopes: Array.isArray(entry.scopes) ? entry.scopes : [],
    sub: entry.sub || null
  };
}

export class InMemoryStandaloneSessionStore {
  constructor() {
    /** @type {Map<string, { context: Record<string, string>, provider: string, purpose: string, scopes: string[], sub: string|null, expiresAt: number }>} */
    this._pending = new Map();
    /** @type {Map<string, { user: Object, context: Record<string, string>, expiresAt: number }>} */
    this._active = new Map();
    /** @type {Map<string, string>} */
    this._contextAlias = new Map();
    /** @type {Map<string, { user: Object, clientId: string, expiresAt: number }>} */
    this._refreshTokens = new Map();
    /** @type {Map<string, { sealedRefreshToken: string, scopes: string[], updatedAt: string }>} */
    this._idpGrants = new Map();
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
    const expiresAt = Math.floor(Date.now() / 1000) + pendingTtlSeconds;
    this._pending.set(sessionId, {
      context,
      provider,
      purpose: normalized.purpose,
      scopes: normalized.scopes,
      sub: normalized.sub,
      expiresAt
    });
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
   * @returns {Promise<{ context: Record<string, string>, provider: string, purpose: string, scopes: string[], sub: string|null }|null>}
   */
  async peekPending(sessionId) {
    assertValidSessionId(sessionId);
    const entry = this._getPendingEntry(sessionId);
    if (!entry) {
      return null;
    }
    return pendingPublicView(entry);
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<{ context: Record<string, string>, provider: string, purpose: string, scopes: string[], sub: string|null }|null>}
   */
  async consumePending(sessionId) {
    assertValidSessionId(sessionId);
    const entry = this._getPendingEntry(sessionId);
    if (!entry) {
      return null;
    }
    this._pending.delete(sessionId);
    return pendingPublicView(entry);
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
    this._idpGrants.set(sub, {
      sealedRefreshToken: grant.sealedRefreshToken,
      scopes: [...grant.scopes],
      updatedAt: grant.updatedAt
    });
  }

  /**
   * @param {string} sub
   * @returns {Promise<{ sealedRefreshToken: string, scopes: string[], updatedAt: string }|null>}
   */
  async findIdpGrant(sub) {
    if (typeof sub !== 'string' || !sub) {
      throw new Error('sub is required');
    }
    const entry = this._idpGrants.get(sub);
    if (!entry) {
      return null;
    }
    return {
      sealedRefreshToken: entry.sealedRefreshToken,
      scopes: [...entry.scopes],
      updatedAt: entry.updatedAt
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
    return this._idpGrants.delete(sub);
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
