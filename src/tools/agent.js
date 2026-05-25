import { randomUUID } from 'crypto';
import { BaseTool } from '../classes/baseTool.js';

/**
 * MCP tool that runs a one-shot agent question against the host tool registry.
 */
export class AgentTool extends BaseTool {
  /**
   * @param {import('../agents/agent.js').Agent} agent
   */
  constructor (agent) {
    super(
      'agent_ask',
      'Ask the agent a question; it can use registered tools and the knowledge base to answer.',
      {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Natural-language question or instruction.',
          },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
    );
    if (!agent) {
      throw new Error('agent is required');
    }
    this.agent = agent;
  }

  /**
   * @inheritdoc
   */
  async execute (args, context) {
    if (typeof args.prompt !== 'string' || !args.prompt.trim()) {
      throw new Error('prompt is required and must be a non-empty string');
    }

    const historyKey = `mcp:${randomUUID()}`;
    const reply = await this.agent.processMessage(historyKey, args.prompt, {
      user: context.user ?? null,
    });

    return { reply };
  }
}
