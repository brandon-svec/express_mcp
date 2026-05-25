import jwt from 'jsonwebtoken';
import { serializeContext } from './contextKey.js';

/**
 * In-process context-keyed JWT store for dev and single-worker deployments.
 */
export class InMemoryContextTokenStore {
  constructor() {
    /** @type {Map<string, { jwt: string, expiresAt: number }>} */
    this._entries = new Map();
  }

  /**
   * @param {Record<string, unknown>} context
   * @param {Object} _user
   * @param {string} jwtToken
   * @returns {Promise<void>}
   */
  async upsert(context, _user, jwtToken) {
    if (typeof jwtToken !== 'string' || !jwtToken) {
      throw new Error('jwt is required');
    }
    const decoded = jwt.decode(jwtToken);
    if (!decoded || typeof decoded.exp !== 'number') {
      throw new Error('jwt must contain exp claim');
    }
    const key = serializeContext(context);
    this._entries.set(key, {
      jwt: jwtToken,
      expiresAt: decoded.exp
    });
  }

  /**
   * @param {Record<string, unknown>} context
   * @returns {Promise<string|null>}
   */
  async find(context) {
    const key = serializeContext(context);
    const entry = this._entries.get(key);
    if (!entry) {
      return null;
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (entry.expiresAt <= nowSeconds) {
      this._entries.delete(key);
      return null;
    }
    return entry.jwt;
  }
}
