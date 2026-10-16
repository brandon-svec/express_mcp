import {
  BLOCKING_HOOK_EVENTS,
  HOOK_EVENTS,
  HOOK_EXIT_CODES
} from './baseHook.js';

/**
 * Registry for in-process lifecycle hooks with middleware-style execution.
 */
export class HookRegistry {
  /**
   * @param {Object} [options={}]
   * @param {import('pino').Logger|null} [options.logger]
   */
  constructor(options = {}) {
    /** @type {Map<string, import('./baseHook.js').BaseHook>} */
    this.hooks = new Map();
    /** @type {string[]} registration order */
    this._order = [];
    this.logger = options.logger || null;
  }

  /**
   * Register a hook instance.
   * @param {import('./baseHook.js').BaseHook} hookInstance
   */
  register(hookInstance) {
    if (!hookInstance || typeof hookInstance.execute !== 'function') {
      throw new Error('Hook must have an execute method');
    }
    if (!hookInstance.name || typeof hookInstance.name !== 'string') {
      throw new Error('Hook must have a name');
    }
    if (!Array.isArray(hookInstance.events) || hookInstance.events.length === 0) {
      throw new Error('Hook must subscribe to at least one event');
    }
    for (const event of hookInstance.events) {
      if (!HOOK_EVENTS.includes(event)) {
        throw new Error(
          `Invalid hook event '${event}'. Must be one of: ${HOOK_EVENTS.join(', ')}`
        );
      }
    }
    if (this.hooks.has(hookInstance.name)) {
      throw new Error(
        `Hook '${hookInstance.name}' is already registered. Cannot register duplicate hook names.`
      );
    }

    this.hooks.set(hookInstance.name, hookInstance);
    this._order.push(hookInstance.name);
  }

  /**
   * @param {string} hookName
   * @returns {boolean}
   */
  unregister(hookName) {
    const wasRemoved = this.hooks.delete(hookName);
    if (wasRemoved) {
      this._order = this._order.filter((name) => name !== hookName);
    }
    return wasRemoved;
  }

  /**
   * @param {string} eventName
   * @returns {import('./baseHook.js').BaseHook[]}
   */
  getHooks(eventName) {
    return this._order
      .map((name) => this.hooks.get(name))
      .filter((hook) => hook && hook.events.includes(eventName));
  }

  /**
   * @returns {import('./baseHook.js').BaseHook[]} All hooks in registration order
   */
  getAllHooks() {
    return this._order
      .map((name) => this.hooks.get(name))
      .filter(Boolean);
  }

  /**
   * @param {string} hookName
   * @returns {boolean}
   */
  hasHook(hookName) {
    return this.hooks.has(hookName);
  }

  /**
   * @returns {number}
   */
  getHookCount() {
    return this.hooks.size;
  }

  clear() {
    this.hooks.clear();
    this._order = [];
  }

  /**
   * Build a normalized inbound event envelope.
   * @param {string} hookEventName
   * @param {Object} [fields={}]
   * @returns {Object}
   */
  buildEventPayload(hookEventName, fields = {}) {
    return {
      hook_event_name: hookEventName,
      session_id: fields.session_id ?? 'default',
      permission_mode: fields.permission_mode ?? 'default',
      timestamp: fields.timestamp ?? new Date().toISOString(),
      meta: {
        traceparent: fields.meta?.traceparent ?? null,
        turn_index: fields.meta?.turn_index ?? 0,
        ...(fields.meta || {})
      },
      tool_name: fields.tool_name ?? null,
      tool_input: fields.tool_input ?? null,
      tool_result: fields.tool_result ?? null,
      tool_annotations: fields.tool_annotations ?? null,
      user_prompt: fields.user_prompt ?? null,
      ...(fields.duration_ms !== undefined ? { duration_ms: fields.duration_ms } : {}),
      ...(fields.total_turn_count !== undefined
        ? { total_turn_count: fields.total_turn_count }
        : {}),
      ...(fields.exit_reason !== undefined ? { exit_reason: fields.exit_reason } : {})
    };
  }

