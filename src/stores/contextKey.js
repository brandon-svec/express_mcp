import { createHash } from 'crypto';

/**
 * @param {Record<string, unknown>} context
 * @returns {Record<string, string>}
 */
export function sortContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw new Error('context must be a non-null object');
  }
  const keys = Object.keys(context).sort();
  if (keys.length === 0) {
    throw new Error('context must not be empty');
  }
  /** @type {Record<string, string>} */
  const sorted = {};
  for (const key of keys) {
    const value = context[key];
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`context.${key} must be a non-empty string`);
    }
    sorted[key] = value.trim();
  }
  return sorted;
}

/**
 * @param {Record<string, unknown>} context
 * @returns {string}
 */
export function serializeContext(context) {
  return JSON.stringify(sortContext(context));
}

/**
 * @param {Record<string, unknown>} context
 * @returns {string}
 */
export function redisContextKey(context) {
  const serialized = serializeContext(context);
  const hash = createHash('sha256').update(serialized).digest('hex');
  return `mcp:ctx:${hash}`;
}
