import { assert } from 'chai';
import {
  encodeExportTraceServiceRequest,
  decodeExportTraceServiceRequest,
  hexToBytes,
} from '../../src/telemetry/otlpProtobuf.js';

describe('otlpProtobuf', () => {
  it('converts hex IDs to fixed-length buffers', () => {
    const trace = hexToBytes('a'.repeat(32), 16, 'traceId');
    const span = hexToBytes('b'.repeat(16), 8, 'spanId');
    assert.strictEqual(trace.length, 16);
    assert.strictEqual(span.length, 8);
    assert.strictEqual(trace.toString('hex'), 'a'.repeat(32));
    assert.strictEqual(span.toString('hex'), 'b'.repeat(16));
    assert.strictEqual(hexToBytes('', 8, 'parentSpanId'), undefined);
    assert.throws(() => hexToBytes('zz', 8, 'spanId'), /hex string/);
    assert.throws(() => hexToBytes('ab', 8, 'spanId'), /expected 16 hex chars/);
  });

  it('round-trips ExportTraceServiceRequest with hex IDs', () => {
    const jsonRequest = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'svc' } },
            ],
          },
          scopeSpans: [
            {
              scope: { name: 'express_mcp', version: '1.0.0' },
              spans: [
                {
                  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
                  spanId: '00f067aa0ba902b7',
                  parentSpanId: '00f067aa0ba902b8',
                  name: 'mcp.tool.hello',
                  kind: 1,
                  startTimeUnixNano: '1710000000000000000',
                  endTimeUnixNano: '1710000000001000000',
                  status: { code: 1 },
                  attributes: [
                    {
                      key: 'openinference.span.kind',
                      value: { stringValue: 'TOOL' },
                    },
                    {
                      key: 'gen_ai.tool.name',
                      value: { stringValue: 'hello' },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const bytes = encodeExportTraceServiceRequest(jsonRequest);
    assert.ok(Buffer.isBuffer(bytes));
    assert.isAbove(bytes.length, 20);

    const decoded = decodeExportTraceServiceRequest(bytes);
    const span = decoded.resourceSpans[0].scopeSpans[0].spans[0];
    assert.strictEqual(span.name, 'mcp.tool.hello');
    assert.strictEqual(
      Buffer.from(span.traceId).toString('hex'),
      '4bf92f3577b34da6a3ce929d0e0e4736'
    );
    assert.strictEqual(
      Buffer.from(span.spanId).toString('hex'),
      '00f067aa0ba902b7'
    );
    assert.strictEqual(
      Buffer.from(span.parentSpanId).toString('hex'),
      '00f067aa0ba902b8'
    );
    const kind = span.attributes.find((a) => a.key === 'openinference.span.kind');
    assert.strictEqual(kind.value.stringValue, 'TOOL');
  });
});
