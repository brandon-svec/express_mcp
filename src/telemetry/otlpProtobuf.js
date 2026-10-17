/**
 * Encode OTLP ExportTraceServiceRequest as protobuf binary.
 * Hex string IDs (JSON wire) become bytes (protobuf wire).
 */

import { createRequire } from 'module';
import protobuf from 'protobufjs/light.js';

const require = createRequire(import.meta.url);
const protoBundle = require('./protoBundle.json');

const root = protobuf.Root.fromJSON(protoBundle);
const ExportTraceServiceRequest = root.lookupType(
  'opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest'
);
const Long = protobuf.util.Long;

/**
 * @param {string|number|bigint|undefined|null} value
 * @returns {protobuf.Long|number}
 */
function toFixed64(value) {
  const asString = value == null ? '0' : String(value);
  if (Long) {
    return Long.fromString(asString, true);
  }
  const asNumber = Number(asString);
  if (!Number.isSafeInteger(asNumber)) {
    throw new Error(`Timestamp out of safe integer range without Long: ${asString}`);
  }
  return asNumber;
}

/**
 * @param {string|undefined|null} hex
 * @param {number} byteLength
 * @param {string} fieldName
 * @returns {Buffer|undefined}
 */
export function hexToBytes(hex, byteLength, fieldName) {
  if (hex === undefined || hex === null || hex === '') {
    return undefined;
  }
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`Invalid ${fieldName}: expected hex string, got ${hex}`);
  }
  if (hex.length !== byteLength * 2) {
    throw new Error(
      `Invalid ${fieldName}: expected ${byteLength * 2} hex chars (${byteLength} bytes), got length ${hex.length}`
    );
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Convert a JSON-shaped OTLP request (camelCase, hex IDs) into a protobufjs
 * message object with Buffer IDs.
 * @param {object} jsonRequest - { resourceSpans: [...] }
 * @returns {object}
 */
export function jsonRequestToProtobufMessage(jsonRequest) {
  if (!jsonRequest || !Array.isArray(jsonRequest.resourceSpans)) {
    throw new Error('ExportTraceServiceRequest requires resourceSpans array');
  }

  return {
    resourceSpans: jsonRequest.resourceSpans.map((rs) => ({
      resource: rs.resource
        ? {
          attributes: (rs.resource.attributes || []).map(attrToProto),
        }
        : undefined,
      scopeSpans: (rs.scopeSpans || []).map((ss) => ({
        scope: ss.scope
          ? {
            name: ss.scope.name || '',
            version: ss.scope.version || '',
          }
          : undefined,
        spans: (ss.spans || []).map(spanToProto),
      })),
    })),
  };
}

/**
 * @param {{ key: string, value: object }} attr
 */
function attrToProto(attr) {
  return {
    key: attr.key,
    value: anyValueToProto(attr.value),
  };
}

/**
 * @param {object|undefined} value - OTLP JSON AnyValue
 */
function anyValueToProto(value) {
  if (!value || typeof value !== 'object') {
    return { stringValue: '' };
  }
  if (Object.prototype.hasOwnProperty.call(value, 'stringValue')) {
    return { stringValue: value.stringValue == null ? '' : String(value.stringValue) };
  }
  if (Object.prototype.hasOwnProperty.call(value, 'boolValue')) {
    return { boolValue: Boolean(value.boolValue) };
  }
  if (Object.prototype.hasOwnProperty.call(value, 'intValue')) {
    // OTLP/JSON uses decimal strings for intValue; protobuf expects int64/Long.
    return { intValue: toFixed64(value.intValue) };
  }
  if (Object.prototype.hasOwnProperty.call(value, 'doubleValue')) {
    return { doubleValue: Number(value.doubleValue) };
  }
  if (Object.prototype.hasOwnProperty.call(value, 'bytesValue')) {
    const raw = value.bytesValue;
    if (Buffer.isBuffer(raw)) {
      return { bytesValue: raw };
    }
    if (typeof raw === 'string') {
      return { bytesValue: Buffer.from(raw, 'base64') };
    }
  }
  if (value.arrayValue && Array.isArray(value.arrayValue.values)) {
    return {
      arrayValue: {
        values: value.arrayValue.values.map(anyValueToProto),
      },
    };
  }
  if (value.kvlistValue && Array.isArray(value.kvlistValue.values)) {
    return {
      kvlistValue: {
        values: value.kvlistValue.values.map(attrToProto),
      },
    };
  }
  return { stringValue: '' };
}

/**
 * @param {object} span - camelCase OTLP JSON span with hex IDs
 */
function spanToProto(span) {
  const out = {
    traceId: hexToBytes(span.traceId, 16, 'traceId'),
    spanId: hexToBytes(span.spanId, 8, 'spanId'),
    name: span.name || '',
    kind: span.kind == null ? 0 : Number(span.kind),
    startTimeUnixNano: toFixed64(span.startTimeUnixNano),
    endTimeUnixNano: toFixed64(span.endTimeUnixNano),
    attributes: (span.attributes || []).map(attrToProto),
    status: span.status
      ? {
        code: span.status.code == null ? 0 : Number(span.status.code),
        message: span.status.message == null ? '' : String(span.status.message),
      }
      : undefined,
  };
  const parent = hexToBytes(span.parentSpanId, 8, 'parentSpanId');
  if (parent) {
    out.parentSpanId = parent;
  }
  return out;
}

/**
 * Encode a JSON-shaped ExportTraceServiceRequest to protobuf bytes.
 * @param {object} jsonRequest
 * @returns {Buffer}
 */
export function encodeExportTraceServiceRequest(jsonRequest) {
  const message = jsonRequestToProtobufMessage(jsonRequest);
  const err = ExportTraceServiceRequest.verify(message);
  if (err) {
    throw new Error(`Invalid ExportTraceServiceRequest: ${err}`);
  }
  const encoded = ExportTraceServiceRequest.encode(
    ExportTraceServiceRequest.create(message)
  ).finish();
  return Buffer.from(encoded);
}

/**
 * Decode protobuf bytes back to a plain object (IDs as Buffers).
 * @param {Buffer|Uint8Array} bytes
 * @returns {object}
 */
export function decodeExportTraceServiceRequest(bytes) {
  return ExportTraceServiceRequest.toObject(
    ExportTraceServiceRequest.decode(bytes),
    {
      longs: String,
      enums: Number,
      bytes: Buffer,
      defaults: false,
    }
  );
}

/**
 * @returns {protobuf.Type}
 */
export function getExportTraceServiceRequestType() {
  return ExportTraceServiceRequest;
}
