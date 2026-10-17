import { assert } from 'chai';
import nock from 'nock';
import {
  OtlpSender,
  toAnyValue,
  attributesToOtlp,
} from '../../src/telemetry/otlpSender.js';
import {
  decodeExportTraceServiceRequest,
} from '../../src/telemetry/otlpProtobuf.js';

const COLLECTOR = 'http://collector.test';
const TRACES_PATH = '/v1/traces';

const sampleSpan = {
  traceId: 'a'.repeat(32),
  spanId: 'b'.repeat(16),
  name: 'mcp.tool.hello',
  kind: 1,
  startTimeUnixNano: '1',
  endTimeUnixNano: '2',
  status: { code: 1 },
  attributes: [
    { key: 'openinference.span.kind', value: { stringValue: 'TOOL' } },
  ],
};

describe('OtlpSender', () => {
  describe('toAnyValue / attributesToOtlp', () => {
    it('encodes string, int, bool, double', () => {
      assert.deepStrictEqual(toAnyValue('hi'), { stringValue: 'hi' });
      assert.deepStrictEqual(toAnyValue(42), { intValue: '42' });
      assert.deepStrictEqual(toAnyValue(true), { boolValue: true });
      assert.deepStrictEqual(toAnyValue(1.5), { doubleValue: 1.5 });
    });

    it('builds attribute arrays', () => {
      const attrs = attributesToOtlp({
        'openinference.span.kind': 'TOOL',
        'mcp.tool.duration_ms': 12,
      });
      assert.deepStrictEqual(attrs, [
        { key: 'openinference.span.kind', value: { stringValue: 'TOOL' } },
        { key: 'mcp.tool.duration_ms', value: { intValue: '12' } },
      ]);
    });
  });

  describe('send', () => {
    it('builds OTLP JSON body with Content-Type and custom headers', async () => {
      /** @type {object|null} */
      let body = null;
      /** @type {Record<string, string>|null} */
      let headers = null;

      const sender = new OtlpSender({
        endpoint: `${COLLECTOR}${TRACES_PATH}`,
        protocol: 'http/json',
        headers: { Authorization: 'Bearer test-key' },
        serviceName: 'svc',
        scopeName: 'express_mcp',
        scopeVersion: '0.0.0-test',
        maxSockets: 2,
        keepAliveTimeoutMs: 1000,
        maxRetries: 0,
        requestTimeoutMs: 2000,
        request: async (_url, opts) => {
          body = opts.json;
          headers = opts.headers;
        },
      });

      await sender.send([sampleSpan]);

      assert.ok(body);
      assert.strictEqual(
        body.resourceSpans[0].resource.attributes.find((a) => a.key === 'service.name')
          .value.stringValue,
        'svc'
      );
      assert.strictEqual(
        body.resourceSpans[0].scopeSpans[0].spans[0].name,
        'mcp.tool.hello'
      );
      assert.include(String(headers['Content-Type']), 'application/json');
      assert.strictEqual(headers.Authorization, 'Bearer test-key');

      sender.destroy();
    });

    it('builds application/x-protobuf body for http/protobuf', async () => {
      /** @type {Buffer|null} */
      let receivedBody = null;
      /** @type {Record<string, string>|null} */
      let headers = null;

      const sender = new OtlpSender({
        endpoint: `${COLLECTOR}${TRACES_PATH}`,
        protocol: 'http/protobuf',
        headers: { Authorization: 'Bearer proto-key' },
        serviceName: 'svc',
        scopeName: 'express_mcp',
        scopeVersion: '0.0.0-test',
        maxRetries: 0,
        requestTimeoutMs: 2000,
        request: async (_url, opts) => {
          receivedBody = opts.body;
          headers = opts.headers;
        },
      });

      await sender.send([sampleSpan]);

      assert.strictEqual(headers['content-type'], 'application/x-protobuf');
      assert.strictEqual(headers.Authorization, 'Bearer proto-key');
      assert.ok(Buffer.isBuffer(receivedBody));
      assert.ok(receivedBody.length > 0);
      assert.throws(() => JSON.parse(receivedBody.toString('utf8')));

      const decoded = decodeExportTraceServiceRequest(receivedBody);
      const span = decoded.resourceSpans[0].scopeSpans[0].spans[0];
      assert.strictEqual(span.name, 'mcp.tool.hello');
      assert.strictEqual(
        Buffer.from(span.traceId).toString('hex'),
        'a'.repeat(32)
      );

      sender.destroy();
    });

    it('retries on 503 with Retry-After', async () => {
      nock.disableNetConnect();
      let hits = 0;
      try {
        const scope = nock(COLLECTOR)
          .post(TRACES_PATH)
          .times(1)
          .reply(() => {
            hits += 1;
            return [503, 'unavailable', { 'Retry-After': '0' }];
          })
          .post(TRACES_PATH)
          .times(1)
          .reply(() => {
            hits += 1;
            return [200, '{}', { 'Content-Type': 'application/json' }];
          });

        const sender = new OtlpSender({
          endpoint: `${COLLECTOR}${TRACES_PATH}`,
          protocol: 'http/json',
          headers: {},
          serviceName: 'svc',
          scopeName: 'express_mcp',
          scopeVersion: '0.0.0-test',
          maxRetries: 2,
          requestTimeoutMs: 2000,
        });

        await sender.send([{
          ...sampleSpan,
          traceId: 'c'.repeat(32),
          spanId: 'd'.repeat(16),
          name: 'test',
          attributes: [],
        }]);

        assert.ok(scope.isDone());
        assert.strictEqual(hits, 2);
        sender.destroy();
      } finally {
        nock.cleanAll();
        nock.enableNetConnect();
      }
    });

    it('uses injectable grpcExport for grpc protocol', async () => {
      /** @type {Buffer|null} */
      let received = null;
      /** @type {Record<string, string>|null} */
      let receivedHeaders = null;
      const sender = new OtlpSender({
        endpoint: 'http://localhost:4317',
        protocol: 'grpc',
        headers: { authorization: 'Bearer grpc-key' },
        serviceName: 'svc',
        scopeName: 'express_mcp',
        scopeVersion: '1',
        grpcExport: async (bytes, headers) => {
          received = bytes;
          receivedHeaders = headers;
        },
      });

      await sender.send([sampleSpan]);
      assert.ok(Buffer.isBuffer(received));
      assert.strictEqual(receivedHeaders.authorization, 'Bearer grpc-key');
      const decoded = decodeExportTraceServiceRequest(received);
      assert.strictEqual(
        decoded.resourceSpans[0].scopeSpans[0].spans[0].name,
        'mcp.tool.hello'
      );
      sender.destroy();
    });

    it('throws when grpc protocol is selected without peer or injectable', () => {
      assert.throws(
        () => new OtlpSender({
          endpoint: 'http://localhost:4317',
          protocol: 'grpc',
          headers: {},
          serviceName: 'svc',
          scopeName: 'express_mcp',
          scopeVersion: '1',
        }),
        /@grpc\/grpc-js/
      );
    });
  });
});
