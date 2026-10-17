import { assert } from 'chai';
import {
  normalizeTelemetryConfig,
  normalizeEndpoint,
  normalizeGrpcEndpoint,
  grpcTargetFromEndpoint,
  DEFAULT_SANITIZE_KEYS,
} from '../../src/telemetry/normalizeTelemetryConfig.js';

describe('normalizeTelemetryConfig', () => {
  it('returns disabled when omitted or enabled is not true', () => {
    assert.deepStrictEqual(normalizeTelemetryConfig(undefined), { enabled: false });
    assert.deepStrictEqual(normalizeTelemetryConfig(null), { enabled: false });
    assert.deepStrictEqual(normalizeTelemetryConfig({}), { enabled: false });
    assert.deepStrictEqual(normalizeTelemetryConfig({ enabled: false }), { enabled: false });
  });

  it('requires protocol when enabled', () => {
    assert.throws(
      () => normalizeTelemetryConfig({
        enabled: true,
        endpoint: 'http://localhost/v1/traces',
      }),
      /telemetry\.protocol is required/
    );
    assert.throws(
      () => normalizeTelemetryConfig({
        enabled: true,
        protocol: 'http/json',
      }),
      /endpoint is required/
    );
  });

  it('rejects unknown protocol', () => {
    assert.throws(
      () => normalizeTelemetryConfig({
        enabled: true,
        protocol: 'udp',
        endpoint: 'http://localhost/v1/traces',
      }),
      /telemetry\.protocol is required/
    );
  });

  it('normalizes a full enabled config with defaults', () => {
    const cfg = normalizeTelemetryConfig(
      {
        enabled: true,
        protocol: 'http/json',
        endpoint: 'https://proudfield.example.com',
        headers: { Authorization: 'Bearer key' },
      },
      { name: 'my-service' }
    );
    assert.strictEqual(cfg.enabled, true);
    assert.strictEqual(cfg.protocol, 'http/json');
    assert.strictEqual(cfg.endpoint, 'https://proudfield.example.com/v1/traces');
    assert.strictEqual(cfg.serviceName, 'my-service');
    assert.strictEqual(cfg.batchMaxSpans, 50);
    assert.strictEqual(cfg.batchTimeoutMs, 1000);
    assert.strictEqual(cfg.maxQueueSize, 1000);
    assert.strictEqual(cfg.maxAttributeLength, 4096);
    assert.isTrue(cfg.captureParameters);
    assert.isTrue(cfg.captureResults);
    assert.deepStrictEqual(cfg.sanitizeKeys, [...DEFAULT_SANITIZE_KEYS]);
    assert.deepStrictEqual(cfg.headers, { Authorization: 'Bearer key' });
  });

  it('appends /v1/traces for http/protobuf', () => {
    const cfg = normalizeTelemetryConfig({
      enabled: true,
      protocol: 'http/protobuf',
      endpoint: 'https://app.phoenix.arize.com/s/space',
    });
    assert.strictEqual(cfg.protocol, 'http/protobuf');
    assert.strictEqual(
      cfg.endpoint,
      'https://app.phoenix.arize.com/s/space/v1/traces'
    );
  });

  it('does not append /v1/traces for grpc', () => {
    const cfg = normalizeTelemetryConfig({
      enabled: true,
      protocol: 'grpc',
      endpoint: 'https://otel.example.com:4317',
    });
    assert.strictEqual(cfg.protocol, 'grpc');
    assert.strictEqual(cfg.endpoint, 'https://otel.example.com:4317');
    assert.ok(!cfg.endpoint.includes('/v1/traces'));
  });

  it('normalizeGrpcEndpoint strips path', () => {
    assert.strictEqual(
      normalizeGrpcEndpoint('http://localhost:4317/v1/traces'),
      'http://localhost:4317'
    );
  });

  it('grpcTargetFromEndpoint maps scheme to port and ssl', () => {
    assert.deepStrictEqual(
      {
        target: grpcTargetFromEndpoint('https://otel.example.com').target,
        useSsl: grpcTargetFromEndpoint('https://otel.example.com').useSsl,
      },
      { target: 'otel.example.com:443', useSsl: true }
    );
    assert.deepStrictEqual(
      {
        target: grpcTargetFromEndpoint('http://localhost').target,
        useSsl: grpcTargetFromEndpoint('http://localhost').useSsl,
      },
      { target: 'localhost:80', useSsl: false }
    );
    assert.deepStrictEqual(
      {
        target: grpcTargetFromEndpoint('http://localhost:4317').target,
        useSsl: grpcTargetFromEndpoint('http://localhost:4317').useSsl,
      },
      { target: 'localhost:4317', useSsl: false }
    );
  });

  it('prefers telemetry.serviceName over options.name', () => {
    const cfg = normalizeTelemetryConfig(
      {
        enabled: true,
        protocol: 'http/json',
        endpoint: 'http://localhost:8080/v1/traces',
        serviceName: 'custom',
      },
      { name: 'ignored' }
    );
    assert.strictEqual(cfg.serviceName, 'custom');
  });

  it('defaults serviceName to express-mcp', () => {
    const cfg = normalizeTelemetryConfig({
      enabled: true,
      protocol: 'http/json',
      endpoint: 'http://localhost:8080/v1/traces',
    });
    assert.strictEqual(cfg.serviceName, 'express-mcp');
  });

  it('does not double-append /v1/traces', () => {
    assert.strictEqual(
      normalizeEndpoint('https://host.example/v1/traces'),
      'https://host.example/v1/traces'
    );
    assert.strictEqual(
      normalizeEndpoint('https://host.example/v1/traces/'),
      'https://host.example/v1/traces'
    );
  });

  it('rejects invalid tunables', () => {
    assert.throws(
      () => normalizeTelemetryConfig({
        enabled: true,
        protocol: 'http/json',
        endpoint: 'http://localhost/v1/traces',
        batchMaxSpans: 0,
      }),
      /batchMaxSpans/
    );
    assert.throws(
      () => normalizeTelemetryConfig({
        enabled: true,
        protocol: 'http/json',
        endpoint: 'http://localhost/v1/traces',
        captureParameters: 'yes',
      }),
      /captureParameters/
    );
  });

  it('allows maxRetries of 0', () => {
    const cfg = normalizeTelemetryConfig({
      enabled: true,
      protocol: 'http/json',
      endpoint: 'http://localhost/v1/traces',
      maxRetries: 0,
    });
    assert.strictEqual(cfg.maxRetries, 0);
  });
});
