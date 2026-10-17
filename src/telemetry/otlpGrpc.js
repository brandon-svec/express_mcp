/**
 * OTLP/gRPC TraceService Export helper (optional peer @grpc/grpc-js).
 */

import { createRequire } from 'module';
import { grpcTargetFromEndpoint } from './normalizeTelemetryConfig.js';
import {
  encodeExportTraceServiceRequest,
  getExportTraceServiceRequestType,
  jsonRequestToProtobufMessage,
} from './otlpProtobuf.js';

const require = createRequire(import.meta.url);
const SERVICE_PATH = '/opentelemetry.proto.collector.trace.v1.TraceService/Export';

const GRPC_MISSING_MESSAGE = (
  "telemetry.protocol 'grpc' requires optional peer dependency '@grpc/grpc-js'. "
  + 'Run `npm install @grpc/grpc-js`.'
);

/**
 * Resolve @grpc/grpc-js synchronously (fail-fast at construct).
 * @param {typeof import('@grpc/grpc-js')|null} [grpcLib] - injectable for tests
 * @returns {typeof import('@grpc/grpc-js')}
 */
export function loadGrpc(grpcLib) {
  if (grpcLib) {
    return grpcLib;
  }
  try {
    require.resolve('@grpc/grpc-js');
  } catch {
    throw new Error(GRPC_MISSING_MESSAGE);
  }
  try {
    return require('@grpc/grpc-js');
  } catch {
    throw new Error(GRPC_MISSING_MESSAGE);
  }
}

/**
 * Build gRPC Metadata from plain header map.
 * @param {typeof import('@grpc/grpc-js')} grpc
 * @param {Record<string, string>} headers
 * @returns {import('@grpc/grpc-js').Metadata}
 */
export function headersToMetadata(grpc, headers) {
  const metadata = new grpc.Metadata();
  for (const [key, value] of Object.entries(headers || {})) {
    metadata.add(key, String(value));
  }
  return metadata;
}

/**
 * Create a unary Export callable for TraceService.
 * @param {object} options
 * @param {string} options.endpoint - http(s) URL (no /v1/traces)
 * @param {Record<string, string>} [options.headers]
 * @param {number} [options.requestTimeoutMs]
 * @param {typeof import('@grpc/grpc-js')|null} [options.grpcLib]
 * @param {Function} [options.grpcExport] - injectable (bytes, headers) => Promise
 * @returns {{
 *   exportRequest: (jsonRequest: object) => Promise<unknown>,
 *   destroy: () => void,
 * }}
 */
export function createGrpcTraceExporter(options) {
  if (!options || typeof options.endpoint !== 'string') {
    throw new Error('endpoint is required for grpc exporter');
  }

  if (typeof options.grpcExport === 'function') {
    const grpcExport = options.grpcExport;
    return {
      exportRequest: async (jsonRequest) => {
        const bytes = encodeExportTraceServiceRequest(jsonRequest);
        return grpcExport(bytes, options.headers || {});
      },
      destroy() {},
    };
  }

  const grpc = loadGrpc(options.grpcLib);
  const { target, useSsl } = grpcTargetFromEndpoint(options.endpoint);
  const credentials = useSsl
    ? grpc.credentials.createSsl()
    : grpc.credentials.createInsecure();

  const ExportTraceServiceRequest = getExportTraceServiceRequestType();

  const serviceDefinition = {
    Export: {
      path: SERVICE_PATH,
      requestStream: false,
      responseStream: false,
      requestSerialize: (msg) => Buffer.from(ExportTraceServiceRequest.encode(msg).finish()),
      requestDeserialize: (buf) => ExportTraceServiceRequest.decode(buf),
      responseSerialize: (msg) => (Buffer.isBuffer(msg) ? msg : Buffer.alloc(0)),
      responseDeserialize: (buf) => buf,
    },
  };

  const Client = grpc.makeGenericClientConstructor(serviceDefinition, 'TraceService');
  const client = new Client(target, credentials);
  const deadlineMs = options.requestTimeoutMs ?? 5000;

  return {
    exportRequest: async (jsonRequest) => {
      const message = ExportTraceServiceRequest.create(
        jsonRequestToProtobufMessage(jsonRequest)
      );
      const metadata = headersToMetadata(grpc, options.headers || {});
      const deadline = new Date(Date.now() + deadlineMs);
      return new Promise((resolve, reject) => {
        client.Export(message, metadata, { deadline }, (err, response) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(response);
        });
      });
    },
    destroy() {
      client.close();
    },
  };
}
