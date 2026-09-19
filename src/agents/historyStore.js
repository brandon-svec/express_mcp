/**
 * In-memory conversation history with TTL pruning per key.
 */
export class InMemoryHistoryStore {
  /**
   * @param {{ windowMinutes?: number, maxTurns?: number }} [options]
   */
  constructor (options = {}) {
    const windowMinutes = options.windowMinutes;
    if (typeof windowMinutes !== 'number' || !Number.isInteger(windowMinutes) || windowMinutes <= 0) {
      throw new Error(`Invalid history windowMinutes: ${windowMinutes}`);
    }
    this.windowMinutes = windowMinutes;

    if (options.maxTurns !== undefined) {
      const maxTurns = options.maxTurns;
      if (typeof maxTurns !== 'number' || !Number.isInteger(maxTurns) || maxTurns < 1) {
        throw new Error(`Invalid history maxTurns: ${maxTurns}`);
      }
      this.maxTurns = maxTurns;
    } else {
      this.maxTurns = null;
    }

    /** @type {Map<string, Array<{ recordedAt: Date, contents: Array<Object> }>>} */
    this.turnsByKey = new Map();
  }

  /**
   * @param {Array<{ recordedAt: Date, contents: Array<Object> }>} turns
   * @returns {Array<{ recordedAt: Date, contents: Array<Object> }>}
   * @private
   */
  _pruneTurns (turns) {
    const windowMs = this.windowMinutes * 60 * 1000;
    const cutoff = Date.now() - windowMs;
    let kept = turns.filter((turn) => turn.recordedAt.getTime() >= cutoff);
    if (this.maxTurns !== null && kept.length > this.maxTurns) {
      kept = kept.slice(kept.length - this.maxTurns);
    }
    return kept;
  }

  /**
   * @param {string} key
   * @returns {Array<Object>}
   */
  get (key) {
    if (typeof key !== 'string' || !key) {
      throw new Error('history key is required');
    }
    const turns = this.turnsByKey.get(key) || [];
    const kept = this._pruneTurns(turns);
    this.turnsByKey.set(key, kept);
    return kept.flatMap((turn) => turn.contents);
  }

  /**
   * @param {string} key
   * @param {Array<Object>} contents
   */
  append (key, contents) {
    if (typeof key !== 'string' || !key) {
      throw new Error('history key is required');
    }
    if (!Array.isArray(contents)) {
      throw new Error('contents must be an array');
    }
    if (!this.turnsByKey.has(key)) {
      this.turnsByKey.set(key, []);
    }
    this.turnsByKey.get(key).push({
      recordedAt: new Date(),
      contents,
    });
    this.turnsByKey.set(key, this._pruneTurns(this.turnsByKey.get(key)));
  }

  /**
   * @param {string} [key] - omit to clear all keys
   */
  clear (key) {
    if (key === undefined) {
      this.turnsByKey.clear();
      return;
    }
    if (typeof key !== 'string' || !key) {
      throw new Error('history key is required');
    }
    this.turnsByKey.delete(key);
  }
}
