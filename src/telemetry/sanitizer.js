/**
 * Recursively redact sensitive keys and truncate strings for OTLP attributes.
 */

/**
 * @param {unknown} value
 * @param {string[]} sanitizeKeys
 * @param {number} maxAttributeLength
 * @returns {unknown}
 */
export function sanitizeValue(value, sanitizeKeys, maxAttributeLength) {
  if (typeof maxAttributeLength !== 'number' || !Number.isInteger(maxAttributeLength) || maxAttributeLength < 1) {
    throw new Error(`Invalid maxAttributeLength: ${maxAttributeLength}`);
  }
  if (!Array.isArray(sanitizeKeys)) {
    throw new Error('sanitizeKeys must be an array of strings');
  }
  const keySet = new Set(sanitizeKeys.map((k) => String(k).toLowerCase()));
  return walk(value, keySet, maxAttributeLength);
}

/**
 * @param {unknown} value
 * @param {Set<string>} keySet
 * @param {number} maxLen
 * @returns {unknown}
 */
function walk(value, keySet, maxLen) {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    return truncateString(value, maxLen);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, keySet, maxLen));
  }
  if (typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (keySet.has(key.toLowerCase())) {
        out[key] = '[REDACTED]';
      } else {
        out[key] = walk(child, keySet, maxLen);
      }
    }
    return out;
  }
  return truncateString(String(value), maxLen);
}

/**
 * @param {string} str
 * @param {number} maxLen
 * @returns {string}
 */
export function truncateString(str, maxLen) {
  if (typeof str !== 'string') {
    throw new Error('truncateString requires a string');
  }
  if (str.length <= maxLen) {
    return str;
  }
  return str.slice(0, maxLen);
}

/**
 * Sanitize then JSON-stringify for an OTLP attribute.
 * @param {unknown} value
 * @param {string[]} sanitizeKeys
 * @param {number} maxAttributeLength
 * @returns {string}
 */
export function sanitizeToAttributeString(value, sanitizeKeys, maxAttributeLength) {
  if (typeof value === 'string') {
    return truncateString(value, maxAttributeLength);
  }
  const sanitized = sanitizeValue(value, sanitizeKeys, maxAttributeLength);
  let json;
  try {
    json = JSON.stringify(sanitized);
  } catch {
    json = String(sanitized);
  }
  return truncateString(json, maxAttributeLength);
}
