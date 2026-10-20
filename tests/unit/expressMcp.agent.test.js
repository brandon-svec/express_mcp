import { assert } from 'chai';
import { ExpressMcp } from '../../src/classes/expressMcp.js';
import { ModelAdapter } from '../../src/agents/modelAdapter.js';
import { BaseTool } from '../../src/classes/baseTool.js';
import { getTestExpressMcpOptions } from '../config.js';

class StaticAdapter extends ModelAdapter {
  async generate () {
    return { text: 'ok', functionCalls: null };
  }
}

class PingTool extends BaseTool {
  constructor () {
    super('ping', 'Ping tool', {
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  }

  async execute () {
    return { ok: true };
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
        allowUnauthenticated: true,
        exposeTool: true,
        systemInstruction: 'You are a test assistant.',
        adapter: new StaticAdapter(),
      },
    }));

    assert.isTrue(mcp.hasRegisteredTool('agent_ask'));
    assert.strictEqual(mcp.agentTool.name, 'agent_ask');
    const agent = mcp.getAgent();
    assert.exists(agent);
    assert.notInclude(
      agent.buildToolDeclarations().map((d) => d.name),
      'agent_ask',
    );
  });

  it('registers prefixed agent_ask when name is set', () => {
    const mcp = new ExpressMcp(getTestExpressMcpOptions({
      name: 'widget',
      enableKnowledgeBase: false,
      agent: {
        enabled: true,
        allowUnauthenticated: true,
        exposeTool: true,
        systemInstruction: 'You are a test assistant.',
        adapter: new StaticAdapter(),
      },
    }));

    assert.isTrue(mcp.hasRegisteredTool('widget_agent_ask'));
    assert.strictEqual(mcp.agentTool.name, 'widget_agent_ask');
    const listed = mcp.getRegisteredTools().map((t) => t.name);
    assert.deepStrictEqual(listed.includes('widget_agent_ask'), true);
    assert.deepStrictEqual(listed.includes('agent_ask'), false);
  });

  it('refreshes agent_ask description when tools or KB documents change', async () => {
    const mcp = new ExpressMcp(getTestExpressMcpOptions({
      name: 'widget',
      description: 'Widget domain service',
      enableKnowledgeBase: true,
      agent: {
        enabled: true,
        allowUnauthenticated: true,
        exposeTool: true,
        systemInstruction: 'You are a test assistant.',
        adapter: new StaticAdapter(),
      },
    }));

    assert.include(mcp.agentTool.description, 'Widget domain service');
    assert.include(mcp.agentTool.description, 'Available capabilities:');
    assert.include(mcp.agentTool.description, 'widget_kb_search');
    assert.notInclude(mcp.agentTool.description, 'widget_agent_ask');

    mcp.registerTool(new PingTool());
    assert.include(mcp.agentTool.description, 'ping');

    await mcp.addDocument('sop-1', {
      title: 'SOP',
      content: 'Do the thing',
      tags: ['fulfillment'],
    });
    assert.include(mcp.agentTool.description, 'Knowledge base tags: fulfillment');
    assert.include(mcp.agentTool.description, '1 operational playbook');
  });

  it('appends domain manifest by default and updates after addDocument', async () => {
    class CapturingAdapter extends ModelAdapter {
      constructor () {
        super();
        this.generateParams = [];
      }

      async generate (params) {
        this.generateParams.push(params);
        return { text: 'ok', functionCalls: null };
      }
    }

    const adapter = new CapturingAdapter();
    const mcp = new ExpressMcp(getTestExpressMcpOptions({
      name: 'widget',
      description: 'Widget domain service',
      enableKnowledgeBase: true,
      agent: {
        enabled: true,
        allowUnauthenticated: true,
        exposeTool: false,
        systemInstruction: 'You are a test assistant.',
        adapter,
      },
    }));

    await mcp.getAgent().processMessage('k', 'hello');
    assert.include(adapter.generateParams[0].systemInstruction, 'SERVICE DOMAIN & IDENTITY:');
    assert.include(adapter.generateParams[0].systemInstruction, 'Service: widget');
    assert.include(adapter.generateParams[0].systemInstruction, 'Role: Widget domain service');
    assert.notInclude(adapter.generateParams[0].systemInstruction, 'MCP CAPABILITIES');

    await mcp.addDocument('returns', {
      title: 'Returns SOP',
      content: 'Process returns carefully.',
      summary: 'How to process returns',
      tools: ['ping'],
    });

    await mcp.getAgent().processMessage('k2', 'what governs returns?');
    const si = adapter.generateParams[1].systemInstruction;
    assert.include(si, 'OPERATIONAL PLAYBOOKS & PROCEDURES:');
    assert.include(si, 'kb://widget/returns');
    assert.include(si, 'Governs tools: ping');
  });

  it('skips domain manifest when includeDomainManifest is false', async () => {
    class CapturingAdapter extends ModelAdapter {
      constructor () {
        super();
        this.generateParams = [];
      }

      async generate (params) {
        this.generateParams.push(params);
        return { text: 'ok', functionCalls: null };
      }
    }

    const adapter = new CapturingAdapter();
    const mcp = new ExpressMcp(getTestExpressMcpOptions({
      name: 'widget',
      description: 'Widget domain service',
      enableKnowledgeBase: true,
      agent: {
        enabled: true,
        allowUnauthenticated: true,
        exposeTool: false,
        includeDomainManifest: false,
        systemInstruction: 'You are a test assistant.',
        adapter,
      },
    }));

    await mcp.addDocument('returns', {
      title: 'Returns SOP',
      content: 'Process returns.',
      summary: 'How to process returns',
    });
    await mcp.getAgent().processMessage('k', 'hello');
    assert.strictEqual(adapter.generateParams[0].systemInstruction, 'You are a test assistant.');
  });

  it('enables agent without agent_ask when exposeTool is false', () => {
    const mcp = new ExpressMcp(getTestExpressMcpOptions({
      enableKnowledgeBase: false,
      agent: {
        enabled: true,
        allowUnauthenticated: true,
        exposeTool: false,
        systemInstruction: 'You are a test assistant.',
        adapter: new StaticAdapter(),
      },
    }));

    assert.isFalse(mcp.hasRegisteredTool('agent_ask'));
    assert.exists(mcp.getAgent());
  });

  it('requires auth or allowUnauthenticated when agent is enabled', () => {
    assert.throws(
      () => new ExpressMcp(getTestExpressMcpOptions({
        enableKnowledgeBase: false,
        agent: {
          enabled: true,
          systemInstruction: 'You are a test assistant.',
          adapter: new StaticAdapter(),
        },
      })),
      /agent.enabled requires auth.enabled/,
    );
  });

  it('requires systemInstruction when agent is enabled', () => {
    assert.throws(
      () => new ExpressMcp(getTestExpressMcpOptions({
        enableKnowledgeBase: false,
        agent: {
          enabled: true,
          allowUnauthenticated: true,
          adapter: new StaticAdapter(),
        },
      })),
      /agent.systemInstruction is required/,
    );
  });

  it('applies historyMaxTurns and historyToolTurns to the default agent', () => {
    const mcp = new ExpressMcp(getTestExpressMcpOptions({
      enableKnowledgeBase: false,
      agent: {
        enabled: true,
        allowUnauthenticated: true,
        exposeTool: false,
        systemInstruction: 'You are a test assistant.',
        adapter: new StaticAdapter(),
        historyMaxTurns: 12,
        historyToolTurns: 'omit',
      },
    }));

    const agent = mcp.getAgent();
    assert.deepStrictEqual(
      {
        historyToolTurns: agent.historyToolTurns,
        maxTurns: agent.history.maxTurns,
      },
      {
        historyToolTurns: 'omit',
        maxTurns: 12,
      },
    );
  });

  it('applies historyToolTurns digest with historyToolDigest', () => {
    const digest = () => ({ ok: true });
    const mcp = new ExpressMcp(getTestExpressMcpOptions({
      enableKnowledgeBase: false,
      agent: {
        enabled: true,
        allowUnauthenticated: true,
        exposeTool: false,
        systemInstruction: 'You are a test assistant.',
        adapter: new StaticAdapter(),
        historyToolTurns: 'digest',
        historyToolDigest: digest,
      },
    }));

    assert.strictEqual(mcp.getAgent().historyToolTurns, 'digest');
    assert.strictEqual(mcp.getAgent().historyToolDigest, digest);
  });

  it('rejects digest without historyToolDigest', () => {
    assert.throws(
      () => new ExpressMcp(getTestExpressMcpOptions({
        enableKnowledgeBase: false,
        agent: {
          enabled: true,
          allowUnauthenticated: true,
          exposeTool: false,
          systemInstruction: 'You are a test assistant.',
          adapter: new StaticAdapter(),
          historyToolTurns: 'digest',
        },
      })),
      /agent.historyToolDigest is required when historyToolTurns is digest/,
    );
  });

  it('rejects historyMaxTurns with a custom history store', () => {
    assert.throws(
      () => new ExpressMcp(getTestExpressMcpOptions({
        enableKnowledgeBase: false,
        agent: {
          enabled: true,
          allowUnauthenticated: true,
          exposeTool: false,
          systemInstruction: 'You are a test assistant.',
          adapter: new StaticAdapter(),
          history: { get () { return []; }, append () {} },
          historyMaxTurns: 12,
        },
      })),
      /agent.historyMaxTurns applies only to the default in-memory history store/,
    );
  });

  it('merges agent.excludeTools into the agent exclusion set', () => {
    const mcp = new ExpressMcp(getTestExpressMcpOptions({
      enableKnowledgeBase: true,
      name: 'gillium',
      agent: {
        enabled: true,
        allowUnauthenticated: true,
        exposeTool: false,
        systemInstruction: 'You are a test assistant.',
        adapter: new StaticAdapter(),
        excludeTools: ['gillium_kb_search', 'gillium_kb_list', 'gillium_kb_get'],
      },
    }));

    const names = mcp.getAgent().buildToolDeclarations().map((d) => d.name);
    assert.notInclude(names, 'gillium_kb_search');
    assert.notInclude(names, 'gillium_kb_list');
    assert.notInclude(names, 'gillium_kb_get');
    assert.notInclude(names, 'gillium_session');
  });
});
