import { ToolExecution } from '../classes/toolExecution.js';
import { HookBlockedError, HOOK_EXIT_CODES } from '../classes/baseHook.js';
import { GeminiAdapter } from './geminiAdapter.js';

const HISTORY_TOOL_TURNS = new Set(['full', 'omit', 'digest']);

const DIGEST_ERROR_MAX_CHARS = 200;

/**
 * @param {string} message
 * @returns {string}
 */
function truncateDigestError (message) {
  if (typeof message !== 'string') {
    throw new Error('digest error must be a string');
  }
  if (message.length <= DIGEST_ERROR_MAX_CHARS) {
    return message;
  }
  return message.slice(0, DIGEST_ERROR_MAX_CHARS);
}

export const REQUEST_TOOLS_NAME = 'request_tools';

const REQUEST_TOOLS_DECLARATION = {
  name: REQUEST_TOOLS_NAME,
  description:
    'Request a broader tool set when the current tools cannot complete the user request. Call once with a short reason.',
  parameters: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'Why additional tools are needed',
      },
    },
    required: ['reason'],
    additionalProperties: false,
  },
};

/**
 * Recursively sort object keys alphabetically for stable JSON serialization.
 * @param {unknown} value
 * @returns {unknown}
 */
export function canonicalizeValue (value) {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeValue(item));
  }
  if (value !== null && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalizeValue(value[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Gemini conversation contents must start with a user turn. Host-recorded
 * assistant messages may leave prior history starting with role model.
 *
 * @param {Array<object>} contents
 * @returns {Array<object>}
 */
function ensureUserLeadingContents (contents) {
  if (!Array.isArray(contents)) {
    throw new Error('contents must be an array');
  }
  if (contents.length === 0 || contents[0].role !== 'model') {
    return contents;
  }
  return [
    { role: 'user', parts: [{ text: '[continued]' }] },
    ...contents,
  ];
}

/**
 * @param {{ modelParts?: Array<object>, functionCalls?: Array<object>|null }} response
 * @returns {Array<object>}
 */
function modelPartsForEcho (response) {
  if (Array.isArray(response.modelParts) && response.modelParts.length > 0) {
    return response.modelParts;
  }
  const functionCalls = response.functionCalls;
  if (!Array.isArray(functionCalls)) {
    throw new Error('Model function calls missing parts to echo');
  }
  return functionCalls.map((fc) => {
    const part = {
      functionCall: {
        name: fc.name,
        args: fc.args,
      },
    };
    if (fc.thoughtSignature != null && fc.thoughtSignature !== '') {
      part.thoughtSignature = fc.thoughtSignature;
    }
    return part;
  });
}

/**
 * @param {unknown} parts
 * @returns {string[]}
 */
function partKinds (parts) {
  if (!Array.isArray(parts)) {
    return [];
  }
  return parts.map((part) => {
    if (!part || typeof part !== 'object') {
      return 'other';
    }
    if (part.functionCall) {
      return 'functionCall';
    }
    if (part.functionResponse) {
      return 'functionResponse';
    }
    if (typeof part.text === 'string') {
      return 'text';
    }
    return 'other';
  });
}

/**
 * @param {Array<object>} contents
 * @param {string} systemInstruction
 * @param {Array<object>} toolDeclarations
 * @returns {{
 *   systemInstructionChars: number,
 *   toolDeclarationChars: number,
 *   toolCount: number,
 *   contentsChars: number,
 *   byContent: Array<{ index: number, role: string, partKinds: string[], chars: number }>
 * }}
 */
export function buildGenerateSizes (contents, systemInstruction, toolDeclarations) {
  return {
    systemInstructionChars: typeof systemInstruction === 'string' ? systemInstruction.length : 0,
    toolDeclarationChars: JSON.stringify(toolDeclarations).length,
    toolCount: Array.isArray(toolDeclarations) ? toolDeclarations.length : 0,
    contentsChars: JSON.stringify(contents).length,
    byContent: contents.map((content, index) => ({
      index,
      role: content && typeof content === 'object' ? content.role : undefined,
      partKinds: partKinds(content && content.parts),
      chars: JSON.stringify(content).length,
    })),
  };
}

/**
 * Remove request_tools functionCall / functionResponse pairs from history contents.
 * Drops a content entirely when its parts become empty.
 *
 * @param {Array<object>} contents
 * @returns {Array<object>}
 */
export function scrubRequestToolsFromContents (contents) {
  if (!Array.isArray(contents)) {
    throw new Error('contents must be an array');
  }
  const result = [];
  for (const content of contents) {
    if (!content || typeof content !== 'object' || !Array.isArray(content.parts)) {
      result.push(content);
      continue;
    }
    const parts = content.parts.filter((part) => {
      if (!part || typeof part !== 'object') {
        return true;
      }
      if (part.functionCall && part.functionCall.name === REQUEST_TOOLS_NAME) {
        return false;
      }
      if (part.functionResponse && part.functionResponse.name === REQUEST_TOOLS_NAME) {
        return false;
      }
      return true;
    });
    if (parts.length === 0) {
      continue;
    }
    if (parts.length === content.parts.length) {
      result.push(content);
      continue;
    }
    result.push({ ...content, parts });
  }
  return result;
}

/**
 * @param {Array<object>} turnContents
 * @param {string} userText
 * @param {'full'|'omit'|'digest'} historyToolTurns
 * @param {{ toolDigests?: Array<object> }} [digestOptions]
 * @returns {Array<object>}
 */
function contentsForHistory (turnContents, userText, historyToolTurns, digestOptions = {}) {
  if (historyToolTurns === 'omit') {
    const last = turnContents[turnContents.length - 1];
    if (!last || last.role !== 'model') {
      throw new Error('historyToolTurns omit requires a final model turn');
    }
    return [
      { role: 'user', parts: [{ text: userText }] },
      last,
    ];
  }

  if (historyToolTurns === 'digest') {
    const last = turnContents[turnContents.length - 1];
    if (!last || last.role !== 'model') {
      throw new Error('historyToolTurns digest requires a final model turn');
    }
    const replyPart = last.parts && last.parts.find((part) => typeof part.text === 'string');
    if (!replyPart) {
      throw new Error('historyToolTurns digest requires a final model text part');
    }
    const toolDigests = digestOptions.toolDigests;
    if (!Array.isArray(toolDigests)) {
      throw new Error('historyToolTurns digest requires toolDigests array');
    }
    const userContent = { role: 'user', parts: [{ text: userText }] };
    if (toolDigests.length === 0) {
      return [userContent, { role: 'model', parts: [{ text: replyPart.text }] }];
    }
    return [
      userContent,
      {
        role: 'model',
        parts: [
          { text: `HOST_TOOLS: ${JSON.stringify(toolDigests)}` },
          { text: replyPart.text },
        ],
      },
    ];
  }

  const withUserText = turnContents.map((content, index) => {
    if (index === 0 && content.role === 'user') {
      return { role: 'user', parts: [{ text: userText }] };
    }
    return content;
  });
  return scrubRequestToolsFromContents(withUserText);
}

/**
 * Generic tool-calling agent over a ToolRegistry and ModelAdapter.
 */
export class Agent {
  /**
   * @param {Object} options
   * @param {import('./modelAdapter.js').ModelAdapter} options.adapter
   * @param {import('../classes/toolRegistry.js').ToolRegistry} options.toolRegistry
   * @param {string} options.systemInstruction
   * @param {import('./historyStore.js').InMemoryHistoryStore|{ get: Function, append: Function }} [options.history]
   * @param {number} [options.maxToolRounds]
   * @param {string[]} [options.excludeTools]
   * @param {string[]} [options.toolAllowlist] - When set, only these tool names are available
   * @param {boolean} [options.requireUser]
   * @param {'full'|'omit'|'digest'} [options.historyToolTurns='full'] - What tool-loop parts to store in history
   * @param {(toolName: string, args: object, result: unknown) => object} [options.historyToolDigest] - Required when historyToolTurns is digest
   * @param {import('pino').Logger} [options.logger]
   * @param {import('../classes/hookRegistry.js').HookRegistry|null} [options.hookRegistry]
   * @param {string} [options.permissionMode='default']
   * @param {import('../telemetry/telemetryEngine.js').TelemetryEngine|null} [options.telemetryEngine]
   */
  constructor (options) {
    if (!options || !options.adapter) {
      throw new Error('adapter is required');
    }
    if (!options.toolRegistry) {
      throw new Error('toolRegistry is required');
    }
    if (typeof options.systemInstruction !== 'string' || !options.systemInstruction.trim()) {
      throw new Error('systemInstruction is required');
    }

    const maxToolRounds = options.maxToolRounds;
    if (typeof maxToolRounds !== 'number' || !Number.isInteger(maxToolRounds) || maxToolRounds < 1) {
      throw new Error(`Invalid maxToolRounds: ${maxToolRounds}`);
    }

    const historyToolTurns = options.historyToolTurns === undefined
      ? 'full'
      : options.historyToolTurns;
    if (!HISTORY_TOOL_TURNS.has(historyToolTurns)) {
      throw new Error(`Invalid historyToolTurns: ${historyToolTurns}`);
    }

    let historyToolDigest = null;
    if (historyToolTurns === 'digest') {
      if (typeof options.historyToolDigest !== 'function') {
        throw new Error('historyToolDigest is required when historyToolTurns is digest');
      }
      historyToolDigest = options.historyToolDigest;
    } else if (options.historyToolDigest !== undefined) {
      throw new Error('historyToolDigest is only valid when historyToolTurns is digest');
    }

    this.adapter = options.adapter;
    this.toolRegistry = options.toolRegistry;
    this.systemInstruction = options.systemInstruction;
    this.history = options.history;
    this.maxToolRounds = maxToolRounds;
    this.historyToolTurns = historyToolTurns;
    this.historyToolDigest = historyToolDigest;
    this.excludeTools = new Set(options.excludeTools || []);
    this.toolAllowlist = Array.isArray(options.toolAllowlist)
      ? new Set(options.toolAllowlist)
      : null;
    this.requireUser = options.requireUser === true;
    this.logger = options.logger;
    this.hookRegistry = options.hookRegistry || this.toolRegistry?.hookRegistry || null;
    if (this.hookRegistry && this.toolRegistry) {
      this.toolRegistry.hookRegistry = this.hookRegistry;
    }
    this.permissionMode = options.permissionMode ?? 'default';
    /** @type {import('../telemetry/telemetryEngine.js').TelemetryEngine|null} */
    this.telemetryEngine = options.telemetryEngine ?? null;
    /** @type {Set<string>} historyKeys that have already fired SessionStart */
    this._sessionStartKeys = new Set();
  }

  /**
   * @param {string} toolName
   * @returns {boolean}
   * @private
   */
  _isToolAvailable (toolName) {
    if (toolName === REQUEST_TOOLS_NAME) {
      return true;
    }
    if (this.excludeTools.has(toolName)) {
      return false;
    }
    if (this.toolAllowlist && !this.toolAllowlist.has(toolName)) {
      return false;
    }
    return true;
  }

  /**
   * @param {string[]} [toolNames]
   * @returns {Array<Object>}
   */
  buildToolDeclarations (toolNames) {
    let tools = this.toolRegistry.getTools()
      .filter((tool) => this._isToolAvailable(tool.name));

    if (toolNames !== undefined) {
      if (!Array.isArray(toolNames)) {
        throw new Error('toolNames must be an array of tool names when provided');
      }
      const nameSet = new Set(toolNames);
      for (const name of toolNames) {
        if (typeof name !== 'string' || name.length === 0) {
          throw new Error('toolNames entries must be non-empty strings');
        }
        if (!this._isToolAvailable(name)) {
          throw new Error(`Tool is not available to the agent: ${name}`);
        }
        const registered = this.toolRegistry.getTools().some((tool) => tool.name === name);
        if (!registered) {
          throw new Error(`Tool is not registered: ${name}`);
        }
      }
      tools = tools.filter((tool) => nameSet.has(tool.name));
    }

    return tools.map((tool) => canonicalizeValue({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    }));
  }

  /**
   * @param {number} round
   * @param {number} historyTurns
   * @param {Array<object>} contents
   * @param {Array<object>} toolDeclarations
   * @param {string} systemInstruction
   * @returns {object}
   * @private
   */
  _logGenerateRequest (round, historyTurns, contents, toolDeclarations, systemInstruction) {
    const sizes = buildGenerateSizes(contents, systemInstruction, toolDeclarations);
    this.logger?.trace?.(
      {
        round,
        historyTurns,
        contents,
        systemInstruction,
        toolDeclarations,
        sizes,
      },
      'Agent model generate request',
    );
    return sizes;
  }

  /**
   * Run adapter.generate wrapped in an LLM span; accumulate token totals.
   * Fail-open: telemetry errors never interrupt generation.
   *
   * @param {Object} params
   * @param {Array<object>} params.contents
   * @param {string} params.systemInstruction
   * @param {Array<object>} params.toolDeclarations
   * @param {import('../telemetry/telemetryEngine.js').ActiveSpan|null} params.agentSpan
   * @param {string|null} params.traceparent
   * @param {string} params.sessionId
   * @param {number} params.round
   * @param {{ promptTokens: number, completionTokens: number, totalTokens: number }} params.tokenTotals
   * @returns {Promise<object>}
   * @private
   */
  async _generateWithTelemetry ({
    contents,
    systemInstruction,
    toolDeclarations,
    agentSpan,
    traceparent,
    sessionId,
    round,
    tokenTotals,
  }) {
    /** @type {import('../telemetry/telemetryEngine.js').ActiveSpan|null} */
    let llmSpan = null;
    if (this.telemetryEngine && agentSpan) {
      try {
        llmSpan = this.telemetryEngine.startLlmSpan({
          traceparent,
          genAiSystem: this.adapter instanceof GeminiAdapter ? 'gemini' : 'custom',
          model: typeof this.adapter.model === 'string' ? this.adapter.model : undefined,
          round,
          sessionId,
        });
      } catch {
        llmSpan = null;
      }
    }

    try {
      const response = await this.adapter.generate({
        contents,
        systemInstruction,
        toolDeclarations,
      });

      if (response?.usage && typeof response.usage === 'object') {
        if (typeof response.usage.promptTokens === 'number') {
          tokenTotals.promptTokens += response.usage.promptTokens;
        }
        if (typeof response.usage.completionTokens === 'number') {
          tokenTotals.completionTokens += response.usage.completionTokens;
        }
        if (typeof response.usage.totalTokens === 'number') {
          tokenTotals.totalTokens += response.usage.totalTokens;
        }
      }

      if (llmSpan && this.telemetryEngine) {
        try {
          let output;
          if (Array.isArray(response.functionCalls) && response.functionCalls.length > 0) {
            output = {
              functionCalls: response.functionCalls.map((fc) => ({
                name: fc.name,
                args: fc.args,
              })),
            };
          } else if (typeof response.text === 'string') {
            output = response.text;
          }
          this.telemetryEngine.endLlmSpan(llmSpan, {
            usage: response.usage,
            thought: response.thought,
            output,
          });
        } catch {
          // Telemetry must never affect agent execution
        }
      }

      return response;
    } catch (err) {
      if (llmSpan && this.telemetryEngine) {
        try {
          this.telemetryEngine.endLlmSpan(llmSpan, {
            error: err instanceof Error ? err : new Error(String(err)),
          });
        } catch {
          // Telemetry must never affect agent execution
        }
      }
      throw err;
    }
  }

  /**
   * @param {{
   *   toolNames?: string[],
   *   systemInstruction?: string,
   *   escalation?: { toolNames: string[], systemInstruction: string },
   * }} options
   * @returns {{
   *   activeToolNames: string[]|undefined,
   *   activeSystemInstruction: string,
   *   escalation: { toolNames: string[], systemInstruction: string }|null,
   * }}
   * @private
   */
  _resolveTurnOptions (options) {
    let activeSystemInstruction = this.systemInstruction;
    if (options.systemInstruction !== undefined) {
      if (typeof options.systemInstruction !== 'string' || !options.systemInstruction.trim()) {
        throw new Error('systemInstruction must be a non-empty string when provided');
      }
      activeSystemInstruction = options.systemInstruction;
    }

    let activeToolNames;
    if (options.toolNames !== undefined) {
      if (!Array.isArray(options.toolNames)) {
        throw new Error('toolNames must be an array of tool names when provided');
      }
      activeToolNames = options.toolNames;
      // Validate early via buildToolDeclarations
      this.buildToolDeclarations(activeToolNames);
    }

    let escalation = null;
    if (options.escalation !== undefined) {
      if (activeToolNames === undefined) {
        throw new Error('escalation requires toolNames');
      }
      if (!options.escalation || typeof options.escalation !== 'object' || Array.isArray(options.escalation)) {
        throw new Error('escalation must be a plain object when provided');
      }
      if (!Array.isArray(options.escalation.toolNames)) {
        throw new Error('escalation.toolNames must be an array of tool names');
      }
      if (typeof options.escalation.systemInstruction !== 'string' ||
        !options.escalation.systemInstruction.trim()) {
        throw new Error('escalation.systemInstruction must be a non-empty string');
      }
      this.buildToolDeclarations(options.escalation.toolNames);
      const escalationSet = new Set(options.escalation.toolNames);
      for (const name of activeToolNames) {
        if (!escalationSet.has(name)) {
          throw new Error(
            `escalation.toolNames must be a superset of toolNames; missing ${name}`,
          );
        }
      }
      escalation = {
        toolNames: options.escalation.toolNames,
        systemInstruction: options.escalation.systemInstruction,
      };
    }

    return { activeToolNames, activeSystemInstruction, escalation };
  }

  /**
   * @param {string[]|undefined} toolNames
   * @param {boolean} includeRequestTools
   * @returns {Array<object>}
   * @private
   */
  _declarationsForTurn (toolNames, includeRequestTools) {
    const declarations = this.buildToolDeclarations(toolNames);
    if (includeRequestTools) {
      declarations.push(canonicalizeValue(REQUEST_TOOLS_DECLARATION));
    }
    return declarations;
  }

  /**
   * @param {string} historyKey
   * @param {string} text
   * @param {{
   *   user?: Object|null,
   *   hostContext?: Record<string, string>|null,
   *   ephemeralPrefix?: string,
   *   toolNames?: string[],
   *   systemInstruction?: string,
   *   escalation?: { toolNames: string[], systemInstruction: string },
   *   appendHistory?: boolean,
   *   historyUserText?: string,
   * }} [options]
   * @returns {Promise<string>}
   */
  async processMessage (historyKey, text, options = {}) {
    if (typeof historyKey !== 'string' || !historyKey) {
      throw new Error('historyKey is required');
    }
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('text is required');
    }

    const user = options.user ?? null;
    const hostContext = options.hostContext ?? null;
    if (this.requireUser && !user) {
      throw new Error('Agent requires an authenticated user but none was provided.');
    }
    if (hostContext !== null && (typeof hostContext !== 'object' || Array.isArray(hostContext))) {
      throw new Error('hostContext must be a plain object when provided');
    }
    if (options.appendHistory !== undefined && typeof options.appendHistory !== 'boolean') {
      throw new Error('appendHistory must be a boolean when provided');
    }
    const appendHistory = options.appendHistory !== false;
    const historyUserTextExplicit = options.historyUserText !== undefined;
    const hookContext = {
      user,
      hostContext,
      logger: this.logger,
    };
    const permissionMode = options.permissionMode ?? this.permissionMode;

    /** @type {import('../telemetry/telemetryEngine.js').ActiveSpan|null} */
    let agentSpan = null;
    if (this.telemetryEngine) {
      try {
        agentSpan = this.telemetryEngine.startAgentSpan({
          prompt: text,
          genAiSystem: this.adapter instanceof GeminiAdapter ? 'gemini' : 'custom',
          traceparent: options.meta?.traceparent ?? null,
          sessionId: historyKey,
          user,
        });
      } catch {
        agentSpan = null;
      }
    }
    let traceparent = agentSpan?.traceparent ?? options.meta?.traceparent ?? null;
    /** @type {string|undefined} */
    let finalReply;
    let telemetryRounds = 0;
    /** @type {Error|null} */
    let telemetryError = null;
    const tokenTotals = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let selfCorrections = 0;

    try {
    let promptText = text;
    const contextPrefixes = [];

    const priorHistory = this.history ? this.history.get(historyKey) : [];

    const isNewSession = priorHistory.length === 0 && !this._sessionStartKeys.has(historyKey);
    if (this.hookRegistry && isNewSession) {
      const sessionStart = await this.hookRegistry.runHooks(
        'SessionStart',
        {
          session_id: historyKey,
          permission_mode: permissionMode,
          meta: { traceparent, turn_index: 0 },
        },
        hookContext,
      );
      this._sessionStartKeys.add(historyKey);
      if (sessionStart.additionalContext) {
        contextPrefixes.push(sessionStart.additionalContext);
      }
    }

    if (this.hookRegistry) {
      const promptResult = await this.hookRegistry.runHooks(
        'UserPromptSubmit',
        {
          session_id: historyKey,
          permission_mode: permissionMode,
          user_prompt: promptText,
          meta: { traceparent, turn_index: 0 },
        },
        hookContext,
      );
      if (promptResult.blocked) {
        throw new HookBlockedError(promptResult.stderr || 'Prompt blocked by hook', {
          hookEvent: promptResult.hookEvent,
          exitCode: promptResult.exitCode ?? HOOK_EXIT_CODES.BLOCKING_ERROR,
          stderr: promptResult.stderr,
          additionalContext: promptResult.additionalContext,
          userMessage: promptResult.userMessages?.[0] ?? null,
        });
      }
      if (promptResult.decision === 'modify' && promptResult.updatedInput !== undefined) {
        promptText = typeof promptResult.updatedInput === 'string'
          ? promptResult.updatedInput
          : promptResult.updatedInput?.user_prompt ?? promptText;
      }
      if (promptResult.additionalContext) {
        contextPrefixes.push(promptResult.additionalContext);
      }
    }

    let historyUserText = promptText;
    if (historyUserTextExplicit) {
      if (typeof options.historyUserText !== 'string' || !options.historyUserText.trim()) {
        throw new Error('historyUserText must be a non-empty string when provided');
      }
      historyUserText = options.historyUserText;
    }

    let modelUserText = promptText;
    if (options.ephemeralPrefix !== undefined) {
      if (typeof options.ephemeralPrefix !== 'string' || options.ephemeralPrefix.length === 0) {
        throw new Error('ephemeralPrefix must be a non-empty string when provided');
      }
      modelUserText = `${options.ephemeralPrefix}${promptText}`;
    }
    if (contextPrefixes.length > 0) {
      modelUserText = `${contextPrefixes.join('\n')}\n${modelUserText}`;
    }

    const {
      activeToolNames: initialToolNames,
      activeSystemInstruction: initialSystemInstruction,
      escalation,
    } = this._resolveTurnOptions(options);

    let activeToolNames = initialToolNames;
    let activeSystemInstruction = initialSystemInstruction;
    let escalated = false;
    let escalationBudget = 0;

    const historyTurns = priorHistory.length;
    const turnContents = [
      { role: 'user', parts: [{ text: modelUserText }] },
    ];

    let toolDeclarations = this._declarationsForTurn(activeToolNames, escalation !== null);
    let generateContents = ensureUserLeadingContents([...priorHistory, ...turnContents]);
    let lastSizes = this._logGenerateRequest(
      0,
      historyTurns,
      generateContents,
      toolDeclarations,
      activeSystemInstruction,
    );
    let response = await this._generateWithTelemetry({
      contents: generateContents,
      systemInstruction: activeSystemInstruction,
      toolDeclarations,
      agentSpan,
      traceparent,
      sessionId: historyKey,
      round: 0,
      tokenTotals,
    });

    let toolCalls = 0;
    let errorCalls = 0;
    let rounds = 0;
    const maxRounds = this.maxToolRounds;
    /** @type {Array<object>} */
    const toolDigests = [];

    // Unified loop: tool rounds, Stop quality gate, and Stop self-correction.
    // Budget is maxToolRounds (+ optional escalation). Stop only runs when there
    // are no pending function calls; pending calls at budget exhaustion skip Stop.
    while (true) {
      const functionCalls = response.functionCalls;
      const hasFunctionCalls = Array.isArray(functionCalls) && functionCalls.length > 0;

      if (hasFunctionCalls) {
        if (rounds >= maxRounds + escalationBudget) {
          break;
        }

        const round = rounds;
        rounds += 1;
        turnContents.push({ role: 'model', parts: modelPartsForEcho(response) });

        const responseParts = [];
        let escalatedThisRound = false;

        for (const fc of functionCalls) {
          if (!fc.name) {
            throw new Error('Model function call missing name');
          }

          if (fc.name === REQUEST_TOOLS_NAME) {
            if (!escalation) {
              throw new Error('request_tools is not available without escalation');
            }
            if (escalated) {
              throw new Error('request_tools may only be called once per turn');
            }
            const reason = fc.args && typeof fc.args.reason === 'string' ? fc.args.reason : '';
            if (!reason.trim()) {
              throw new Error('request_tools requires a non-empty reason');
            }
            const fromTools = activeToolNames ? [...activeToolNames] : [];
            const toTools = [...escalation.toolNames];
            this.logger?.info?.(
              {
                round,
                reason,
                from: fromTools,
                to: toTools,
              },
              'Agent tool set escalated',
            );
            activeToolNames = escalation.toolNames;
            activeSystemInstruction = escalation.systemInstruction;
            escalated = true;
            escalatedThisRound = true;
            escalationBudget = 1;
            toolDeclarations = this._declarationsForTurn(activeToolNames, false);
            if (this.telemetryEngine && agentSpan) {
              try {
                this.telemetryEngine.recordEscalation(agentSpan, {
                  reason,
                  grantedTools: toTools,
                  round,
                  sessionId: historyKey,
                });
              } catch {
                // Telemetry must never affect agent execution
              }
            }
            responseParts.push({
              functionResponse: {
                name: REQUEST_TOOLS_NAME,
                response: { ok: true, tools: toTools },
              },
            });
            continue;
          }

          if (!this._isToolAvailable(fc.name)) {
            throw new Error(`Tool is not available to the agent: ${fc.name}`);
          }
          if (activeToolNames !== undefined && !activeToolNames.includes(fc.name)) {
            throw new Error(`Tool is not available to the agent: ${fc.name}`);
          }

          const args = fc.args || {};
          const argKeys = Object.keys(args).sort();
          const execution = await this.toolRegistry.executeTool(
            fc.name,
            args,
            {
              execution: new ToolExecution(fc.name, null, args),
              user,
              hostContext,
              sessionId: historyKey,
              permissionMode,
              meta: { traceparent, turn_index: round },
            },
          );

          toolCalls += 1;
          if (execution.status === 'error') {
            errorCalls += 1;
            const errorData = execution.getErrorData();
            const errorMessage = errorData.error || `Tool ${fc.name} failed`;
            this.logger?.info?.(
              {
                round,
                toolName: fc.name,
                status: 'error',
                argKeys,
                error: errorMessage,
              },
              'Agent tool call completed',
            );
            if (this.historyToolTurns === 'digest') {
              toolDigests.push({
                tool: fc.name,
                ok: false,
                error: truncateDigestError(errorMessage),
              });
            }
            const errorResponse = { ok: false, error: errorMessage };
            if (execution.hookAdditionalContext) {
              errorResponse.additionalContext = execution.hookAdditionalContext;
            } else if (errorData.errorData?.additionalContext) {
              errorResponse.additionalContext = errorData.errorData.additionalContext;
            }
            responseParts.push({
              functionResponse: {
                name: fc.name,
                response: errorResponse,
              },
            });
            continue;
          }

          this.logger?.info?.(
            {
              round,
              toolName: fc.name,
              status: 'success',
              argKeys,
            },
            'Agent tool call completed',
          );
          if (this.historyToolTurns === 'digest') {
            const digest = this.historyToolDigest(fc.name, args, execution.result);
            if (
              digest === null
              || typeof digest !== 'object'
              || Array.isArray(digest)
            ) {
              throw new Error('historyToolDigest must return a plain object');
            }
            toolDigests.push({ tool: fc.name, ...digest });
          }
          const successResponse = { result: execution.result };
          if (execution.hookAdditionalContext) {
            successResponse.additionalContext = execution.hookAdditionalContext;
          }
          responseParts.push({
            functionResponse: {
              name: fc.name,
              response: successResponse,
            },
          });
        }
        turnContents.push({ role: 'user', parts: responseParts });

        // Escalation-only rounds do not consume maxToolRounds budget beyond the +1.
        if (escalatedThisRound && functionCalls.every((fc) => fc.name === REQUEST_TOOLS_NAME)) {
          // no-op; budget already increased
        }

        generateContents = ensureUserLeadingContents([...priorHistory, ...turnContents]);
        lastSizes = this._logGenerateRequest(
          rounds,
          historyTurns,
          generateContents,
          toolDeclarations,
          activeSystemInstruction,
        );
        response = await this._generateWithTelemetry({
          contents: generateContents,
          systemInstruction: activeSystemInstruction,
          toolDeclarations,
          agentSpan,
          traceparent,
          sessionId: historyKey,
          round: rounds,
          tokenTotals,
        });
        continue;
      }

      // No function calls — candidate final reply (Stop quality gate).
      const replyText = response.text;
      if (typeof replyText !== 'string' || !replyText.trim()) {
        throw new Error('Model returned empty response');
      }

      if (this.hookRegistry) {
        const stopResult = await this.hookRegistry.runHooks(
          'Stop',
          {
            session_id: historyKey,
            permission_mode: permissionMode,
            meta: { traceparent, turn_index: rounds },
            total_turn_count: rounds + 1,
            exit_reason: 'stop',
            tool_result: replyText,
          },
          hookContext,
        );
        if (stopResult.blocked) {
          if (rounds < maxRounds + escalationBudget) {
            turnContents.push({ role: 'model', parts: [{ text: replyText }] });
            const correctionParts = [];
            if (stopResult.stderr) {
              correctionParts.push(stopResult.stderr);
            }
            if (stopResult.additionalContext) {
              correctionParts.push(stopResult.additionalContext);
            }
            turnContents.push({
              role: 'user',
              parts: [{
                text: correctionParts.join('\n') || 'Response rejected by Stop hook; please revise.',
              }],
            });
            selfCorrections += 1;
            if (agentSpan) {
              agentSpan.attributes['agent.self_corrections'] = selfCorrections;
            }
            rounds += 1;
            generateContents = ensureUserLeadingContents([...priorHistory, ...turnContents]);
            lastSizes = this._logGenerateRequest(
              rounds,
              historyTurns,
              generateContents,
              toolDeclarations,
              activeSystemInstruction,
            );
            response = await this._generateWithTelemetry({
              contents: generateContents,
              systemInstruction: activeSystemInstruction,
              toolDeclarations,
              agentSpan,
              traceparent,
              sessionId: historyKey,
              round: rounds,
              tokenTotals,
            });
            continue;
          }
          throw new HookBlockedError(stopResult.stderr || 'Stop hook blocked final reply', {
            hookEvent: stopResult.hookEvent,
            exitCode: stopResult.exitCode ?? HOOK_EXIT_CODES.BLOCKING_ERROR,
            stderr: stopResult.stderr,
            additionalContext: stopResult.additionalContext,
            userMessage: stopResult.userMessages?.[0] ?? null,
          });
        }
      }

      turnContents.push({ role: 'model', parts: [{ text: replyText }] });
      if (appendHistory && this.history) {
        this.history.append(
          historyKey,
          contentsForHistory(turnContents, historyUserText, this.historyToolTurns, {
            toolDigests,
          }),
        );
      }

      this.logger?.info?.(
        {
          rounds,
          toolCalls,
          errorCalls,
          historyTurns,
          toolCount: lastSizes.toolCount,
          escalated,
          appendHistory,
          contentsChars: lastSizes.contentsChars,
          systemInstructionChars: lastSizes.systemInstructionChars,
          toolDeclarationChars: lastSizes.toolDeclarationChars,
        },
        'Agent processMessage completed',
      );

      telemetryRounds = rounds;
      finalReply = replyText;
      return replyText;
    }

    // Exhausted tool-round budget with pending function calls — do not run Stop.
    const exhaustedReply = response.text;
    if (typeof exhaustedReply !== 'string' || !exhaustedReply.trim()) {
      throw new Error('Model returned empty response');
    }
    turnContents.push({ role: 'model', parts: [{ text: exhaustedReply }] });
    if (appendHistory && this.history) {
      this.history.append(
        historyKey,
        contentsForHistory(turnContents, historyUserText, this.historyToolTurns, {
          toolDigests,
        }),
      );
    }
    this.logger?.info?.(
      {
        rounds,
        toolCalls,
        errorCalls,
        historyTurns,
        toolCount: lastSizes.toolCount,
        escalated,
        appendHistory,
        contentsChars: lastSizes.contentsChars,
        systemInstructionChars: lastSizes.systemInstructionChars,
        toolDeclarationChars: lastSizes.toolDeclarationChars,
      },
      'Agent processMessage completed',
    );
    telemetryRounds = rounds;
    finalReply = exhaustedReply;
    return exhaustedReply;
    } catch (err) {
      telemetryError = err instanceof Error ? err : new Error(String(err));
      throw err;
    } finally {
      if (agentSpan && this.telemetryEngine) {
        try {
          /** @type {Object} */
          const endResult = {
            output: finalReply,
            rounds: telemetryRounds,
            error: telemetryError,
            selfCorrections,
          };
          if (tokenTotals.promptTokens > 0) {
            endResult.promptTokens = tokenTotals.promptTokens;
          }
          if (tokenTotals.completionTokens > 0) {
            endResult.completionTokens = tokenTotals.completionTokens;
          }
          if (tokenTotals.totalTokens > 0) {
            endResult.totalTokens = tokenTotals.totalTokens;
          }
          this.telemetryEngine.endAgentSpan(agentSpan, endResult);
        } catch {
          // Telemetry must never affect agent execution
        }
      }
    }
  }

  /**
   * Append a model turn without calling the LLM (host-initiated agent speech).
   * Requires a history store. Used by hosts that send proactive messages
   * (reminders, notifications) so the next processMessage sees them.
   *
   * @param {string} historyKey
   * @param {string} text
   * @returns {Promise<void>}
   */
  async recordAssistantMessage (historyKey, text) {
    if (typeof historyKey !== 'string' || !historyKey) {
      throw new Error('historyKey is required');
    }
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('text is required');
    }
    if (!this.history) {
      throw new Error('history store is required to record assistant messages');
    }
    this.history.append(historyKey, [
      { role: 'model', parts: [{ text }] },
    ]);
  }

  /**
   * Clear stored history (for tests).
   * @param {string} [historyKey]
   */
  clearHistory (historyKey) {
    if (historyKey === undefined) {
      this._sessionStartKeys.clear();
    } else if (typeof historyKey === 'string' && historyKey) {
      this._sessionStartKeys.delete(historyKey);
    }
    if (!this.history || typeof this.history.clear !== 'function') {
      return;
    }
    this.history.clear(historyKey);
  }
}
