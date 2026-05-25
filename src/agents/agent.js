import { ToolExecution } from '../classes/toolExecution.js';

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
    this.logger = options.logger;
  }

  /**
   * @returns {Array<Object>}
   */
  buildToolDeclarations () {
    return this.toolRegistry.getTools()
      .filter((tool) => !this.excludeTools.has(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      }));
  }

  /**
   * @param {string} historyKey
   * @param {string} text
   * @param {{ user?: Object|null }} [options]
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
    const priorHistory = this.history ? this.history.get(historyKey) : [];
    const turnContents = [
      { role: 'user', parts: [{ text }] },
    ];

    const toolDeclarations = this.buildToolDeclarations();
    let response = await this.adapter.generate({
      contents: [...priorHistory, ...turnContents],
      systemInstruction: this.systemInstruction,
      toolDeclarations,
    });

    for (let round = 0; round < this.maxToolRounds; round += 1) {
      const functionCalls = response.functionCalls;
      if (!functionCalls || functionCalls.length === 0) {
        break;
      }

      const modelParts = functionCalls.map((fc) => ({
        functionCall: {
          name: fc.name,
          args: fc.args,
        },
      }));
      turnContents.push({ role: 'model', parts: modelParts });

      for (const fc of functionCalls) {
        if (!fc.name) {
          throw new Error('Model function call missing name');
        }
        if (this.excludeTools.has(fc.name)) {
          throw new Error(`Tool is not available to the agent: ${fc.name}`);
        }
        const execution = await this.toolRegistry.executeTool(
          fc.name,
          fc.args || {},
          {
            execution: new ToolExecution(fc.name, null, fc.args || {}),
            user,
          },
        );

        if (execution.status === 'error') {
          const errorData = execution.getErrorData();
          throw new Error(errorData.error || `Tool ${fc.name} failed`);
        }

        turnContents.push({
          role: 'user',
          parts: [{
            functionResponse: {
              name: fc.name,
              response: { result: execution.result },
            },
          }],
        });
      }

      response = await this.adapter.generate({
        contents: [...priorHistory, ...turnContents],
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
