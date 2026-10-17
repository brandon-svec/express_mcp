/**
 * Normalize and validate ExpressMcp options.telemetry (constructor only; no env).
 */

export const DEFAULT_SANITIZE_KEYS = Object.freeze([
  'password',
  'secret',
  'token',
  'authorization',
  'apiKey',
]);

/** @type {ReadonlySet<string>} */
export const TELEMETRY_PROTOCOLS = Object.freeze(new Set([
  'http/json',
  'http/protobuf',
  'grpc',
]));

const DEFAULTS = Object.freeze({
  captureParameters: true,
  captureResults: true,
  maxAttributeLength: 4096,
  batchMaxSpans: 50,
  batchTimeoutMs: 1000,
  maxQueueSize: 1000,
  maxSockets: 10,
  keepAliveTimeoutMs: 30000,
  maxRetries: 3,
  requestTimeoutMs: 5000,
});

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function requirePositiveInt(value, name) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid telemetry.${name}: ${value}. Must be a positive integer.`);
  }
  return value;
}

/**
 * Parse and validate an http(s) telemetry.endpoint URL.
 * @param {unknown} endpoint
 * @returns {URL}
 */
function parseHttpEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.trim().length === 0) {
    throw new Error('telemetry.endpoint is required when telemetry.enabled is true');
  }
  const trimmed = endpoint.trim().replace(/\/+$/, '');
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid telemetry.endpoint: ${endpoint}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Invalid telemetry.endpoint protocol: ${url.protocol}`);
  }
  return url;
}

/**
 * Append /v1/traces when the path does not already end with it (HTTP OTLP only).
 * @param {string} endpoint
 * @returns {string}
 */
export function normalizeEndpoint(endpoint) {
  const url = parseHttpEndpoint(endpoint);
  const path = url.pathname.replace(/\/+$/, '') || '';
  if (!path.toLowerCase().endsWith('/v1/traces')) {
    const next = path === '' || path === '/' ? '/v1/traces' : `${path}/v1/traces`;
    url.pathname = next.replace(/\/{2,}/g, '/');
  } else {
    url.pathname = path;
  }
  return url.href.replace(/\/+$/, '');
}

/**
 * Normalize a gRPC collector endpoint (no /v1/traces). Returns the URL string
 * used for credential/TLS decisions; use {@link grpcTargetFromEndpoint} for the
 * @grpc/grpc-js target string.
 * @param {string} endpoint
 * @returns {string}
 */
export function normalizeGrpcEndpoint(endpoint) {
  const url = parseHttpEndpoint(endpoint);
  // Drop path for gRPC (service path is not an HTTP pathname).
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.href.replace(/\/+$/, '');
}

/**
 * Map a normalized gRPC endpoint URL to a @grpc/grpc-js target and credentials kind.
 * No silent :4317. Port defaults: https → 443, http → 80 when omitted.
 * @param {string} endpoint - result of {@link normalizeGrpcEndpoint} or any http(s) URL
 * @returns {{ target: string, useSsl: boolean, url: URL }}
 */
export function grpcTargetFromEndpoint(endpoint) {
  const url = parseHttpEndpoint(endpoint);
  const useSsl = url.protocol === 'https:';
  let port = url.port;
  if (!port) {
    port = useSsl ? '443' : '80';
  }
  const target = `${url.hostname}:${port}`;
  return { target, useSsl, url };
}

/**
 * @param {Object|undefined|null} telemetryOptions
 * @param {{ name?: string }} [mcpOptions]
 * @returns {{
 *   enabled: false
 * } | {
 *   enabled: true,
 *   protocol: 'http/json'|'http/protobuf'|'grpc',
 *   endpoint: string,
 *   headers: Record<string, string>,
 *   serviceName: string,
 *   captureParameters: boolean,
 *   captureResults: boolean,
 *   maxAttributeLength: number,
 *   sanitizeKeys: string[],
 *   batchMaxSpans: number,
 *   batchTimeoutMs: number,
 *   maxQueueSize: number,
 *   maxSockets: number,
 *   keepAliveTimeoutMs: number,
 *   maxRetries: number,
 *   requestTimeoutMs: number,
 * }}
 */
