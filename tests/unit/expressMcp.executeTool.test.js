import { assert } from 'chai';
import { ExpressMcp } from '../../src/classes/expressMcp.js';
import { CommandTool } from '../../src/classes/commandTool.js';
import { BaseTool } from '../../src/classes/baseTool.js';
import { ModelAdapter } from '../../src/agents/modelAdapter.js';
import { getTestExpressMcpOptions } from '../config.js';

class FakeAdapter extends ModelAdapter {
  async generate () {
    return { text: 'unused', functionCalls: null };
  }
}

class StatusCommand extends CommandTool {
  constructor () {
    super('status', 'Status', {
      type: 'object',
      properties: {},
      additionalProperties: false,
    }, {
      triggers: ['status'],
      formatResponse: async (result) => `Equity: ${result.equity}`,
    });
  }

  async execute () {
    return { equity: 77 };
  }
}

class PlainTool extends BaseTool {
  constructor () {
    super('plain', 'Plain tool', {
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  }

  async execute () {
    return { value: 1 };
  }
}

describe('ExpressMcp.executeTool', () => {
  it('executes a CommandTool and records history when historyKey is set', async () => {
    const mcp = new ExpressMcp(getTestExpressMcpOptions({
      enableKnowledgeBase: false,
      agent: {
        enabled: true,
        allowUnauthenticated: true,
        systemInstruction: 'test',
        adapter: new FakeAdapter(),
        exposeTool: false,
      },
    }));
    mcp.registerTool(new StatusCommand());

    const { result, formattedText } = await mcp.executeTool('status', {}, {
      historyKey: 'host:1',
      userText: 'status',
    });

    assert.deepStrictEqual(result, { equity: 77 });
    assert.strictEqual(formattedText, 'Equity: 77');
    assert.deepStrictEqual(mcp.getAgent().history.get('host:1'), [
      { role: 'user', parts: [{ text: 'status' }] },
      { role: 'model', parts: [{ text: 'Equity: 77' }] },
    ]);
  });

  it('does not record history when recordToHistory is false and no historyKey', async () => {
    const mcp = new ExpressMcp(getTestExpressMcpOptions({
      enableKnowledgeBase: false,
      agent: {
        enabled: true,
        allowUnauthenticated: true,
        systemInstruction: 'test',
        adapter: new FakeAdapter(),
        exposeTool: false,
      },
    }));
    mcp.registerTool(new PlainTool());

    const out = await mcp.executeTool('plain', {}, { recordToHistory: false });
    assert.deepStrictEqual(out.result, { value: 1 });
    assert.match(out.formattedText, /"value": 1/);
    assert.deepStrictEqual(mcp.getAgent().history.get('anything'), []);
  });

  it('throws when tool execution fails', async () => {
    class BoomTool extends BaseTool {
      constructor () {
        super('boom', 'Boom', {
          type: 'object',
          properties: {},
          additionalProperties: false,
        });
      }

      async execute () {
        throw new Error('kaboom');
      }
    }

    const mcp = new ExpressMcp(getTestExpressMcpOptions({
      enableKnowledgeBase: false,
      agent: {
        enabled: true,
        allowUnauthenticated: true,
        systemInstruction: 'test',
        adapter: new FakeAdapter(),
        exposeTool: false,
      },
    }));
    mcp.registerTool(new BoomTool());

    try {
      await mcp.executeTool('boom', {});
      assert.fail('expected throw');
    } catch (err) {
      assert.match(err.message, /Tool execution failed/);
    }
  });
});
