import { assert } from 'chai';
import { Agent } from '../../src/agents/agent.js';
import { ModelAdapter } from '../../src/agents/modelAdapter.js';
import { InMemoryHistoryStore } from '../../src/agents/historyStore.js';
import { ToolRegistry } from '../../src/classes/toolRegistry.js';
import { BaseTool } from '../../src/classes/baseTool.js';

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

describe('Agent', () => {
  let registry;

  beforeEach(() => {
    registry = new ToolRegistry({ loggerOptions: { enabled: false } });
    registry.register(new EchoTool());
  });

  it('runs tool loop and returns final text', async () => {
    const adapter = new FakeAdapter([
      { text: null, functionCalls: [{ name: 'echo', args: { message: 'hi' } }] },
      { text: 'done', functionCalls: null },
    ]);
    const agent = new Agent({
      adapter,
      toolRegistry: registry,
      systemInstruction: 'test',
      maxToolRounds: 8,
    });

    const reply = await agent.processMessage('user:1', 'say hi');
    assert.strictEqual(reply, 'done');
    assert.strictEqual(adapter.callIndex, 2);
  });

  it('excludes tools from declarations and rejects excluded calls', async () => {
    const adapter = new FakeAdapter([
      { text: null, functionCalls: [{ name: 'agent_ask', args: { prompt: 'x' } }] },
    ]);
    const agent = new Agent({
      adapter,
      toolRegistry: registry,
      systemInstruction: 'test',
      maxToolRounds: 8,
      excludeTools: ['agent_ask'],
    });

    const declarations = agent.buildToolDeclarations();
    assert.isFalse(declarations.some((d) => d.name === 'agent_ask'));

    try {
      await agent.processMessage('k', 'go');
      assert.fail('expected processMessage to throw');
    } catch (err) {
      assert.match(err.message, /Tool is not available to the agent: agent_ask/);
    }
  });

  it('throws when max tool rounds exceeded without final text', async () => {
    const adapter = new FakeAdapter([
      { text: null, functionCalls: [{ name: 'echo', args: { message: 'a' } }] },
      { text: null, functionCalls: [{ name: 'echo', args: { message: 'b' } }] },
    ]);
    const agent = new Agent({
      adapter,
      toolRegistry: registry,
      systemInstruction: 'test',
      maxToolRounds: 1,
    });

    try {
      await agent.processMessage('k', 'loop');
      assert.fail('expected processMessage to throw');
    } catch (err) {
      assert.match(err.message, /Model returned empty response/);
    }
  });

  it('throws for unknown tool from model', async () => {
    const adapter = new FakeAdapter([
      { text: null, functionCalls: [{ name: 'missing_tool', args: {} }] },
    ]);
    const agent = new Agent({
      adapter,
      toolRegistry: registry,
      systemInstruction: 'test',
      maxToolRounds: 8,
    });

    try {
      await agent.processMessage('k', 'x');
      assert.fail('expected processMessage to throw');
    } catch (err) {
      assert.match(err.message, /Tool 'missing_tool' not found/);
    }
  });

  it('throws when adapter is missing', () => {
    assert.throws(
      () => new Agent({
        toolRegistry: registry,
        systemInstruction: 'test',
        maxToolRounds: 8,
      }),
      /adapter is required/,
    );
  });

  it('throws when toolRegistry is missing', () => {
    assert.throws(
      () => new Agent({
        adapter: new FakeAdapter([]),
        systemInstruction: 'test',
        maxToolRounds: 8,
      }),
      /toolRegistry is required/,
    );
  });

  it('throws when systemInstruction is empty', () => {
    assert.throws(
      () => new Agent({
        adapter: new FakeAdapter([]),
        toolRegistry: registry,
        systemInstruction: '   ',
        maxToolRounds: 8,
      }),
      /systemInstruction is required/,
    );
  });

  it('throws when maxToolRounds is omitted', () => {
    assert.throws(
      () => new Agent({
        adapter: new FakeAdapter([]),
        toolRegistry: registry,
        systemInstruction: 'test',
      }),
      /Invalid maxToolRounds: undefined/,
    );
  });

  it('throws when historyKey is empty', async () => {
    const agent = new Agent({
      adapter: new FakeAdapter([]),
      toolRegistry: registry,
      systemInstruction: 'test',
      maxToolRounds: 8,
    });

    try {
      await agent.processMessage('', 'hello');
      assert.fail('expected processMessage to throw');
    } catch (err) {
      assert.strictEqual(err.message, 'historyKey is required');
    }
  });

  it('throws when text is whitespace only', async () => {
    const agent = new Agent({
      adapter: new FakeAdapter([]),
      toolRegistry: registry,
      systemInstruction: 'test',
      maxToolRounds: 8,
    });

    try {
      await agent.processMessage('k', '   ');
      assert.fail('expected processMessage to throw');
    } catch (err) {
      assert.strictEqual(err.message, 'text is required');
    }
  });

  it('throws when model function call has no name', async () => {
    const adapter = new FakeAdapter([
      { text: null, functionCalls: [{ name: undefined, args: {} }] },
    ]);
    const agent = new Agent({
      adapter,
      toolRegistry: registry,
      systemInstruction: 'test',
      maxToolRounds: 8,
    });

    try {
      await agent.processMessage('k', 'go');
      assert.fail('expected processMessage to throw');
    } catch (err) {
      assert.strictEqual(err.message, 'Model function call missing name');
    }
  });

  it('clearHistory is a no-op when agent has no history store', () => {
    const agent = new Agent({
      adapter: new FakeAdapter([]),
      toolRegistry: registry,
      systemInstruction: 'test',
      maxToolRounds: 8,
    });

    assert.doesNotThrow(() => agent.clearHistory('k'));
    assert.doesNotThrow(() => agent.clearHistory());
  });

  it('clearHistory clears a specific key in the history store', async () => {
    const history = new InMemoryHistoryStore({ windowMinutes: 60 });
    const agent = new Agent({
      adapter: new FakeAdapter([{ text: 'reply', functionCalls: null }]),
      toolRegistry: registry,
      systemInstruction: 'test',
      history,
      maxToolRounds: 8,
    });

    await agent.processMessage('chat:1', 'hello');
    agent.clearHistory('chat:1');

    assert.deepStrictEqual(history.get('chat:1'), []);
  });

  it('appends turns to history store', async () => {
    const history = new InMemoryHistoryStore({ windowMinutes: 60 });
    const adapter = new FakeAdapter([
      { text: 'first reply', functionCalls: null },
      { text: 'second reply', functionCalls: null },
    ]);
    const agent = new Agent({
      adapter,
      toolRegistry: registry,
      systemInstruction: 'test',
      history,
      maxToolRounds: 8,
    });

    await agent.processMessage('chat:1', 'one');
    await agent.processMessage('chat:1', 'two');

    const stored = history.get('chat:1');
    assert.isAtLeast(stored.length, 4);
    assert.strictEqual(stored[0].parts[0].text, 'one');
    assert.strictEqual(stored[stored.length - 1].parts[0].text, 'second reply');
  });
});