  /**
   * Normalize a hook execute() return value into a result object.
   * @param {*} raw
   * @returns {Object}
   * @private
   */
  _normalizeResult(raw) {
    if (raw === undefined || raw === null) {
      return { exitCode: HOOK_EXIT_CODES.SUCCESS, decision: 'allow' };
    }
    if (typeof raw === 'string') {
      return {
        exitCode: HOOK_EXIT_CODES.SUCCESS,
        decision: 'allow',
        additionalContext: raw
      };
    }
    if (typeof raw === 'object') {
      return raw;
    }
    return { exitCode: HOOK_EXIT_CODES.SUCCESS, decision: 'allow' };
  }

  /**
   * Run matching hooks for an event in registration order.
   * @param {string} hookEventName
   * @param {Object} fields
   * @param {Object} [context={}]
   * @returns {Promise<{
   *   blocked: boolean,
   *   decision: string|null,
   *   updatedInput: *,
   *   additionalContext: string|null,
   *   userMessages: string[],
   *   stderr: string|null,
   *   hookEvent: string,
   *   exitCode: number
   * }>}
   */
  async runHooks(hookEventName, fields = {}, context = {}) {
    const event = this.buildEventPayload(hookEventName, fields);
    const isBlockingEvent = BLOCKING_HOOK_EVENTS.has(hookEventName);
    const contextParts = [];
    const userMessages = [];
    let updatedInput = null;
    let lastDecision = 'allow';
    let lastExitCode = HOOK_EXIT_CODES.SUCCESS;
    let lastStderr = null;

    const candidates = this.getHooks(hookEventName).filter((hook) => hook.matches(event));

    for (const hook of candidates) {
      let raw;
      try {
        raw = await hook.execute(event, context);
      } catch (error) {
        this.logger?.warn?.(
          {
            hookName: hook.name,
            hookEvent: hookEventName,
            error: error?.message,
            stack: error?.stack
          },
          'Hook execute() threw unexpected error'
        );
        if (hook.failClosed === true && isBlockingEvent) {
          return {
            blocked: true,
            decision: 'deny',
            updatedInput,
            additionalContext: contextParts.length > 0 ? contextParts.join('\n') : null,
            userMessages,
            stderr: error?.message || 'Hook failed closed',
            hookEvent: hookEventName,
            exitCode: HOOK_EXIT_CODES.BLOCKING_ERROR
          };
        }
        continue;
      }

      const result = this._normalizeResult(raw);
      const exitCode = typeof result.exitCode === 'number'
        ? result.exitCode
        : HOOK_EXIT_CODES.SUCCESS;
      const decision = result.decision ?? (
        exitCode === HOOK_EXIT_CODES.BLOCKING_ERROR ? 'deny' : 'allow'
      );

      if (typeof result.additionalContext === 'string' && result.additionalContext.length > 0) {
        contextParts.push(result.additionalContext);
      }
      if (typeof result.userMessage === 'string' && result.userMessage.length > 0) {
        userMessages.push(result.userMessage);
      }
      if (typeof result.stderr === 'string' && result.stderr.length > 0) {
        lastStderr = result.stderr;
      }

      if (decision === 'modify' && result.updatedInput !== undefined) {
        updatedInput = result.updatedInput;
        if (hookEventName === 'UserPromptSubmit') {
          event.user_prompt = typeof updatedInput === 'string'
            ? updatedInput
            : updatedInput?.user_prompt ?? event.user_prompt;
        } else {
          event.tool_input = updatedInput;
        }
      }

      lastDecision = decision;
      lastExitCode = exitCode;

      const isDeny = decision === 'deny' || exitCode === HOOK_EXIT_CODES.BLOCKING_ERROR;
      if (isDeny && isBlockingEvent) {
        return {
          blocked: true,
          decision: 'deny',
          updatedInput,
          additionalContext: contextParts.length > 0 ? contextParts.join('\n') : null,
          userMessages,
          stderr: lastStderr || result.stderr || 'Hook blocked',
          hookEvent: hookEventName,
          exitCode: HOOK_EXIT_CODES.BLOCKING_ERROR
        };
      }

      // Non-blocking events: deny/exitCode 2 treated as warning; continue chain
    }

    return {
      blocked: false,
      decision: lastDecision,
      updatedInput,
      additionalContext: contextParts.length > 0 ? contextParts.join('\n') : null,
      userMessages,
      stderr: lastStderr,
      hookEvent: hookEventName,
      exitCode: lastExitCode
    };
  }
}
