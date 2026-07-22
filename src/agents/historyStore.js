/**
 * In-memory conversation history with TTL pruning per key.
 */
export class InMemoryHistoryStore {
  /**
   * @param {{ windowMinutes?: number }} [options]
   */
  constructor (options = {}) {
    const windowMinutes = options.windowMinutes;
    if (typeof windowMinutes !== 'number' || !Number.isInteger(windowMinutes) || windowMinutes <= 0) {
      throw new Error(`Invalid history windowMinutes: ${windowMinutes}`);
    }
    this.windowMinutes = windowMinutes;
    /** @type {Map<string, Array<{ recordedAt: Date, contents: Array<Object> }>>} */
    this.turnsByKey = new Map();
  }

  /**
   * @param {string} key
   * @returns {Array<Object>}
   */
  get (key) {
    if (typeof key !== 'string' || !key) {
      throw new Error('history key is required');
    }
    const windowMs = this.windowMinutes * 60 * 1000;
    const cutoff = Date.now() - windowMs;
    const turns = this.turnsByKey.get(key) || [];
    const kept = turns.filter((turn) => turn.recordedAt.getTime() >= cutoff);
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
