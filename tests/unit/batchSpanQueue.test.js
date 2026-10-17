import { assert } from 'chai';
import { BatchSpanQueue } from '../../src/telemetry/batchSpanQueue.js';

describe('BatchSpanQueue', () => {
  it('flushes when batchMaxSpans is reached', async () => {
    /** @type {object[][]} */
    const batches = [];
    const queue = new BatchSpanQueue({
      batchMaxSpans: 3,
      batchTimeoutMs: 60_000,
      maxQueueSize: 100,
      exportBatch: async (spans) => {
        batches.push(spans);
      },
    });

    queue.enqueue({ name: 'a' });
    queue.enqueue({ name: 'b' });
    assert.strictEqual(batches.length, 0);
    queue.enqueue({ name: 'c' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(batches.length, 1);
    assert.deepStrictEqual(batches[0].map((s) => s.name), ['a', 'b', 'c']);
    assert.strictEqual(queue.size, 0);
  });

  it('flushes on timer', async () => {
    /** @type {object[][]} */
    const batches = [];
    /** @type {Function[]} */
    const pending = [];
    const queue = new BatchSpanQueue({
      batchMaxSpans: 50,
      batchTimeoutMs: 10,
      maxQueueSize: 100,
      exportBatch: async (spans) => {
        batches.push(spans);
      },
      setTimeoutFn: (fn) => {
        pending.push(fn);
        return { unref() {} };
      },
      clearTimeoutFn: () => {},
    });

    queue.enqueue({ name: 't1' });
    assert.strictEqual(pending.length, 1);
    pending[0]();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(batches.length, 1);
    assert.strictEqual(batches[0][0].name, 't1');
  });

  it('drops oldest when maxQueueSize is exceeded', async () => {
    /** @type {object[][]} */
    const batches = [];
    const queue = new BatchSpanQueue({
      batchMaxSpans: 10,
      batchTimeoutMs: 60_000,
      maxQueueSize: 2,
      exportBatch: async (spans) => {
        batches.push(spans);
      },
    });

    queue.enqueue({ name: 'old' });
    queue.enqueue({ name: 'mid' });
    queue.enqueue({ name: 'new' });
    assert.strictEqual(queue.size, 2);
    await queue.shutdown();
    assert.strictEqual(batches.length, 1);
    assert.deepStrictEqual(batches[0].map((s) => s.name), ['mid', 'new']);
  });

  it('drains remaining spans on shutdown', async () => {
    /** @type {object[][]} */
    const batches = [];
    const queue = new BatchSpanQueue({
      batchMaxSpans: 50,
      batchTimeoutMs: 60_000,
      maxQueueSize: 100,
      exportBatch: async (spans) => {
        batches.push(spans);
      },
    });

    queue.enqueue({ name: 'x' });
    queue.enqueue({ name: 'y' });
    await queue.shutdown();
    assert.strictEqual(batches.length, 1);
    assert.deepStrictEqual(batches[0].map((s) => s.name), ['x', 'y']);
    assert.strictEqual(queue.size, 0);

    queue.enqueue({ name: 'after' });
    assert.strictEqual(queue.size, 0);
  });
});
