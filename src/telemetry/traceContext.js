import { randomBytes } from 'crypto';

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

/**
 * @returns {string} 32-char lowercase hex trace ID
 */
export function generateTraceId() {
  return randomBytes(16).toString('hex');
}

/**
 * @returns {string} 16-char lowercase hex span ID
 */
export function generateSpanId() {
  return randomBytes(8).toString('hex');
}

/**
 * Parse a W3C traceparent header.
 * @param {string|null|undefined} header
 * @returns {{ traceId: string, spanId: string, flags: string }|null}
 */
export function parseTraceparent(header) {
  if (typeof header !== 'string' || header.length === 0) {
    return null;
  }
  const match = TRACEPARENT_RE.exec(header.trim());
  if (!match) {
    return null;
  }
  return {
    traceId: match[1].toLowerCase(),
    spanId: match[2].toLowerCase(),
    flags: match[3].toLowerCase(),
  };
}

/**
 * Serialize a W3C traceparent header.
 * @param {string} traceId
 * @param {string} spanId
 * @param {string} [flags='01']
 * @returns {string}
 */
export function serializeTraceparent(traceId, spanId, flags = '01') {
  if (typeof traceId !== 'string' || !/^[0-9a-f]{32}$/i.test(traceId)) {
    throw new Error(`Invalid traceId: ${traceId}`);
  }
  if (typeof spanId !== 'string' || !/^[0-9a-f]{16}$/i.test(spanId)) {
    throw new Error(`Invalid spanId: ${spanId}`);
  }
  const flagStr = typeof flags === 'string' && /^[0-9a-f]{2}$/i.test(flags)
    ? flags.toLowerCase()
    : '01';
  return `00-${traceId.toLowerCase()}-${spanId.toLowerCase()}-${flagStr}`;
}
