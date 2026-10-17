import { assert } from 'chai';
import {
  sanitizeValue,
  sanitizeToAttributeString,
  truncateString,
} from '../../src/telemetry/sanitizer.js';

const KEYS = ['password', 'secret', 'token', 'authorization', 'apiKey'];

describe('sanitizer', () => {
  describe('sanitizeValue', () => {
    it('redacts nested sensitive keys case-insensitively', () => {
      const input = {
        query: 'hello',
        password: 'hunter2',
        nested: {
          Token: 'abc',
          api_key: 'keep-me',
          apiKey: 'sk-secret',
          Authorization: 'Bearer x',
        },
      };
      const out = sanitizeValue(input, KEYS, 4096);
      assert.strictEqual(out.password, '[REDACTED]');
      assert.strictEqual(out.nested.Token, '[REDACTED]');
      assert.strictEqual(out.nested.apiKey, '[REDACTED]');
      assert.strictEqual(out.nested.Authorization, '[REDACTED]');
      assert.strictEqual(out.nested.api_key, 'keep-me');
      assert.strictEqual(out.query, 'hello');
    });

    it('redacts keys inside arrays', () => {
      const out = sanitizeValue([{ secret: 'x' }, { ok: 1 }], KEYS, 4096);
      assert.strictEqual(out[0].secret, '[REDACTED]');
      assert.strictEqual(out[1].ok, 1);
    });

    it('truncates long strings', () => {
      const long = 'a'.repeat(100);
      assert.strictEqual(sanitizeValue(long, KEYS, 10), 'a'.repeat(10));
    });

    it('throws on invalid maxAttributeLength', () => {
      assert.throws(() => sanitizeValue({}, KEYS, 0));
    });
  });

  describe('truncateString', () => {
    it('returns short strings unchanged', () => {
      assert.strictEqual(truncateString('hi', 10), 'hi');
    });

    it('truncates without ellipsis', () => {
      assert.strictEqual(truncateString('abcdef', 3), 'abc');
    });
  });

  describe('sanitizeToAttributeString', () => {
    it('JSON-stringifies objects after redaction', () => {
      const s = sanitizeToAttributeString({ password: 'x', a: 1 }, KEYS, 4096);
      const parsed = JSON.parse(s);
      assert.strictEqual(parsed.password, '[REDACTED]');
      assert.strictEqual(parsed.a, 1);
    });

    it('truncates the final string', () => {
      const s = sanitizeToAttributeString({ a: 'x'.repeat(100) }, KEYS, 20);
      assert.strictEqual(s.length, 20);
    });
  });
});
