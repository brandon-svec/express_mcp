import jwt from 'jsonwebtoken';
import { redisContextKey } from './contextKey.js';

/**
 * Redis-backed context-keyed JWT store for multi-worker deployments.
 *
 * @param {import('ioredis').Redis} redis - Connected ioredis client (peer dependency)
 */
export class RedisContextTokenStore {
  /**
   * @param {import('ioredis').Redis} redis
   */
  constructor(redis) {
    if (!redis) {
      throw new Error('redis client is required for RedisContextTokenStore');
    }
    this._redis = redis;
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
    const nowSeconds = Math.floor(Date.now() / 1000);
    const ttlSeconds = decoded.exp - nowSeconds;
    if (ttlSeconds <= 0) {
      throw new Error('jwt is already expired');
    }
    const key = redisContextKey(context);
    const value = JSON.stringify({ jwt: jwtToken });
    await this._redis.set(key, value, 'EX', ttlSeconds);
  }

  /**
   * @param {Record<string, unknown>} context
   * @returns {Promise<string|null>}
   */
  async find(context) {
    const key = redisContextKey(context);
    const raw = await this._redis.get(key);
    if (raw === null) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.jwt !== 'string' || !parsed.jwt) {
      throw new Error(`Invalid stored value for Redis key ${key}`);
    }
    return parsed.jwt;
  }
}
