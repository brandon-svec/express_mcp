import { ToolExecution } from '../classes/toolExecution.js';

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

    this.adapter = options.adapter;
    this.toolRegistry = options.toolRegistry;
    this.systemInstruction = options.systemInstruction;
    this.history = options.history;
    this.maxToolRounds = maxToolRounds;
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
    if (this.excludeTools.has(toolName)) {
      return false;
    }
    if (this.toolAllowlist && !this.toolAllowlist.has(toolName)) {
      return false;
    }
    return true;
  }

  /**
   * @returns {Array<Object>}
   */
  buildToolDeclarations () {
    return this.toolRegistry.getTools()
      .filter((tool) => this._isToolAvailable(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      }));
  }

  /**
   * @param {string} historyKey
   * @param {string} text
   * @param {{ user?: Object|null, hostContext?: Record<string, string>|null }} [options]
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

    const priorHistory = this.history ? this.history.get(historyKey) : [];
    const turnContents = [
      { role: 'user', parts: [{ text }] },
    ];

    const toolDeclarations = this.buildToolDeclarations();
    let response = await this.adapter.generate({
      contents: ensureUserLeadingContents([...priorHistory, ...turnContents]),
      systemInstruction: this.systemInstruction,
      toolDeclarations,
    });

    for (let round = 0; round < this.maxToolRounds; round += 1) {
      const functionCalls = response.functionCalls;
      if (!functionCalls || functionCalls.length === 0) {
        break;
      }

      turnContents.push({ role: 'model', parts: modelPartsForEcho(response) });

      const responseParts = [];
      for (const fc of functionCalls) {
        if (!fc.name) {
          throw new Error('Model function call missing name');
        }
        if (!this._isToolAvailable(fc.name)) {
          throw new Error(`Tool is not available to the agent: ${fc.name}`);
        }
        const execution = await this.toolRegistry.executeTool(
          fc.name,
          fc.args || {},
          {
            execution: new ToolExecution(fc.name, null, fc.args || {}),
            user,
            hostContext,
          },
        );

        if (execution.status === 'error') {
          const errorData = execution.getErrorData();
          throw new Error(errorData.error || `Tool ${fc.name} failed`);
        }

        responseParts.push({
          functionResponse: {
            name: fc.name,
            response: { result: execution.result },
          },
        });
      }
      turnContents.push({ role: 'user', parts: responseParts });

      response = await this.adapter.generate({
        contents: ensureUserLeadingContents([...priorHistory, ...turnContents]),
        systemInstruction: this.systemInstruction,
        toolDeclarations,
      });
    }

    const replyText = response.text;
    if (typeof replyText !== 'string' || !replyText.trim()) {
      throw new Error('Model returned empty response');
    }

    turnContents.push({ role: 'model', parts: [{ text: replyText }] });
    if (this.history) {
      this.history.append(historyKey, turnContents);
    }

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
