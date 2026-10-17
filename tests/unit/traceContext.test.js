import { assert } from 'chai';
import {
  generateTraceId,
  generateSpanId,
  parseTraceparent,
  serializeTraceparent,
} from '../../src/telemetry/traceContext.js';

describe('traceContext', () => {
  describe('generateTraceId / generateSpanId', () => {
    it('generates 32-char lowercase hex trace IDs', () => {
      const id = generateTraceId();
      assert.match(id, /^[0-9a-f]{32}$/);
    });

    it('generates 16-char lowercase hex span IDs', () => {
      const id = generateSpanId();
      assert.match(id, /^[0-9a-f]{16}$/);
    });

    it('generates unique IDs', () => {
      assert.notStrictEqual(generateTraceId(), generateTraceId());
      assert.notStrictEqual(generateSpanId(), generateSpanId());
    });
  });

  describe('parseTraceparent', () => {
    it('parses a valid W3C traceparent', () => {
      const parsed = parseTraceparent(
        '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
      );
      assert.deepStrictEqual(parsed, {
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
        spanId: '00f067aa0ba902b7',
        flags: '01',
      });
    });

    it('lowercases hex', () => {
      const parsed = parseTraceparent(
        '00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01'
      );
      assert.strictEqual(parsed.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
      assert.strictEqual(parsed.spanId, '00f067aa0ba902b7');
    });

    it('returns null for missing or invalid headers', () => {
      assert.isNull(parseTraceparent(null));
      assert.isNull(parseTraceparent(undefined));
      assert.isNull(parseTraceparent(''));
      assert.isNull(parseTraceparent('not-a-traceparent'));
      assert.isNull(parseTraceparent('01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'));
      assert.isNull(parseTraceparent('00-short-00f067aa0ba902b7-01'));
    });
  });

  describe('serializeTraceparent', () => {
    it('serializes valid ids', () => {
      assert.strictEqual(
        serializeTraceparent(
          '4bf92f3577b34da6a3ce929d0e0e4736',
          '00f067aa0ba902b7'
        ),
        '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
      );
    });

    it('throws on invalid ids', () => {
      assert.throws(() => serializeTraceparent('bad', '00f067aa0ba902b7'));
      assert.throws(() => serializeTraceparent('4bf92f3577b34da6a3ce929d0e0e4736', 'bad'));
    });
  });
});
