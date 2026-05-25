import { assert } from 'chai';
import { Agent } from '../../src/agents/agent.js';
import { AgentTool } from '../../src/tools/agent.js';
import { ModelAdapter } from '../../src/agents/modelAdapter.js';
import { ToolRegistry } from '../../src/classes/toolRegistry.js';

class ReplyAdapter extends ModelAdapter {
  async generate () {
    return { text: 'agent says hi', functionCalls: null };
  }
}

describe('AgentTool', () => {
  it('throws when agent is null', () => {
    assert.throws(() => new AgentTool(null), /agent is required/);
  });

  it('throws when prompt is empty', async () => {
    const registry = new ToolRegistry({ loggerOptions: { enabled: false } });
    const agent = new Agent({
      adapter: new ReplyAdapter(),
      toolRegistry: registry,
      systemInstruction: 'test',
      maxToolRounds: 8,
    });
    const tool = new AgentTool(agent);

    try {
      await tool.execute({ prompt: '' }, { user: null });
      assert.fail('expected execute to throw');
    } catch (err) {
      assert.strictEqual(err.message, 'prompt is required and must be a non-empty string');
    }
  });

  it('throws when prompt is whitespace only', async () => {
    const registry = new ToolRegistry({ loggerOptions: { enabled: false } });
    const agent = new Agent({
      adapter: new ReplyAdapter(),
      toolRegistry: registry,
      systemInstruction: 'test',
      maxToolRounds: 8,
    });
    const tool = new AgentTool(agent);

    try {
      await tool.execute({ prompt: '   ' }, { user: null });
      assert.fail('expected execute to throw');
    } catch (err) {
      assert.strictEqual(err.message, 'prompt is required and must be a non-empty string');
    }
  });

  it('returns reply from one-shot processMessage', async () => {
    const registry = new ToolRegistry({ loggerOptions: { enabled: false } });
    const agent = new Agent({
      adapter: new ReplyAdapter(),
      toolRegistry: registry,
      systemInstruction: 'test',
      maxToolRounds: 8,
      excludeTools: ['agent_ask'],
    });
    const tool = new AgentTool(agent);

    const result = await tool.execute({ prompt: 'hello' }, { user: null });
    assert.strictEqual(result.reply, 'agent says hi');
  });

  it('uses isolated history keys per call', async () => {
    const keys = [];
    class KeyCapturingAdapter extends ModelAdapter {
      async generate ({ contents }) {
        const userText = contents.find((c) => c.role === 'user' && c.parts?.[0]?.text)?.parts[0].text;
        keys.push(userText);
        return { text: `ok:${userText}`, functionCalls: null };
      }
    }

    const registry = new ToolRegistry({ loggerOptions: { enabled: false } });
    const history = {
      store: new Map(),
      get (key) {
        return this.store.get(key) || [];
      },
      append (key, contents) {
        const prior = this.store.get(key) || [];
        this.store.set(key, prior.concat(contents));
      },
      clear () {
        this.store.clear();
      },
    };
    const agent = new Agent({
      adapter: new KeyCapturingAdapter(),
      toolRegistry: registry,
      systemInstruction: 'test',
      history,
      maxToolRounds: 8,
      excludeTools: ['agent_ask'],
    });
    const tool = new AgentTool(agent);

    await tool.execute({ prompt: 'first' }, { user: null });
    await tool.execute({ prompt: 'second' }, { user: null });

    assert.strictEqual(keys[0], 'first');
    assert.strictEqual(keys[1], 'second');
    assert.strictEqual(history.store.size, 2);
  });
});
