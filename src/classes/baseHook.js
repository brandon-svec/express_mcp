/**
 * Lifecycle events supported by the in-process hook framework.
 * @type {readonly string[]}
 */
export const HOOK_EVENTS = Object.freeze([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'Stop'
]);

/**
 * Events that may halt execution when a hook returns deny / exitCode 2.
 * @type {ReadonlySet<string>}
 */
export const BLOCKING_HOOK_EVENTS = Object.freeze(new Set([
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'Stop'
]));

/**
 * Conventional hook exit codes.
 * @type {Readonly<{ SUCCESS: number, WARNING: number, BLOCKING_ERROR: number }>}
 */
export const HOOK_EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  WARNING: 1,
  BLOCKING_ERROR: 2
});

/**
 * Thrown when a blocking hook halts Agent.processMessage
 * (UserPromptSubmit deny, or Stop deny after exhausting maxToolRounds).
 */
export class HookBlockedError extends Error {
  /**
   * @param {string} message
   * @param {Object} [details={}]
   * @param {string} [details.hookEvent]
   * @param {number} [details.exitCode=2]
   * @param {string|null} [details.stderr]
   * @param {string|null} [details.additionalContext]
   * @param {string|null} [details.userMessage]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'HookBlockedError';
    this.hookEvent = details.hookEvent ?? null;
    this.exitCode = details.exitCode ?? HOOK_EXIT_CODES.BLOCKING_ERROR;
    this.stderr = details.stderr ?? message;
    this.additionalContext = details.additionalContext ?? null;
    this.userMessage = details.userMessage ?? null;
  }
}

/**
 * Base class for in-process lifecycle hooks.
 */
export class BaseHook {
  /**
   * @param {string} name - Unique hook name
   * @param {string|string[]} events - Lifecycle event(s) from HOOK_EVENTS
   * @param {Object} [options={}]
   * @param {string} [options.description] - Optional hook description
   * @param {string|RegExp|string[]} [options.matcher] - Optional tool_name filter
   * @param {boolean} [options.failClosed=false] - Block if execute() throws on a blocking event
   */
  constructor(name, events, options = {}) {
    if (!name || typeof name !== 'string') {
      throw new Error('Hook name is required and must be a string');
    }

    const eventList = Array.isArray(events) ? events : [events];
    if (eventList.length === 0) {
      throw new Error('Hook must subscribe to at least one event');
    }
    for (const event of eventList) {
      if (!HOOK_EVENTS.includes(event)) {
        throw new Error(
          `Invalid hook event '${event}'. Must be one of: ${HOOK_EVENTS.join(', ')}`
        );
      }
    }

    if (options.matcher !== undefined) {
      const { matcher } = options;
      const isString = typeof matcher === 'string';
      const isRegExp = matcher instanceof RegExp;
      const isStringArray = Array.isArray(matcher)
        && matcher.length > 0
        && matcher.every((m) => typeof m === 'string');
      if (!isString && !isRegExp && !isStringArray) {
        throw new Error(
          'Hook matcher must be a string, RegExp, or non-empty array of strings'
        );
      }
    }

    this.name = name;
    this.events = Object.freeze([...eventList]);
    this.description = typeof options.description === 'string'
      ? options.description
      : undefined;
    this.matcher = options.matcher;
    this.failClosed = options.failClosed === true;
  }

  /**
   * Check whether this hook applies to the given inbound event payload.
   * Matcher is only applied when the event has a tool_name (tool hooks).
   * @param {Object} event
   * @returns {boolean}
   */
  matches(event) {
    if (!event || typeof event !== 'object') {
      return false;
    }
    if (!this.events.includes(event.hook_event_name)) {
      return false;
    }
    if (this.matcher === undefined || event.tool_name == null) {
      return true;
    }
    const toolName = event.tool_name;
    if (typeof this.matcher === 'string') {
      return toolName === this.matcher;
    }
    if (this.matcher instanceof RegExp) {
      return this.matcher.test(toolName);
    }
    if (Array.isArray(this.matcher)) {
      return this.matcher.includes(toolName);
    }
    return true;
  }

  /**
   * Execute hook logic. Subclasses must override.
   * @param {Object} _event - Inbound event payload
   * @param {Object} _context - Execution context
   * @returns {Promise<Object|string|void>}
   */
  async execute(_event, _context) {
    throw new Error('execute method must be implemented by subclass');
  }

  /**
   * @param {Object} [options={}]
   * @returns {Object}
   */
  allow(options = {}) {
    return { exitCode: HOOK_EXIT_CODES.SUCCESS, decision: 'allow', ...options };
  }

  /**
   * @param {*} updatedInput
   * @param {Object} [options={}]
   * @returns {Object}
   */
  modify(updatedInput, options = {}) {
    return {
      exitCode: HOOK_EXIT_CODES.SUCCESS,
      decision: 'modify',
      updatedInput,
      ...options
    };
  }

  /**
   * @param {string} reason
   * @param {Object} [options={}]
   * @returns {Object}
   */
  deny(reason, options = {}) {
    return {
      exitCode: HOOK_EXIT_CODES.BLOCKING_ERROR,
      decision: 'deny',
      stderr: reason,
      ...options
    };
  }

  /**
   * @param {string} message
   * @param {Object} [options={}]
   * @returns {Object}
   */
  warn(message, options = {}) {
    return { exitCode: HOOK_EXIT_CODES.WARNING, stderr: message, ...options };
  }
}
