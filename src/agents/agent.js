import { ToolExecution } from '../classes/toolExecution.js';

const HISTORY_TOOL_TURNS = new Set(['full', 'omit']);

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
 * @param {'full'|'omit'} historyToolTurns
 * @returns {Array<object>}
 */
function contentsForHistory (turnContents, userText, historyToolTurns) {
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
   * @param {'full'|'omit'} [options.historyToolTurns='full'] - What tool-loop parts to store in history
   * @param {import('pino').Logger} [options.logger]
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

    this.adapter = options.adapter;
    this.toolRegistry = options.toolRegistry;
    this.systemInstruction = options.systemInstruction;
    this.history = options.history;
    this.maxToolRounds = maxToolRounds;
    this.historyToolTurns = historyToolTurns;
    this.excludeTools = new Set(options.excludeTools || []);
    this.toolAllowlist = Array.isArray(options.toolAllowlist)
      ? new Set(options.toolAllowlist)
      : null;
    this.requireUser = options.requireUser === true;
    this.logger = options.logger;
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

    let modelUserText = text;
    if (options.ephemeralPrefix !== undefined) {
      if (typeof options.ephemeralPrefix !== 'string' || options.ephemeralPrefix.length === 0) {
        throw new Error('ephemeralPrefix must be a non-empty string when provided');
      }
      modelUserText = `${options.ephemeralPrefix}${text}`;
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

    const priorHistory = this.history ? this.history.get(historyKey) : [];
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
    let response = await this.adapter.generate({
      contents: generateContents,
      systemInstruction: activeSystemInstruction,
      toolDeclarations,
    });

    let toolCalls = 0;
    let errorCalls = 0;
    let rounds = 0;
    const maxRounds = this.maxToolRounds;

    for (let round = 0; round < maxRounds + escalationBudget; round += 1) {
      const functionCalls = response.functionCalls;
      if (!functionCalls || functionCalls.length === 0) {
        break;
      }

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
          responseParts.push({
            functionResponse: {
              name: fc.name,
              response: { ok: false, error: errorMessage },
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
        responseParts.push({
          functionResponse: {
            name: fc.name,
            response: { result: execution.result },
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
      response = await this.adapter.generate({
        contents: generateContents,
        systemInstruction: activeSystemInstruction,
        toolDeclarations,
      });
    }

    const replyText = response.text;
    if (typeof replyText !== 'string' || !replyText.trim()) {
      throw new Error('Model returned empty response');
    }

    turnContents.push({ role: 'model', parts: [{ text: replyText }] });
    if (this.history) {
      this.history.append(
        historyKey,
        contentsForHistory(turnContents, text, this.historyToolTurns),
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
        contentsChars: lastSizes.contentsChars,
        systemInstructionChars: lastSizes.systemInstructionChars,
        toolDeclarationChars: lastSizes.toolDeclarationChars,
      },
      'Agent processMessage completed',
    );

    return replyText;
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
    if (!this.history || typeof this.history.clear !== 'function') {
      return;
    }
    this.history.clear(historyKey);
  }
}
