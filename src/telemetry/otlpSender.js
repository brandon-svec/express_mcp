import http from 'http';
import https from 'https';
import got from 'got';
import { encodeExportTraceServiceRequest } from './otlpProtobuf.js';
import { createGrpcTraceExporter, loadGrpc } from './otlpGrpc.js';

/**
 * OTLP sender with keep-alive pooling and retries.
 * Supports protocols: http/json, http/protobuf, grpc.
 */

/**
 * @param {string|number|boolean|null|undefined} value
 * @returns {{ stringValue: string }|{ intValue: string }|{ boolValue: boolean }|{ doubleValue: number }}
 */
export function toAnyValue(value) {
  if (typeof value === 'boolean') {
    return { boolValue: value };
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      return { intValue: String(value) };
    }
    return { doubleValue: value };
  }
  if (value === null || value === undefined) {
    return { stringValue: '' };
  }
  return { stringValue: String(value) };
}

/**
 * @param {Record<string, string|number|boolean>} attrs
 * @returns {Array<{ key: string, value: object }>}
 */
export function attributesToOtlp(attrs) {
  return Object.entries(attrs).map(([key, value]) => ({
    key,
    value: toAnyValue(value),
  }));
}

/**
 * @param {object} options
 * @param {string} options.endpoint
 * @param {'http/json'|'http/protobuf'|'grpc'} options.protocol
 * @param {Record<string, string>} options.headers
 * @param {string} options.serviceName
 * @param {string} options.scopeName
 * @param {string} options.scopeVersion
 * @param {number} options.maxSockets
 * @param {number} options.keepAliveTimeoutMs
 * @param {number} options.maxRetries
 * @param {number} options.requestTimeoutMs
 * @param {{ debug?: Function }|null} [options.logger]
 * @param {Function} [options.request] - injectable got-like POST for HTTP tests
 * @param {Function} [options.grpcExport] - injectable (bytes, headers) => Promise for gRPC tests
 * @param {typeof import('@grpc/grpc-js')|null} [options.grpcLib] - injectable grpc module
 */
export class OtlpSender {
  constructor(options) {
    if (!options || typeof options.endpoint !== 'string') {
      throw new Error('endpoint is required');
    }
    if (
      options.protocol !== 'http/json'
      && options.protocol !== 'http/protobuf'
      && options.protocol !== 'grpc'
    ) {
      throw new Error(
        `OtlpSender protocol must be http/json, http/protobuf, or grpc. Got: ${options.protocol}`
      );
    }

    this.endpoint = options.endpoint;
    this.protocol = options.protocol;
    this.headers = options.headers || {};
    this.serviceName = options.serviceName;
    this.scopeName = options.scopeName;
    this.scopeVersion = options.scopeVersion;
    this.logger = options.logger ?? null;
    this.maxRetries = options.maxRetries ?? 3;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5000;
    this._grpcExportOpt = options.grpcExport;
    this._grpcLib = options.grpcLib ?? null;
    /** @type {{ exportRequest: Function, destroy: Function }|null} */
    this._grpcExporter = null;

    const maxSockets = options.maxSockets ?? 10;
    const keepAliveTimeoutMs = options.keepAliveTimeoutMs ?? 30000;

    this.httpAgent = new http.Agent({
      keepAlive: true,
      maxSockets,
      keepAliveMsecs: keepAliveTimeoutMs,
    });
    this.httpsAgent = new https.Agent({
      keepAlive: true,
      maxSockets,
      keepAliveMsecs: keepAliveTimeoutMs,
    });

    if (typeof options.request === 'function') {
      this._request = options.request;
    } else if (this.protocol === 'http/json' || this.protocol === 'http/protobuf') {
      this._client = got.extend({
        agent: {
          http: this.httpAgent,
          https: this.httpsAgent,
        },
        timeout: { request: this.requestTimeoutMs },
        retry: {
          limit: this.maxRetries,
          methods: ['POST'],
          statusCodes: [429, 502, 503, 504],
          errorCodes: [
            'ETIMEDOUT',
            'ECONNRESET',
            'EADDRINUSE',
            'ECONNREFUSED',
            'EPIPE',
            'ENOTFOUND',
            'ENETUNREACH',
            'EAI_AGAIN',
          ],
          backoffLimit: 2000,
        },
        // text: Phoenix and some collectors return empty 200 bodies
        responseType: 'text',
        throwHttpErrors: true,
      });
      this._request = (url, opts) => this._client.post(url, opts);
    } else {
      this._request = null;
    }

    // Fail-fast if grpc is selected and the peer is missing (unless injectable).
    if (this.protocol === 'grpc') {
      if (typeof this._grpcExportOpt === 'function') {
        this._grpcExporter = createGrpcTraceExporter({
          endpoint: this.endpoint,
          headers: this.headers,
          requestTimeoutMs: this.requestTimeoutMs,
          grpcExport: this._grpcExportOpt,
        });
      } else {
        loadGrpc(this._grpcLib);
        this._grpcExporter = createGrpcTraceExporter({
          endpoint: this.endpoint,
          headers: this.headers,
          requestTimeoutMs: this.requestTimeoutMs,
          grpcLib: this._grpcLib,
        });
      }
    }
  }

  /**
   * @param {object[]} spans - completed OTLP span objects (camelCase)
   * @returns {object}
   */
  buildExportRequest(spans) {
    return {
      resourceSpans: [
        {
          resource: {
            attributes: attributesToOtlp({
              'service.name': this.serviceName,
              'telemetry.sdk.language': 'nodejs',
            }),
          },
          scopeSpans: [
            {
              scope: {
                name: this.scopeName,
                version: this.scopeVersion,
              },
              spans,
            },
          ],
        },
      ],
    };
  }

  /**
   * @param {object[]} spans - completed OTLP span objects (camelCase)
   * @returns {Promise<void>}
   */
  async send(spans) {
    if (!Array.isArray(spans) || spans.length === 0) {
      return;
    }
    const body = this.buildExportRequest(spans);

    try {
      if (this.protocol === 'http/json') {
        return await this._request(this.endpoint, {
          json: body,
          headers: {
            'Content-Type': 'application/json',
            ...this.headers,
          },
        });
      }
      if (this.protocol === 'http/protobuf') {
        const encoded = encodeExportTraceServiceRequest(body);
        return await this._request(this.endpoint, {
          body: encoded,
          headers: {
            ...this.headers,
            'content-type': 'application/x-protobuf',
          },
        });
      }
      // grpc
      return await this._grpcExporter.exportRequest(body);
    } catch (err) {
      this.logger?.debug?.(
        {
          error: err?.message,
          endpoint: this.endpoint,
          protocol: this.protocol,
          spanCount: spans.length,
        },
        'OTLP export failed'
      );
      throw err;
    }
  }

  /**
   * Destroy keep-alive agents and gRPC client.
   */
  destroy() {
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
    try {
      this._grpcExporter?.destroy?.();
    } catch {
      // ignore
    }
    this._grpcExporter = null;
  }
}
