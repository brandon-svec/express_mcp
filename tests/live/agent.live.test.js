/**
 * Live tests for Agent — real Gemini API + in-process tool loop.
 *
 * Requires tests/live/config.js — see tests/live/README.md
 * Run: npm run test:live
 */

import { strict as assert } from 'assert';
import { Agent } from '../../src/agents/agent.js';
import { GeminiAdapter } from '../../src/agents/geminiAdapter.js';
import { InMemoryHistoryStore } from '../../src/agents/historyStore.js';
import { ToolRegistry } from '../../src/classes/toolRegistry.js';
import { BaseTool } from '../../src/classes/baseTool.js';
import { loadLiveGeminiConfig } from './liveConfig.js';

const liveConfig = await loadLiveGeminiConfig();

class EchoTool extends BaseTool {
  constructor () {
    super('echo', 'Echo the message back in the result.', {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Text to echo' },
      },
      required: ['message'],
      additionalProperties: false,
    });
    this.executeCalls = [];
  }

  async execute (args) {
    this.executeCalls.push(args);
    return { echoed: args.message };
  }
}

/**
 * @param {string} model
 * @returns {{ agent: Agent, echoTool: EchoTool }}
 */
function createLiveAgent (model) {
  const echoTool = new EchoTool();
  const registry = new ToolRegistry({ loggerOptions: { enabled: false } });
  registry.register(echoTool);

  const adapter = new GeminiAdapter({
    apiKey: liveConfig.apiKey,
    model,
  });

  const agent = new Agent({
    adapter,
    toolRegistry: registry,
    systemInstruction: [
      'You are a test assistant.',
      'When asked to echo text, you must call the echo tool with that message.',
      'After receiving tool results, reply briefly with what was echoed.',
    ].join(' '),
    history: new InMemoryHistoryStore({ windowMinutes: 60 }),
    maxToolRounds: 8,
  });

  return { agent, echoTool };
}

const ECHO_PROMPT = 'Use the echo tool to echo the message "live-echo-check". Then confirm what was echoed.';

describe('Agent live', function () {
  this.timeout(60000);

  it('processMessage returns text for a trivial prompt', async () => {
    const { agent } = createLiveAgent(liveConfig.model);
    const reply = await agent.processMessage('live:trivial', 'Say hello in one short sentence.');

    assert.strictEqual(typeof reply, 'string');
    assert.notStrictEqual(reply.trim(), '');
  });

  it('processMessage calls registered EchoTool when instructed', async () => {
    const { agent, echoTool } = createLiveAgent(liveConfig.model);
    const reply = await agent.processMessage('live:echo', ECHO_PROMPT);

    assert.strictEqual(echoTool.executeCalls.length > 0, true);
    assert.strictEqual(typeof reply, 'string');
    assert.notStrictEqual(reply.trim(), '');
    assert.match(reply.toLowerCase(), /live-echo-check|echoed/);
  });

  it('processMessage completes a tool round trip on Gemini 3', async () => {
    const { agent, echoTool } = createLiveAgent(liveConfig.gemini3Model);
    const reply = await agent.processMessage('live:echo-gemini3', ECHO_PROMPT);

    assert.strictEqual(echoTool.executeCalls.length > 0, true);
    assert.strictEqual(typeof reply, 'string');
    assert.notStrictEqual(reply.trim(), '');
  });
});
