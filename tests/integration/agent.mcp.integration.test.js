import { strict as assert } from 'assert';
import express from 'express';
import request from 'supertest';
import { ExpressMcp } from '../../src/classes/expressMcp.js';
import { BaseTool } from '../../src/classes/baseTool.js';
import { ModelAdapter } from '../../src/agents/modelAdapter.js';
import { getTestExpressMcpOptions, createMcpSession, mcpPostWithSession } from '../config.js';

class FakeAdapter extends ModelAdapter {
  constructor (script) {
    super();
    this.script = script;
    this.callIndex = 0;
  }

  async generate () {
    const step = this.script[this.callIndex];
    this.callIndex += 1;
    if (!step) {
      throw new Error('FakeAdapter: no more scripted responses');
    }
    return step;
  }
}

class CapturingAdapter extends ModelAdapter {
  constructor () {
    super();
    this.calls = [];
  }

  async generate ({ contents }) {
    this.calls.push(contents);
    return { text: `turn-${this.calls.length}`, functionCalls: null };
  }
}

class EchoTool extends BaseTool {
  constructor () {
    super('echo', 'Echo tool', {
      type: 'object',
      properties: {
        message: { type: 'string' },
      },
      required: ['message'],
      additionalProperties: false,
    });
  }

  async execute (args) {
    return { echoed: args.message };
  }
}