export function normalizeTelemetryConfig(telemetryOptions, mcpOptions = {}) {
  if (telemetryOptions === undefined || telemetryOptions === null) {
    return { enabled: false };
  }
  if (typeof telemetryOptions !== 'object' || Array.isArray(telemetryOptions)) {
    throw new Error('telemetry must be a plain object when provided');
  }

  if (telemetryOptions.enabled !== true) {
    return { enabled: false };
  }

  const protocol = telemetryOptions.protocol;
  if (typeof protocol !== 'string' || !TELEMETRY_PROTOCOLS.has(protocol)) {
    throw new Error(
      `telemetry.protocol is required when telemetry.enabled is true. `
      + `Must be one of: http/json, http/protobuf, grpc. Got: ${protocol}`
    );
  }

  const endpoint = protocol === 'grpc'
    ? normalizeGrpcEndpoint(telemetryOptions.endpoint)
    : normalizeEndpoint(telemetryOptions.endpoint);

  /** @type {Record<string, string>} */
  let headers = {};
  if (telemetryOptions.headers !== undefined) {
    if (
      typeof telemetryOptions.headers !== 'object'
      || telemetryOptions.headers === null
      || Array.isArray(telemetryOptions.headers)
    ) {
      throw new Error('telemetry.headers must be a plain object when provided');
    }
    headers = {};
    for (const [key, value] of Object.entries(telemetryOptions.headers)) {
      if (typeof value !== 'string') {
        throw new Error(`telemetry.headers.${key} must be a string`);
      }
      headers[key] = value;
    }
  }

  let serviceName;
  if (telemetryOptions.serviceName !== undefined) {
    if (typeof telemetryOptions.serviceName !== 'string' || !telemetryOptions.serviceName.trim()) {
      throw new Error('telemetry.serviceName must be a non-empty string when provided');
    }
    serviceName = telemetryOptions.serviceName.trim();
  } else if (typeof mcpOptions.name === 'string' && mcpOptions.name.trim()) {
    serviceName = mcpOptions.name.trim();
  } else {
    serviceName = 'express-mcp';
  }

  const captureParameters = telemetryOptions.captureParameters === undefined
    ? DEFAULTS.captureParameters
    : telemetryOptions.captureParameters;
  if (typeof captureParameters !== 'boolean') {
    throw new Error('telemetry.captureParameters must be a boolean when provided');
  }

  const captureResults = telemetryOptions.captureResults === undefined
    ? DEFAULTS.captureResults
    : telemetryOptions.captureResults;
  if (typeof captureResults !== 'boolean') {
    throw new Error('telemetry.captureResults must be a boolean when provided');
  }

  const maxAttributeLength = telemetryOptions.maxAttributeLength === undefined
    ? DEFAULTS.maxAttributeLength
    : requirePositiveInt(telemetryOptions.maxAttributeLength, 'maxAttributeLength');

  let sanitizeKeys = [...DEFAULT_SANITIZE_KEYS];
  if (telemetryOptions.sanitizeKeys !== undefined) {
    if (!Array.isArray(telemetryOptions.sanitizeKeys)) {
      throw new Error('telemetry.sanitizeKeys must be an array of strings when provided');
    }
    for (const key of telemetryOptions.sanitizeKeys) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new Error('telemetry.sanitizeKeys entries must be non-empty strings');
      }
    }
    sanitizeKeys = [...telemetryOptions.sanitizeKeys];
  }

  const batchMaxSpans = telemetryOptions.batchMaxSpans === undefined
    ? DEFAULTS.batchMaxSpans
    : requirePositiveInt(telemetryOptions.batchMaxSpans, 'batchMaxSpans');
  const batchTimeoutMs = telemetryOptions.batchTimeoutMs === undefined
    ? DEFAULTS.batchTimeoutMs
    : requirePositiveInt(telemetryOptions.batchTimeoutMs, 'batchTimeoutMs');
  const maxQueueSize = telemetryOptions.maxQueueSize === undefined
    ? DEFAULTS.maxQueueSize
    : requirePositiveInt(telemetryOptions.maxQueueSize, 'maxQueueSize');
  const maxSockets = telemetryOptions.maxSockets === undefined
    ? DEFAULTS.maxSockets
    : requirePositiveInt(telemetryOptions.maxSockets, 'maxSockets');
  const keepAliveTimeoutMs = telemetryOptions.keepAliveTimeoutMs === undefined
    ? DEFAULTS.keepAliveTimeoutMs
    : requirePositiveInt(telemetryOptions.keepAliveTimeoutMs, 'keepAliveTimeoutMs');

  let maxRetries = DEFAULTS.maxRetries;
  if (telemetryOptions.maxRetries !== undefined) {
    if (
      typeof telemetryOptions.maxRetries !== 'number'
      || !Number.isInteger(telemetryOptions.maxRetries)
      || telemetryOptions.maxRetries < 0
    ) {
      throw new Error(
        `Invalid telemetry.maxRetries: ${telemetryOptions.maxRetries}. Must be a non-negative integer.`
      );
    }
    maxRetries = telemetryOptions.maxRetries;
  }

  const requestTimeoutMs = telemetryOptions.requestTimeoutMs === undefined
    ? DEFAULTS.requestTimeoutMs
    : requirePositiveInt(telemetryOptions.requestTimeoutMs, 'requestTimeoutMs');

  return {
    enabled: true,
    protocol,
    endpoint,
    headers,
    serviceName,
    captureParameters,
    captureResults,
    maxAttributeLength,
    sanitizeKeys,
    batchMaxSpans,
    batchTimeoutMs,
    maxQueueSize,
    maxSockets,
    keepAliveTimeoutMs,
    maxRetries,
    requestTimeoutMs,
  };
}
