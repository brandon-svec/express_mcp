import { assert } from 'chai';
import http from 'http';
import {
  OtlpSender,
  toAnyValue,
  attributesToOtlp,
} from '../../src/telemetry/otlpSender.js';
import {
  decodeExportTraceServiceRequest,
} from '../../src/telemetry/otlpProtobuf.js';

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
    it('POSTs OTLP JSON with Content-Type and custom headers', async () => {
      /** @type {object|null} */
      let received = null;
      /** @type {http.IncomingHttpHeaders|null} */
      let receivedHeaders = null;

      const server = http.createServer((req, res) => {
        receivedHeaders = req.headers;
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{}');
        });
      });

      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();

      const sender = new OtlpSender({
        endpoint: `http://127.0.0.1:${port}/v1/traces`,
        protocol: 'http/json',
        headers: { Authorization: 'Bearer test-key' },
        serviceName: 'svc',
        scopeName: 'express_mcp',
        scopeVersion: '0.0.0-test',
        maxSockets: 2,
        keepAliveTimeoutMs: 1000,
        maxRetries: 0,
        requestTimeoutMs: 2000,
      });

      await sender.send([sampleSpan]);

      assert.ok(received);
      assert.strictEqual(
        received.resourceSpans[0].resource.attributes.find((a) => a.key === 'service.name')
          .value.stringValue,
        'svc'
      );
      assert.strictEqual(
        received.resourceSpans[0].scopeSpans[0].spans[0].name,
        'mcp.tool.hello'
      );
      assert.include(receivedHeaders['content-type'], 'application/json');
      assert.strictEqual(receivedHeaders.authorization, 'Bearer test-key');

      sender.destroy();
      await new Promise((resolve) => server.close(resolve));
    });

    it('POSTs application/x-protobuf for http/protobuf', async () => {
      /** @type {Buffer|null} */
      let receivedBody = null;
      /** @type {string|null} */
      let contentType = null;

      const server = http.createServer((req, res) => {
        contentType = req.headers['content-type'] || null;
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          receivedBody = Buffer.concat(chunks);
          res.writeHead(200);
          res.end();
        });
      });

      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();

      const sender = new OtlpSender({
        endpoint: `http://127.0.0.1:${port}/v1/traces`,
        protocol: 'http/protobuf',
        headers: { Authorization: 'Bearer proto-key' },
        serviceName: 'svc',
        scopeName: 'express_mcp',
        scopeVersion: '0.0.0-test',
        maxRetries: 0,
        requestTimeoutMs: 2000,
      });

      await sender.send([sampleSpan]);

      assert.strictEqual(contentType, 'application/x-protobuf');
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
      await new Promise((resolve) => server.close(resolve));
    });

    it('retries on 503 with Retry-After', async () => {
      let hits = 0;
      const server = http.createServer((req, res) => {
        hits += 1;
        if (hits === 1) {
          res.writeHead(503, { 'Retry-After': '0' });
          res.end('unavailable');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });

      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();

      const sender = new OtlpSender({
        endpoint: `http://127.0.0.1:${port}/v1/traces`,
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

      assert.isAtLeast(hits, 2);
      sender.destroy();
      await new Promise((resolve) => server.close(resolve));
    });

    it('uses injectable request for tests', async () => {
      /** @type {object|null} */
      let body = null;
      const sender = new OtlpSender({
        endpoint: 'http://example.test/v1/traces',
        protocol: 'http/json',
        headers: { 'X-API-Key': 'k' },
        serviceName: 'svc',
        scopeName: 'express_mcp',
        scopeVersion: '1',
        request: async (_url, opts) => {
          body = opts.json;
          assert.strictEqual(opts.headers['X-API-Key'], 'k');
          assert.include(opts.headers['Content-Type'], 'application/json');
        },
      });

      await sender.send([{
        ...sampleSpan,
        traceId: 'e'.repeat(32),
        spanId: 'f'.repeat(16),
        name: 'n',
        attributes: [],
      }]);
      assert.ok(body.resourceSpans);
      sender.destroy();
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
