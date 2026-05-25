import { createHash } from 'crypto';

/**
 * Sanitize optional host context for standalone session storage.
 * @param {unknown} context
 * @returns {Record<string, string>}
 */
export function sanitizeHostContext(context) {
  if (context === undefined || context === null) {
    return {};
  }
  if (typeof context !== 'object' || Array.isArray(context)) {
    throw new Error('context must be an object when provided');
  }
  /** @type {Record<string, string>} */
  const sanitized = {};
  for (const key of Object.keys(context)) {
    const value = context[key];
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`context.${key} must be a non-empty string`);
    }
    sanitized[key] = value.trim();
  }
  return sanitized;
}

/**
 * @param {string} sessionId
 */
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * @param {string} sessionId
 */
export function assertValidSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('session_id is required');
  }
  if (!UUID_V4_PATTERN.test(sessionId)) {
    throw new Error(`Invalid session_id: ${sessionId}`);
  }
}

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isUuidV4SessionId(value) {
  return typeof value === 'string' && UUID_V4_PATTERN.test(value);
}

/**
 * Redis key for context → session_id alias lookup.
 * @param {Record<string, string>} context
 * @returns {string}
 */
export function contextAliasKey(context) {
  const sorted = Object.keys(context).sort().reduce((acc, key) => {
    acc[key] = context[key];
    return acc;
  }, {});
  const hash = createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
  return `mcp:ctxalias:${hash}`;
}
