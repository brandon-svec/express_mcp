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

    /** @type {Map<string, Array<{ recordedAt: Date, contents: Array<Object>, toolNames: string[] }>>} */
    this.turnsByKey = new Map();
  }

  /**
   * @param {Array<{ recordedAt: Date, contents: Array<Object>, toolNames?: string[] }>} turns
   * @returns {Array<{ recordedAt: Date, contents: Array<Object>, toolNames: string[] }>}
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
   * @returns {Array<{ recordedAt: Date, contents: Array<Object>, toolNames: string[] }>}
   * @private
   */
  _keptTurns (key) {
    if (typeof key !== 'string' || !key) {
      throw new Error('history key is required');
    }
    const turns = this.turnsByKey.get(key) || [];
    const kept = this._pruneTurns(turns);
    this.turnsByKey.set(key, kept);
    return kept;
  }

  /**
   * @param {string} key
   * @returns {Array<Object>}
   */
  get (key) {
    return this._keptTurns(key).flatMap((turn) => turn.contents);
  }

  /**
   * Pruned turns with timestamps (for hosts that build relative-time transcripts).
   * Returns detached copies so callers can reverse/mutate without affecting store order.
   * @param {string} key
   * @returns {Array<{ recordedAt: Date, contents: Array<Object>, toolNames: string[] }>}
   */
  getTurns (key) {
    return this._keptTurns(key).map((turn) => ({
      recordedAt: new Date(turn.recordedAt.getTime()),
      contents: [...turn.contents],
      toolNames: Array.isArray(turn.toolNames) ? [...turn.toolNames] : [],
    }));
  }

  /**
   * @param {string} key
   * @param {Array<Object>} contents
   * @param {{ recordedAt?: Date|number, toolNames?: string[] }} [options]
   */
  append (key, contents, options = {}) {
    if (typeof key !== 'string' || !key) {
      throw new Error('history key is required');
    }
    if (!Array.isArray(contents)) {
      throw new Error('contents must be an array');
    }
    if (options !== undefined && (typeof options !== 'object' || options === null || Array.isArray(options))) {
      throw new Error('options must be a plain object when provided');
    }
    let recordedAt = new Date();
    if (options.recordedAt !== undefined) {
      recordedAt = normalizeRecordedAt(options.recordedAt);
    }
    /** @type {string[]} */
    let toolNames = [];
    if (options.toolNames !== undefined) {
      if (!Array.isArray(options.toolNames)) {
        throw new Error('toolNames must be an array when provided');
      }
      for (const name of options.toolNames) {
        if (typeof name !== 'string' || name.length === 0) {
          throw new Error('toolNames entries must be non-empty strings');
        }
      }
      toolNames = [...options.toolNames];
    }
    if (!this.turnsByKey.has(key)) {
      this.turnsByKey.set(key, []);
    }
    this.turnsByKey.get(key).push({
      recordedAt,
      contents,
      toolNames,
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

/**
 * @param {unknown} recordedAt
 * @returns {Date}
 */
export function normalizeRecordedAt (recordedAt) {
  if (recordedAt instanceof Date) {
    if (Number.isNaN(recordedAt.getTime())) {
      throw new Error('recordedAt must be a valid Date or timestamp');
    }
    return recordedAt;
  }
  if (typeof recordedAt === 'number' && Number.isFinite(recordedAt)) {
    const date = new Date(recordedAt);
    if (Number.isNaN(date.getTime())) {
      throw new Error('recordedAt must be a valid Date or timestamp');
    }
    return date;
  }
  throw new Error('recordedAt must be a valid Date or timestamp');
}

/**
 * @param {object} content
 * @returns {string|null}
 */
function textFromContent (content) {
  if (!content || typeof content !== 'object' || !Array.isArray(content.parts)) {
    return null;
  }
  for (const part of content.parts) {
    if (!part || typeof part !== 'object') {
      continue;
    }
    if (typeof part.text !== 'string') {
      continue;
    }
    if (part.text.startsWith('HOST_TOOLS:')) {
      continue;
    }
    return part.text;
  }
  return null;
}

/**
 * Format timestamped history turns as a newest-first relative transcript.
 * Reverses turns and each turn's contents so a stored [user, model] pair
 * renders as Model above User (shared recordedAt when turns were not split).
 *
 * @param {Array<{ recordedAt: Date, contents: Array<Object> }>} turns
 * @param {{
 *   now?: Date|number,
 *   userLabel?: string,
 *   modelLabel?: string,
 * }} [options]
 * @returns {string}
 */
export function formatTurnsTranscript (turns, options = {}) {
  if (!Array.isArray(turns)) {
    throw new Error('turns must be an array');
  }
  if (options !== undefined && (typeof options !== 'object' || options === null || Array.isArray(options))) {
    throw new Error('options must be a plain object when provided');
  }
  const nowMs = options.now === undefined
    ? Date.now()
    : options.now instanceof Date
      ? options.now.getTime()
      : options.now;
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs) || Number.isNaN(nowMs)) {
    throw new Error('now must be a valid Date or timestamp');
  }
  const userLabel = options.userLabel === undefined ? 'User' : options.userLabel;
  const modelLabel = options.modelLabel === undefined ? 'Model' : options.modelLabel;
  if (typeof userLabel !== 'string' || userLabel.length === 0) {
    throw new Error('userLabel must be a non-empty string when provided');
  }
  if (typeof modelLabel !== 'string' || modelLabel.length === 0) {
    throw new Error('modelLabel must be a non-empty string when provided');
  }

  const lines = [];
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (!turn || !(turn.recordedAt instanceof Date) || Number.isNaN(turn.recordedAt.getTime())) {
      throw new Error('each turn must have a valid recordedAt Date');
    }
    if (!Array.isArray(turn.contents)) {
      throw new Error('each turn must have a contents array');
    }
    const seconds = Math.round((turn.recordedAt.getTime() - nowMs) / 1000);
    for (let j = turn.contents.length - 1; j >= 0; j -= 1) {
      const content = turn.contents[j];
      const text = textFromContent(content);
      if (text === null) {
        continue;
      }
      const role = content.role === 'model' ? modelLabel : userLabel;
      lines.push(`${seconds}, ${role}, ${text}`);
    }
  }
  return lines.join('\n');
}
