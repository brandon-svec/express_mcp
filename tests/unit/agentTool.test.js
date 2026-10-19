import { assert } from 'chai';
import { Agent } from '../../src/agents/agent.js';
import { AgentTool } from '../../src/tools/agent.js';
import { ModelAdapter } from '../../src/agents/modelAdapter.js';
import { ToolRegistry } from '../../src/classes/toolRegistry.js';
import { BaseTool } from '../../src/classes/baseTool.js';
import { KnowledgeBase } from '../../src/classes/knowledgeBase.js';
import { ToolExecution } from '../../src/classes/toolExecution.js';
import { TelemetryEngine } from '../../src/telemetry/telemetryEngine.js';
import { normalizeTelemetryConfig } from '../../src/telemetry/normalizeTelemetryConfig.js';
import { parseTraceparent } from '../../src/telemetry/traceContext.js';

class ReplyAdapter extends ModelAdapter {
  async generate () {
    return { text: 'agent says hi', functionCalls: null };
  }
}

class EchoTool extends BaseTool {
  constructor () {
    super('echo', 'Echo tool', {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
      additionalProperties: false,
    });
  }

  async execute (args) {
    return { echoed: args.message };
  }
}

function createHistory () {
  return {
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
}

function createAgent (overrides = {}) {
  const registry = overrides.toolRegistry || new ToolRegistry({ loggerOptions: { enabled: false } });
  const history = overrides.history || createHistory();
  const agent = new Agent({
    adapter: overrides.adapter || new ReplyAdapter(),
    toolRegistry: registry,
    systemInstruction: 'test',
    history,
    maxToolRounds: 8,
    excludeTools: overrides.excludeTools || ['agent_ask', 'session'],
    telemetryEngine: overrides.telemetryEngine,
  });
  return { agent, registry, history };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('AgentTool', () => {
  it('throws when agent is null', () => {
    assert.throws(() => new AgentTool(null), /agent is required/);
  });

  it('throws when prompt is empty', async () => {
    const { agent } = createAgent();
    const tool = new AgentTool(agent);

    try {
      await tool.execute({ prompt: '' }, { user: null });
      assert.fail('expected execute to throw');
    } catch (err) {
      assert.strictEqual(err.message, 'prompt is required and must be a non-empty string');
    }
  });

  it('throws when prompt is whitespace only', async () => {
    const { agent } = createAgent();
    const tool = new AgentTool(agent);

    try {
      await tool.execute({ prompt: '   ' }, { user: null });
      assert.fail('expected execute to throw');
    } catch (err) {
      assert.strictEqual(err.message, 'prompt is required and must be a non-empty string');
    }
  });

  it('returns reply and generated conversation_id from processMessage', async () => {
    const { agent } = createAgent();
    const tool = new AgentTool(agent);

    const result = await tool.execute({ prompt: 'hello' }, { user: null });
    assert.strictEqual(result.reply, 'agent says hi');
    assert.match(result.conversation_id, UUID_RE);
  });

  it('returns caller-supplied conversation_id', async () => {
    const { agent } = createAgent();
    const tool = new AgentTool(agent);

    const result = await tool.execute(
      { prompt: 'hello', conversation_id: 'conv-1' },
      { user: null },
    );
    assert.deepStrictEqual(result, {
      reply: 'agent says hi',
      conversation_id: 'conv-1',
    });
  });

  it('creates isolated history keys when conversation_id is omitted', async () => {
    const { agent, history } = createAgent({ adapter: new ReplyAdapter() });
    const tool = new AgentTool(agent);

    const first = await tool.execute({ prompt: 'first' }, { user: null });
    const second = await tool.execute({ prompt: 'second' }, { user: null });

    assert.notStrictEqual(first.conversation_id, second.conversation_id);
    assert.strictEqual(history.store.size, 2);
    assert.isTrue(history.store.has(`mcp:anon:${first.conversation_id}`));
    assert.isTrue(history.store.has(`mcp:anon:${second.conversation_id}`));
  });

  it('reuses history for the same conversation_id and user', async () => {
    const seenContents = [];
    class CapturingAdapter extends ModelAdapter {
      async generate ({ contents }) {
        seenContents.push(contents);
        return { text: 'ok', functionCalls: null };
      }
    }

    const { agent, history } = createAgent({ adapter: new CapturingAdapter() });
    const tool = new AgentTool(agent);
    const user = { sub: 'u1' };

    await tool.execute({ prompt: 'first', conversation_id: 'shared' }, { user });
    await tool.execute({ prompt: 'second', conversation_id: 'shared' }, { user });

    assert.strictEqual(history.store.size, 1);
    assert.isTrue(history.store.has('mcp:u1:shared'));
    assert.strictEqual(seenContents.length, 2);
    const secondTurnUserTexts = seenContents[1]
      .filter((c) => c.role === 'user')
      .map((c) => c.parts?.[0]?.text);
    assert.include(secondTurnUserTexts, 'first');
    assert.include(secondTurnUserTexts, 'second');
  });

  it('isolates history across users with the same conversation_id', async () => {
    const { agent, history } = createAgent();
    const tool = new AgentTool(agent);

    await tool.execute(
      { prompt: 'from-u1', conversation_id: 'shared' },
      { user: { sub: 'u1' } },
    );
    await tool.execute(
      { prompt: 'from-u2', conversation_id: 'shared' },
      { user: { sub: 'u2' } },
    );

    assert.strictEqual(history.store.size, 2);
    assert.isTrue(history.store.has('mcp:u1:shared'));
    assert.isTrue(history.store.has('mcp:u2:shared'));

    const u1Text = JSON.stringify(history.store.get('mcp:u1:shared'));
    const u2Text = JSON.stringify(history.store.get('mcp:u2:shared'));
    assert.include(u1Text, 'from-u1');
    assert.notInclude(u1Text, 'from-u2');
    assert.include(u2Text, 'from-u2');
    assert.notInclude(u2Text, 'from-u1');
  });

  it('scopes history under anon when user is missing', async () => {
    const { agent, history } = createAgent();
    const tool = new AgentTool(agent);

    await tool.execute({ prompt: 'hello', conversation_id: 'c1' }, { user: null });
    assert.isTrue(history.store.has('mcp:anon:c1'));
  });

  it('rejects invalid conversation_id values', async () => {
    const { agent } = createAgent();
    const tool = new AgentTool(agent);

    try {
      await tool.execute({ prompt: 'hi', conversation_id: '   ' }, { user: null });
      assert.fail('expected empty conversation_id to throw');
    } catch (err) {
      assert.match(err.message, /conversation_id must be a non-empty string when provided/);
    }

    try {
      await tool.execute({ prompt: 'hi', conversation_id: 'a'.repeat(129) }, { user: null });
      assert.fail('expected long conversation_id to throw');
    } catch (err) {
      assert.match(err.message, /conversation_id must be at most 128 characters/);
    }

    try {
      await tool.execute({ prompt: 'hi', conversation_id: 'bad\nid' }, { user: null });
      assert.fail('expected control-char conversation_id to throw');
    } catch (err) {
      assert.match(err.message, /conversation_id must not contain control characters/);
    }
  });

  it('rejects invalid context values', async () => {
    const { agent } = createAgent();
    const tool = new AgentTool(agent);

    try {
      await tool.execute({ prompt: 'hi', context: null }, { user: null });
      assert.fail('expected null context to throw');
    } catch (err) {
      assert.match(err.message, /context must be a non-null plain object when provided/);
    }

    try {
      await tool.execute({ prompt: 'hi', context: [] }, { user: null });
      assert.fail('expected array context to throw');
    } catch (err) {
      assert.match(err.message, /context must be a non-null plain object when provided/);
    }

    try {
      await tool.execute({ prompt: 'hi', context: {} }, { user: null });
      assert.fail('expected empty context to throw');
    } catch (err) {
      assert.match(err.message, /context must have at least one key when provided/);
    }
  });

  it('injects CALLER_CONTEXT via ephemeralPrefix without storing it in history', async () => {
    let modelUserText = null;
    class CapturingAdapter extends ModelAdapter {
      async generate ({ contents }) {
        const userParts = contents.filter((c) => c.role === 'user');
        modelUserText = userParts[userParts.length - 1]?.parts?.[0]?.text;
        return { text: 'ok', functionCalls: null };
      }
    }

    const { agent, history } = createAgent({ adapter: new CapturingAdapter() });
    const tool = new AgentTool(agent);

    await tool.execute(
      {
        prompt: 'do the thing',
        conversation_id: 'ctx-1',
        context: { ticket_id: 'T-9', priority: 'high' },
      },
      { user: null },
    );

    assert.match(modelUserText, /^CALLER_CONTEXT:\n/);
    assert.include(modelUserText, '"priority":"high"');
    assert.include(modelUserText, '"ticket_id":"T-9"');
    assert.include(modelUserText, '\n\ndo the thing');

    const stored = history.store.get('mcp:anon:ctx-1');
    const storedJson = JSON.stringify(stored);
    assert.include(storedJson, 'do the thing');
    assert.notInclude(storedJson, 'CALLER_CONTEXT');
    assert.notInclude(storedJson, 'ticket_id');
  });

  it('forwards context.meta.traceparent into processMessage', async () => {
    const received = [];
    const { agent } = createAgent();
    const tool = new AgentTool(agent);
    agent.processMessage = async (historyKey, text, options) => {
      received.push({ historyKey, text, options });
      return 'stubbed';
    };

    const result = await tool.execute(
      { prompt: 'traced', conversation_id: 'tp-1' },
      { user: { sub: 'u1' }, meta: { traceparent: '00-aa-bb-01' } },
    );

    assert.deepStrictEqual(result, { reply: 'stubbed', conversation_id: 'tp-1' });
    assert.deepStrictEqual(received, [{
      historyKey: 'mcp:u1:tp-1',
      text: 'traced',
      options: {
        user: { sub: 'u1' },
        meta: { traceparent: '00-aa-bb-01' },
      },
    }]);
  });

  it('nests agent CHAIN under the TOOL span when executed via ToolRegistry', async () => {
    /** @type {object[]} */
    const exported = [];
    const config = normalizeTelemetryConfig({
      enabled: true,
      protocol: 'http/json',
      endpoint: 'http://127.0.0.1:9/v1/traces',
      batchMaxSpans: 100,
      batchTimeoutMs: 60_000,
    });
    const engine = new TelemetryEngine({
      config,
      packageVersion: '0.0.0-test',
      sender: {
        send: async (spans) => {
          exported.push(...spans);
        },
        destroy () {},
      },
    });

    const registry = new ToolRegistry({
      loggerOptions: { enabled: false },
      telemetryEngine: engine,
    });
    const { agent } = createAgent({
      toolRegistry: registry,
      telemetryEngine: engine,
      excludeTools: ['agent_ask'],
    });
    const tool = new AgentTool(agent);
    registry.register(tool);

    const inbound = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    await registry.executeTool(
      'agent_ask',
      { prompt: 'hello', conversation_id: 'trace-1' },
      {
        execution: new ToolExecution('agent_ask', null, { prompt: 'hello' }),
        user: null,
        meta: { traceparent: inbound },
      },
    );
    await engine.shutdown();

    const toolSpan = exported.find((s) => s.name === 'mcp.tool.agent_ask');
    const chainSpan = exported.find((s) => s.name === 'agent.process_message');
    assert.ok(toolSpan);
    assert.ok(chainSpan);
    assert.strictEqual(toolSpan.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
    assert.strictEqual(toolSpan.parentSpanId, '00f067aa0ba902b7');
    assert.strictEqual(chainSpan.traceId, toolSpan.traceId);
    assert.strictEqual(chainSpan.parentSpanId, toolSpan.spanId);
  });

  it('refreshDescription reflects service description, tools, and KB tags', () => {
    const registry = new ToolRegistry({ loggerOptions: { enabled: false } });
    registry.register(new EchoTool());
    const agent = new Agent({
      adapter: new ReplyAdapter(),
      toolRegistry: registry,
      systemInstruction: 'test',
      maxToolRounds: 8,
      excludeTools: ['agent_ask', 'session'],
    });
    const kb = new KnowledgeBase({ loggerOptions: { enabled: false } });
    kb.addDocument('doc-1', {
      title: 'Playbook',
      content: 'Steps',
      tags: ['ops', 'runbook', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
    });

    const tool = new AgentTool(agent, {
      description: 'Ask the specialist.',
      serviceDescription: 'Widget fulfillment domain',
      knowledgeBase: kb,
    });
    // Register agent_ask after construction so refresh must exclude it via excludeTools
    registry.register(tool);
    tool.refreshDescription();

    assert.include(tool.description, 'Ask the specialist.');
    assert.include(tool.description, 'Widget fulfillment domain');
    assert.include(tool.description, 'Available capabilities: echo');
    assert.notInclude(tool.description, 'agent_ask');
    assert.match(tool.description, /Knowledge base tags: /);
    assert.include(tool.description, 'ops');
    assert.include(tool.description, 'and 1 more');
  });

  it('omits empty capability and tag clauses from description', () => {
    const { agent } = createAgent();
    const tool = new AgentTool(agent);
    assert.strictEqual(
      tool.description,
      'Ask the agent a question; it can use registered tools and the knowledge base to answer.',
    );
  });
});

describe('ToolRegistry executeTool traceparent propagation', () => {
  it('passes toolSpan.traceparent into tool.execute context.meta', async () => {
    /** @type {object[]} */
    const exported = [];
    const config = normalizeTelemetryConfig({
      enabled: true,
      protocol: 'http/json',
      endpoint: 'http://127.0.0.1:9/v1/traces',
      batchMaxSpans: 100,
      batchTimeoutMs: 60_000,
    });
    const engine = new TelemetryEngine({
      config,
      packageVersion: '0.0.0-test',
      sender: {
        send: async (spans) => {
          exported.push(...spans);
        },
        destroy () {},
      },
    });

    let executeMeta = null;
    class MetaCapturingTool extends BaseTool {
      constructor () {
        super('meta-tool', 'Captures meta', {
          type: 'object',
          properties: {},
          additionalProperties: false,
        });
      }

      async execute (_args, context) {
        executeMeta = context.meta;
        return { ok: true };
      }
    }

    const registry = new ToolRegistry({
      loggerOptions: { enabled: false },
      telemetryEngine: engine,
    });
    registry.register(new MetaCapturingTool());

    const inbound = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    await registry.executeTool(
      'meta-tool',
      {},
      {
        execution: new ToolExecution('meta-tool', null, {}),
        meta: { traceparent: inbound, other: 'kept' },
      },
    );
    await engine.shutdown();

    assert.ok(executeMeta);
    assert.strictEqual(executeMeta.other, 'kept');
    assert.notStrictEqual(executeMeta.traceparent, inbound);
    const parsed = parseTraceparent(executeMeta.traceparent);
    assert.strictEqual(parsed.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
    assert.strictEqual(exported[0].spanId, parsed.spanId);
    assert.strictEqual(exported[0].parentSpanId, '00f067aa0ba902b7');
  });
});
