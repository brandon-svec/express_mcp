import { strict as assert } from 'assert';
import express from 'express';
import request from 'supertest';
import { ExpressMcp } from '../../src/classes/expressMcp.js';
import { CommandTool } from '../../src/classes/commandTool.js';
import { ModelAdapter } from '../../src/agents/modelAdapter.js';
import { getTestExpressMcpOptions, createMcpSession, mcpPostWithSession } from '../config.js';

class CapturingAdapter extends ModelAdapter {
  constructor () {
    super();
    this.calls = [];
  }

  async generate ({ contents }) {
    this.calls.push(contents);
    const lastUser = [...contents].reverse().find((c) => c.role === 'user');
    const text = lastUser?.parts?.[0]?.text || '';
    if (text.includes('What was my equity')) {
      const priorModel = contents.find((c) => c.role === 'model');
      return {
        text: priorModel ? `From history: ${priorModel.parts[0].text}` : 'no history',
        functionCalls: null,
      };
    }
    return { text: `ack:${this.calls.length}`, functionCalls: null };
  }
}

class StatusCommand extends CommandTool {
  constructor () {
    super('status', 'Live status', {
      type: 'object',
      properties: {},
      additionalProperties: false,
    }, {
      triggers: ['status'],
      mode: 'direct',
      formatResponse: async (result) => `Equity: $${result.equity}`,
    });
    this.executeCalls = 0;
  }

  async execute () {
    this.executeCalls += 1;
    return { equity: 12345 };
  }
}

async function createApp (agentOptions = {}) {
  const expressMcp = new ExpressMcp(getTestExpressMcpOptions({
    enableKnowledgeBase: false,
    agent: {
      enabled: true,
      allowUnauthenticated: true,
      systemInstruction: 'test assistant',
      maxToolRounds: 8,
      exposeTool: true,
      ...agentOptions,
    },
  }));
  const status = new StatusCommand();
  expressMcp.registerTool(status);

  const app = express();
  app.use(express.json());
  app.use('/mcp', expressMcp.router());
  const baseAgent = request(app);

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
    status,
    post: async (body) => mcpPostWithSession(baseAgent, sessionId, '/mcp').send(body),
  };
}

describe('CommandTool integration', () => {
  it('fast-path status is remembered on the next natural-language turn', async () => {
    const adapter = new CapturingAdapter();
    const { expressMcp, status } = await createApp({
      adapter,
      exposeTool: false,
    });

    const agent = expressMcp.getAgent();
    const first = await agent.processMessage('owner:1', 'status');
    assert.equal(first, 'Equity: $12345');
    assert.equal(status.executeCalls, 1);
    assert.equal(adapter.calls.length, 0);

    const second = await agent.processMessage('owner:1', 'What was my equity?');
    assert.equal(second, 'From history: Equity: $12345');
    assert.equal(status.executeCalls, 1);
    assert.equal(adapter.calls.length, 1);
  });

  it('executeTool with historyKey supports follow-up continuity', async () => {
    const adapter = new CapturingAdapter();
    const { expressMcp, status } = await createApp({
      adapter,
      exposeTool: false,
    });

    await expressMcp.executeTool('status', {}, {
      historyKey: 'owner:2',
      userText: 'status',
    });
    assert.equal(status.executeCalls, 1);

    const reply = await expressMcp.getAgent().processMessage('owner:2', 'What was my equity?');
    assert.equal(reply, 'From history: Equity: $12345');
    assert.equal(status.executeCalls, 1);
  });

  it('tools/call with _meta.conversation_id records history for agent_ask', async () => {
    const adapter = new CapturingAdapter();
    const { post, status, expressMcp } = await createApp({ adapter });

    const callResponse = await post({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'status',
        arguments: {},
        _meta: { conversation_id: 'cmd-1' },
      },
      id: 1,
    });

    assert.equal(callResponse.status, 200);
    assert.equal(status.executeCalls, 1);
    assert.deepEqual(
      expressMcp.getAgent().history.get('mcp:anon:cmd-1'),
      [
        { role: 'user', parts: [{ text: '/status' }] },
        { role: 'model', parts: [{ text: 'Equity: $12345' }] },
      ],
    );

    const askResponse = await post({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'agent_ask',
        arguments: {
          prompt: 'What was my equity?',
          conversation_id: 'cmd-1',
        },
      },
      id: 2,
    });

    assert.equal(askResponse.status, 200);
    const payload = JSON.parse(askResponse.body.result.content[0].text);
    assert.equal(payload.reply, 'From history: Equity: $12345');
    assert.equal(payload.conversation_id, 'cmd-1');
    assert.equal(status.executeCalls, 1);
  });
});
