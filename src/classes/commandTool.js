import { BaseTool } from './baseTool.js';

const VALID_MODES = new Set(['direct', 'prompt', 'hybrid']);

/**
 * @typedef {Object} CommandMatch
 * @property {CommandTool} tool
 * @property {'direct'|'prompt'|'hybrid'} mode
 * @property {RegExpExecArray|null} match
 * @property {Object} args
 * @property {string} prompt
 * @property {string|null|undefined} ephemeralPrefix
 * @property {string} historyUserText
 */

/**
 * MCP tool with optional chat triggers for fast-path / prompt-macro routing.
 * Extends BaseTool; tools without triggers behave as standard MCP tools.
 */
export class CommandTool extends BaseTool {
  /**
   * @param {string} name
   * @param {string} description
   * @param {Object} [inputSchema]
   * @param {Object} [options]
   * @param {Array<string|RegExp>} [options.triggers]
   * @param {'direct'|'prompt'|'hybrid'} [options.mode='direct']
   * @param {Object|((match: RegExpExecArray|null, text: string) => Object)} [options.defaultArgs]
   * @param {(result: any, context?: any) => string|Promise<string>} [options.formatResponse]
   * @param {string|((match: RegExpExecArray|null, text: string, data?: any) => string)} [options.prompt]
   * @param {string|((match: RegExpExecArray|null, text: string) => string)} [options.ephemeralPrefix]
   * @param {string|((match: RegExpExecArray|null, text: string) => string)} [options.historyUserText]
   * @param {string[]} [options.toolNames]
   * @param {Object} [options.annotations]
   */
  constructor (name, description, inputSchema, options = {}) {
    if (options !== undefined && (typeof options !== 'object' || options === null || Array.isArray(options))) {
      throw new Error('CommandTool options must be a plain object when provided');
    }
    super(name, description, inputSchema, options.annotations);

    if (options.triggers !== undefined && !Array.isArray(options.triggers)) {
      throw new Error('CommandTool triggers must be an array when provided');
    }

    this.triggers = options.triggers || [];
    this.mode = options.mode || 'direct';
    if (!VALID_MODES.has(this.mode)) {
      throw new Error(`Invalid CommandTool mode: ${this.mode}. Must be 'direct', 'prompt', or 'hybrid'.`);
    }

    this.defaultArgs = options.defaultArgs !== undefined ? options.defaultArgs : {};
    this.formatResponse = options.formatResponse || ((result) => (
      typeof result === 'string' ? result : JSON.stringify(result, null, 2)
    ));
    this.promptTemplate = options.prompt !== undefined ? options.prompt : null;
    this.ephemeralPrefix = options.ephemeralPrefix !== undefined ? options.ephemeralPrefix : null;
    this.historyUserText = options.historyUserText !== undefined ? options.historyUserText : null;

    if (options.toolNames !== undefined) {
      if (!Array.isArray(options.toolNames) || !options.toolNames.every((n) => typeof n === 'string')) {
        throw new Error('CommandTool toolNames must be an array of strings when provided');
      }
      this.toolNames = options.toolNames;
    }
  }

  /**
   * Test text against triggers. First match wins.
   * @param {string} text
   * @returns {CommandMatch|null}
   */
  match (text) {
    if (typeof text !== 'string') {
      return null;
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return null;
    }

    for (const trigger of this.triggers) {
      let regexMatch = null;
      let matched = false;

      if (trigger instanceof RegExp) {
        const pattern = new RegExp(trigger.source, trigger.flags);
        pattern.lastIndex = 0;
        regexMatch = pattern.exec(trimmed);
        matched = regexMatch !== null;
      } else if (typeof trigger === 'string') {
        matched = trigger.toLowerCase() === trimmed.toLowerCase();
        if (matched) {
          regexMatch = Object.assign([trimmed], { input: trimmed, index: 0 });
        }
      }

      if (matched) {
        const args = typeof this.defaultArgs === 'function'
          ? this.defaultArgs(regexMatch, trimmed)
          : { ...this.defaultArgs };
        const prompt = typeof this.promptTemplate === 'function'
          ? this.promptTemplate(regexMatch, trimmed)
          : (this.promptTemplate || trimmed);
        const ephemeralPrefix = typeof this.ephemeralPrefix === 'function'
          ? this.ephemeralPrefix(regexMatch, trimmed)
          : this.ephemeralPrefix;
        const historyUserText = typeof this.historyUserText === 'function'
          ? this.historyUserText(regexMatch, trimmed)
          : (this.historyUserText || trimmed);
        return {
          tool: this,
          mode: this.mode,
          match: regexMatch,
          args,
          prompt,
          ephemeralPrefix,
          historyUserText,
        };
      }
    }
    return null;
  }
}