const AGENT_ASK_SCHEMA = {
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
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function createAgentMcpApp (agentOptions, registerEcho = false) {
  const expressMcp = new ExpressMcp(getTestExpressMcpOptions({
    enableKnowledgeBase: false,
    agent: {
      enabled: true,
      allowUnauthenticated: true,
      systemInstruction: 'test assistant',
      maxToolRounds: 8,
      ...agentOptions,
    },
  }));

  if (registerEcho) {
    expressMcp.registerTool(new EchoTool());
  }

  const app = express();
  app.use(express.json());
  app.use('/mcp', expressMcp.router());

  const baseAgent = request(app);

  // Retry once: Streamable HTTP session init can flake under rapid app churn.
  let sessionId;
  try {
    sessionId = await createMcpSession(baseAgent);
  } catch {
    sessionId = await createMcpSession(baseAgent);
  }

  await mcpPostWithSession(baseAgent, sessionId, '/mcp').send({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });

  return {
    expressMcp,
    post: async (body) => {
      let response = await mcpPostWithSession(baseAgent, sessionId, '/mcp').send(body);
      // One immediate retry for empty 400 responses from intermittent proxy/transport races.
      if (response.status === 400 && (!response.body || Object.keys(response.body).length === 0)) {
        response = await mcpPostWithSession(baseAgent, sessionId, '/mcp').send(body);
      }
      return response;
    },
  };
}

describe('Agent MCP integration', () => {
  it('lists agent_ask with exact schema when exposeTool is true', async () => {
    const { post } = await createAgentMcpApp({
      exposeTool: true,
      adapter: new FakeAdapter([{ text: 'unused', functionCalls: null }]),
    });

    const response = await post({
      jsonrpc: '2.0',
      method: 'tools/list',
      id: 1,
    });

    assert.strictEqual(response.status, 200);
    const agentAsk = response.body.result.tools.find((tool) => tool.name === 'agent_ask');
    assert.deepStrictEqual(agentAsk, {
      name: 'agent_ask',
      description: 'Ask the agent a question; it can use registered tools and the knowledge base to answer.',
      inputSchema: AGENT_ASK_SCHEMA,
    });
  });

  it('omits agent_ask from tools/list when exposeTool is false but getAgent works', async () => {
    const { expressMcp, post } = await createAgentMcpApp({
      exposeTool: false,
      adapter: new FakeAdapter([{ text: 'ok', functionCalls: null }]),
    });

    const listResponse = await post({
      jsonrpc: '2.0',
      method: 'tools/list',
      id: 2,
    });

    const toolNames = listResponse.body.result.tools.map((tool) => tool.name);
    assert.deepStrictEqual(toolNames.includes('agent_ask'), false);

    const agent = expressMcp.getAgent();
    const reply = await agent.processMessage('prog:1', 'hello');
    assert.strictEqual(reply, 'ok');
  });

  it('tools/call agent_ask returns exact reply JSON via MCP', async () => {
    const { post } = await createAgentMcpApp({
      exposeTool: true,
      adapter: new FakeAdapter([{ text: 'agent says hi', functionCalls: null }]),
    });

    const response = await post({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'agent_ask',
        arguments: { prompt: 'hello', conversation_id: 'conv-1' },
      },
      id: 3,
    });

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(response.body, {
      jsonrpc: '2.0',
      result: {
        content: [{
          type: 'text',
          text: '{\n  "reply": "agent says hi",\n  "conversation_id": "conv-1"\n}',
        }],
      },
      id: 3,
    });
  });

  it('tools/call agent_ask runs tool loop through registered echo tool', async () => {
    const { post } = await createAgentMcpApp({
      exposeTool: true,
      adapter: new FakeAdapter([
        { text: null, functionCalls: [{ name: 'echo', args: { message: 'ping' } }] },
        { text: 'loop complete', functionCalls: null },
      ]),
    }, true);

    const response = await post({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'agent_ask',
        arguments: { prompt: 'echo ping', conversation_id: 'loop-1' },
      },
      id: 4,
    });

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(response.body, {
      jsonrpc: '2.0',
      result: {
        content: [{
          type: 'text',
          text: '{\n  "reply": "loop complete",\n  "conversation_id": "loop-1"\n}',
        }],
      },
      id: 4,
    });
  });

  it('tools/call agent_ask with empty prompt returns MCP execution error', async () => {
    const { post } = await createAgentMcpApp({
      exposeTool: true,
      adapter: new FakeAdapter([{ text: 'unused', functionCalls: null }]),
    });

    const response = await post({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'agent_ask',
        arguments: { prompt: '' },
      },
      id: 5,
    });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.jsonrpc, '2.0');
    assert.strictEqual(response.body.id, 5);
    assert.strictEqual(response.body.error.code, -32603);
    assert.strictEqual(response.body.error.message, 'MCP error -32603: Tool execution failed');
  });

  it('tools/call agent_ask generates conversation_id when omitted', async () => {
    const { post } = await createAgentMcpApp({
      exposeTool: true,
      adapter: new FakeAdapter([{ text: 'agent says hi', functionCalls: null }]),
    });

    const response = await post({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'agent_ask',
        arguments: { prompt: 'hello' },
      },
      id: 6,
    });

    assert.strictEqual(response.status, 200);
    const payload = JSON.parse(response.body.result.content[0].text);
    assert.strictEqual(payload.reply, 'agent says hi');
    assert.match(payload.conversation_id, UUID_RE);
  });

  it('tools/call agent_ask continues multi-turn history with the same conversation_id', async () => {
    const adapter = new CapturingAdapter();
    const { post } = await createAgentMcpApp({
      exposeTool: true,
      adapter,
    });

    const first = await post({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'agent_ask',
        arguments: { prompt: 'first', conversation_id: 'multi-1' },
      },
      id: 7,
    });
    assert.strictEqual(first.status, 200);
    assert.deepStrictEqual(
      JSON.parse(first.body.result.content[0].text),
      { reply: 'turn-1', conversation_id: 'multi-1' },
    );

    const second = await post({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'agent_ask',
        arguments: { prompt: 'second', conversation_id: 'multi-1' },
      },
      id: 8,
    });
    assert.strictEqual(second.status, 200);
    assert.deepStrictEqual(
      JSON.parse(second.body.result.content[0].text),
      { reply: 'turn-2', conversation_id: 'multi-1' },
    );

    assert.strictEqual(adapter.calls.length, 2);
    const secondTurnTexts = adapter.calls[1]
      .filter((c) => c.role === 'user')
      .flatMap((c) => (c.parts || []).map((p) => p.text))
      .filter(Boolean);
    assert.deepStrictEqual(secondTurnTexts.includes('first'), true);
    assert.deepStrictEqual(secondTurnTexts.includes('second'), true);
  });
});
