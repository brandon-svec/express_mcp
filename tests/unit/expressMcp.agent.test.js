import { assert } from 'chai';
import { ExpressMcp } from '../../src/classes/expressMcp.js';
import { ModelAdapter } from '../../src/agents/modelAdapter.js';
import { getTestExpressMcpOptions } from '../config.js';

class StaticAdapter extends ModelAdapter {
  async generate () {
    return { text: 'ok', functionCalls: null };
  }
}

describe('ExpressMcp agent option', () => {
  it('does not enable agent by default', () => {
    const mcp = new ExpressMcp(getTestExpressMcpOptions({ enableKnowledgeBase: false }));
    assert.throws(() => mcp.getAgent(), /Agent is not enabled/);
    assert.isFalse(mcp.hasRegisteredTool('agent_ask'));
  });

  it('enables agent and registers agent_ask when exposeTool is true', () => {
    const mcp = new ExpressMcp(getTestExpressMcpOptions({
      enableKnowledgeBase: false,
      agent: {
        enabled: true,
        exposeTool: true,
        systemInstruction: 'You are a test assistant.',
        adapter: new StaticAdapter(),
      },
    }));

    assert.isTrue(mcp.hasRegisteredTool('agent_ask'));
    const agent = mcp.getAgent();
    assert.exists(agent);
    assert.notInclude(
      agent.buildToolDeclarations().map((d) => d.name),
      'agent_ask',
    );
  });

  it('enables agent without agent_ask when exposeTool is false', () => {
    const mcp = new ExpressMcp(getTestExpressMcpOptions({
      enableKnowledgeBase: false,
      agent: {
        enabled: true,
        exposeTool: false,
        systemInstruction: 'You are a test assistant.',
        adapter: new StaticAdapter(),
      },
    }));

    assert.isFalse(mcp.hasRegisteredTool('agent_ask'));
    assert.exists(mcp.getAgent());
  });

  it('requires systemInstruction when agent is enabled', () => {
    assert.throws(
      () => new ExpressMcp(getTestExpressMcpOptions({
        enableKnowledgeBase: false,
        agent: { enabled: true, adapter: new StaticAdapter() },
      })),
      /agent.systemInstruction is required/,
    );
  });
});
