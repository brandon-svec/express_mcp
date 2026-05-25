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
      description: 'Natural-language question or instruction.',
    },
  },
  required: ['prompt'],
  additionalProperties: false,
};

async function createAgentMcpApp (agentOptions, registerEcho = false) {
  const expressMcp = new ExpressMcp(getTestExpressMcpOptions({
    enableKnowledgeBase: false,
    agent: {
      enabled: true,
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
  const sessionId = await createMcpSession(baseAgent);

  return {
    expressMcp,
    post: (body) => mcpPostWithSession(baseAgent, sessionId, '/mcp').send(body),
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
        arguments: { prompt: 'hello' },
      },
      id: 3,
    });

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(response.body, {
      jsonrpc: '2.0',
      result: {
        content: [{
          type: 'text',
          text: '{\n  "reply": "agent says hi"\n}',
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
        arguments: { prompt: 'echo ping' },
      },
      id: 4,
    });

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(response.body, {
      jsonrpc: '2.0',
      result: {
        content: [{
          type: 'text',
          text: '{\n  "reply": "loop complete"\n}',
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
    assert.deepStrictEqual(response.body, {
      jsonrpc: '2.0',
      error: {
        code: -32603,
        message: 'MCP error -32603: Tool execution failed: prompt is required and must be a non-empty string',
        data: response.body.error.data,
      },
      id: 5,
    });
  });
});
