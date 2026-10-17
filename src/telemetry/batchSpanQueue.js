/**
 * Bounded in-memory span queue with dual-trigger flush (count or timer).
 */

/**
 * @typedef {Object} BatchSpanQueueOptions
 * @property {number} batchMaxSpans
 * @property {number} batchTimeoutMs
 * @property {number} maxQueueSize
 * @property {(spans: object[]) => Promise<void>} exportBatch
 * @property {{ debug?: Function, warn?: Function }|null} [logger]
 * @property {typeof setTimeout} [setTimeoutFn]
 * @property {typeof clearTimeout} [clearTimeoutFn]
 */

export class BatchSpanQueue {
  /**
   * @param {BatchSpanQueueOptions} options
   */
  constructor(options) {
    if (!options || typeof options.exportBatch !== 'function') {
      throw new Error('exportBatch is required');
    }
    if (typeof options.batchMaxSpans !== 'number' || options.batchMaxSpans < 1) {
      throw new Error('batchMaxSpans must be a positive integer');
    }
    if (typeof options.batchTimeoutMs !== 'number' || options.batchTimeoutMs < 1) {
      throw new Error('batchTimeoutMs must be a positive integer');
    }
    if (typeof options.maxQueueSize !== 'number' || options.maxQueueSize < 1) {
      throw new Error('maxQueueSize must be a positive integer');
    }

    this.batchMaxSpans = options.batchMaxSpans;
    this.batchTimeoutMs = options.batchTimeoutMs;
    this.maxQueueSize = options.maxQueueSize;
    this.exportBatch = options.exportBatch;
    this.logger = options.logger ?? null;
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;

    /** @type {object[]} */
    this._queue = [];
    /** @type {ReturnType<typeof setTimeout>|null} */
    this._timer = null;
    this._flushing = false;
    this._shutdown = false;
    /** @type {Promise<void>|null} */
    this._flushPromise = null;
  }

  /**
   * @param {object} span
   */
  enqueue(span) {
    if (this._shutdown) {
      this.logger?.debug?.({ spanName: span?.name }, 'Dropping span after queue shutdown');
      return;
    }
    if (this._queue.length >= this.maxQueueSize) {
      this._queue.shift();
      this.logger?.debug?.('Telemetry queue full; dropped oldest span');
    }
    this._queue.push(span);
    if (this._queue.length >= this.batchMaxSpans) {
      this._scheduleFlush(true);
    } else {
      this._armTimer();
    }
  }

  /**
   * @private
   */
  _armTimer() {
    if (this._timer || this._shutdown) {
      return;
    }
    this._timer = this.setTimeoutFn(() => {
      this._timer = null;
      this._scheduleFlush(false);
    }, this.batchTimeoutMs);
    if (typeof this._timer.unref === 'function') {
      this._timer.unref();
    }
  }

  /**
   * @private
   */
  _clearTimer() {
    if (this._timer) {
      this.clearTimeoutFn(this._timer);
      this._timer = null;
    }
  }

  /**
   * @param {boolean} immediate
   * @private
   */
  _scheduleFlush(immediate) {
    if (immediate) {
      this._clearTimer();
    }
    if (!this._flushPromise) {
      this._flushPromise = this._runFlushLoop().finally(() => {
        this._flushPromise = null;
      });
    }
  }

  /**
   * @private
   */
  async _runFlushLoop() {
    while (this._queue.length > 0 && !this._flushing) {
      await this._flushOnce();
    }
  }

  /**
   * @private
   */
  async _flushOnce() {
    if (this._flushing || this._queue.length === 0) {
      return;
    }
    this._flushing = true;
    this._clearTimer();
    const batch = this._queue.splice(0, this.batchMaxSpans);
    try {
      await this.exportBatch(batch);
    } catch (err) {
      this.logger?.debug?.(
        { error: err?.message, batchSize: batch.length },
        'Telemetry batch export failed'
      );
    } finally {
      this._flushing = false;
      if (this._queue.length > 0 && !this._shutdown) {
        if (this._queue.length >= this.batchMaxSpans) {
          // continue loop via _runFlushLoop
        } else {
          this._armTimer();
        }
      }
    }
  }

  /**
   * Stop accepting spans, clear timer, drain remaining queue.
   * @returns {Promise<void>}
   */
  async shutdown() {
    this._shutdown = true;
    this._clearTimer();
    if (this._flushPromise) {
      await this._flushPromise;
    }
    while (this._queue.length > 0) {
      await this._flushOnce();
    }
  }

  /**
   * @returns {number}
   */
  get size() {
    return this._queue.length;
  }
}
