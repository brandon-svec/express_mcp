import { randomUUID } from 'crypto';
import { BaseTool } from '../classes/baseTool.js';
import { canonicalizeValue } from '../agents/agent.js';

const DEFAULT_DESCRIPTION =
  'Ask the agent a question; it can use registered tools and the knowledge base to answer.';

const MAX_CONVERSATION_ID_LENGTH = 128;

/**
 * @param {string} value
 * @returns {boolean}
 */
function hasControlCharacters (value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * MCP tool that runs an agent question against the host tool registry.
 * Supports multi-turn continuity via conversation_id and ephemeral caller context.
 */
export class AgentTool extends BaseTool {
  /**
   * @param {import('../agents/agent.js').Agent} agent
   * @param {{
   *   description?: string,
   *   serviceDescription?: string,
   *   knowledgeBase?: import('../classes/knowledgeBase.js').KnowledgeBase|null,
   *   getPlaybooksManifest?: () => Array<{ uri?: string, title?: string }>,
   * }} [options]
   */
  constructor (agent, options = {}) {
    const baseDescription = typeof options.description === 'string' && options.description.trim()
      ? options.description.trim()
      : DEFAULT_DESCRIPTION;

    super(
      'agent_ask',
      baseDescription,
      {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Natural-language question, goal, or instruction.',
          },
          conversation_id: {
            type: 'string',
            description: 'Opaque conversation identifier for multi-turn continuity across calls.',
          },
          context: {
            type: 'object',
            description: 'Structured JSON key-value context from the calling agent (this turn only; not stored in history).',
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
    this.baseDescription = baseDescription;
    this.serviceDescription = typeof options.serviceDescription === 'string'
      ? options.serviceDescription
      : null;
    this.knowledgeBase = options.knowledgeBase ?? null;
    this.getPlaybooksManifest = typeof options.getPlaybooksManifest === 'function'
      ? options.getPlaybooksManifest
      : null;
    this.refreshDescription();
  }

  /**
   * Update the tool description from domain copy, callable tools, KB tags, and playbook counts.
   */
  refreshDescription () {
    let fullDescription = this.baseDescription;

    if (typeof this.serviceDescription === 'string' && this.serviceDescription.trim()) {
      fullDescription += `. ${this.serviceDescription.trim()}`;
    }

    const tools = this.agent.toolRegistry?.getTools?.() ?? [];
    const availableNames = tools
      .map((tool) => tool.name)
      .filter((name) => this.agent._isToolAvailable(name));
    if (availableNames.length > 0) {
      fullDescription += `. Available capabilities: ${availableNames.join(', ')}`;
    }

    if (this.knowledgeBase && typeof this.knowledgeBase.getStats === 'function') {
      const stats = this.knowledgeBase.getStats();
      if (stats.tags && stats.tags.length > 0) {
        const tagsList = stats.tags.slice(0, 10).join(', ');
        const moreTags = stats.tags.length > 10 ? ` and ${stats.tags.length - 10} more` : '';
        fullDescription += `. Knowledge base tags: ${tagsList}${moreTags}`;
      }
    }

    if (this.getPlaybooksManifest) {
      const playbooks = this.getPlaybooksManifest();
      if (Array.isArray(playbooks) && playbooks.length > 0) {
        const n = playbooks.length;
        fullDescription += `. ${n} operational playbook${n === 1 ? '' : 's'}`;
      }
    }

    this.description = fullDescription;
  }

  /**
   * @param {unknown} conversationId
   * @returns {string}
   * @private
   */
  _validateConversationId (conversationId) {
    if (typeof conversationId !== 'string') {
      throw new Error('conversation_id must be a non-empty string when provided');
    }
    const trimmed = conversationId.trim();
    if (!trimmed) {
      throw new Error('conversation_id must be a non-empty string when provided');
    }
    if (trimmed.length > MAX_CONVERSATION_ID_LENGTH) {
      throw new Error(`conversation_id must be at most ${MAX_CONVERSATION_ID_LENGTH} characters`);
    }
    if (hasControlCharacters(trimmed)) {
      throw new Error('conversation_id must not contain control characters');
    }
    return trimmed;
  }

  /**
   * @param {unknown} callerContext
   * @returns {string}
   * @private
   */
  _buildEphemeralPrefix (callerContext) {
    if (
      callerContext === null
      || typeof callerContext !== 'object'
      || Array.isArray(callerContext)
    ) {
      throw new Error('context must be a non-null plain object when provided');
    }
    if (Object.keys(callerContext).length === 0) {
      throw new Error('context must have at least one key when provided');
    }
    return `CALLER_CONTEXT:\n${JSON.stringify(canonicalizeValue(callerContext))}\n\n`;
  }

  /**
   * @inheritdoc
   */
  async execute (args, context) {
    if (typeof args.prompt !== 'string' || !args.prompt.trim()) {
      throw new Error('prompt is required and must be a non-empty string');
    }

    const conversationId = args.conversation_id !== undefined
      ? this._validateConversationId(args.conversation_id)
      : randomUUID();

    const userScope = context?.user?.sub || 'anon';
    const historyKey = `mcp:${userScope}:${conversationId}`;

    const processOptions = {
      user: context?.user ?? null,
    };
    if (context?.meta !== undefined) {
      processOptions.meta = context.meta;
    }

    if (args.context !== undefined) {
      processOptions.ephemeralPrefix = this._buildEphemeralPrefix(args.context);
      processOptions.historyUserText = args.prompt;
    }

    const reply = await this.agent.processMessage(historyKey, args.prompt, processOptions);

    return { reply, conversation_id: conversationId };
  }
}
