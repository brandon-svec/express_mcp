import { assert } from 'chai';
import { Agent, REQUEST_TOOLS_NAME } from '../../src/agents/agent.js';
import { ModelAdapter } from '../../src/agents/modelAdapter.js';
import { ToolRegistry } from '../../src/classes/toolRegistry.js';
import { BaseTool } from '../../src/classes/baseTool.js';
import { BaseHook } from '../../src/classes/baseHook.js';
import { HookRegistry } from '../../src/classes/hookRegistry.js';
import { TelemetryEngine } from '../../src/telemetry/telemetryEngine.js';
import { normalizeTelemetryConfig } from '../../src/telemetry/normalizeTelemetryConfig.js';

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
    super('echo', 'Echo', {
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

class OtherTool extends BaseTool {
  constructor () {
    super('other', 'Other', {
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  }

  async execute () {
    return { ok: true };
  }
}

class AgentHook extends BaseHook {
  constructor (name, events, handler, options = {}) {
    super(name, events, options);
    this.handler = handler;
  }

  async execute (event, context) {
    return this.handler.call(this, event, context);
  }
}

function createTelemetryEngine () {
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
  return { engine, exported };
}

function attr (span, key) {
  return span.attributes?.find((a) => a.key === key)?.value;
}

describe('Agent telemetry', () => {
  it('emits CHAIN → LLM / TOOL / escalation / LLM hierarchy', async () => {
    const { engine, exported } = createTelemetryEngine();
    const registry = new ToolRegistry({
      loggerOptions: { enabled: false },
      telemetryEngine: engine,
    });
    registry.register(new EchoTool());
    registry.register(new OtherTool());

    const adapter = new FakeAdapter([
      {
        text: null,
        functionCalls: [{ name: 'echo', args: { message: 'hi' } }],
        thought: 'Echo first.',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
      {
        text: null,
        functionCalls: [{ name: REQUEST_TOOLS_NAME, args: { reason: 'need other' } }],
        thought: 'Need broader tools.',
        usage: { promptTokens: 20, completionTokens: 8, totalTokens: 28 },
      },
      {
        text: 'done',
        functionCalls: null,
        usage: { promptTokens: 30, completionTokens: 12, totalTokens: 42 },
      },
    ]);

    const agent = new Agent({
      adapter,
      toolRegistry: registry,
      systemInstruction: 'narrow',
      maxToolRounds: 4,
      telemetryEngine: engine,
    });

    const reply = await agent.processMessage('sess-1', 'go', {
      toolNames: ['echo'],
      systemInstruction: 'narrow',
      escalation: {
        toolNames: ['echo', 'other'],
        systemInstruction: 'full',
      },
    });
    assert.strictEqual(reply, 'done');
    await engine.shutdown();

    const chain = exported.find((s) => s.name === 'agent.process_message');
    assert.ok(chain);
    assert.strictEqual(attr(chain, 'openinference.span.kind').stringValue, 'CHAIN');
    assert.strictEqual(attr(chain, 'mcp.session_id').stringValue, 'sess-1');
    assert.strictEqual(attr(chain, 'agent.escalated').boolValue, true);
    assert.strictEqual(attr(chain, 'agent.escalation_reason').stringValue, 'need other');
    assert.strictEqual(attr(chain, 'gen_ai.usage.total_tokens').intValue, '85');

    const llms = exported.filter((s) => s.name === 'gen_ai.generateContent');
    assert.strictEqual(llms.length, 3);
    for (const llm of llms) {
      assert.strictEqual(llm.parentSpanId, chain.spanId);
      assert.strictEqual(attr(llm, 'openinference.span.kind').stringValue, 'LLM');
    }
    assert.strictEqual(attr(llms[0], 'gen_ai.thought').stringValue, 'Echo first.');
    assert.strictEqual(attr(llms[0], 'agent.round').intValue, '0');

    const tool = exported.find((s) => s.name === 'mcp.tool.echo');
    assert.ok(tool);
    assert.strictEqual(tool.parentSpanId, chain.spanId);

    const escalation = exported.find((s) => s.name === 'mcp.tool.request_tools');
    assert.ok(escalation);
    assert.strictEqual(escalation.parentSpanId, chain.spanId);
    assert.strictEqual(attr(escalation, 'openinference.span.kind').stringValue, 'TOOL');
  });

  it('records agent.self_corrections when Stop rejects and retries', async () => {
    const { engine, exported } = createTelemetryEngine();
    const registry = new ToolRegistry({ loggerOptions: { enabled: false } });
    registry.register(new EchoTool());

    const hookRegistry = new HookRegistry();
    let stopCalls = 0;
    hookRegistry.register(new AgentHook('stop', 'Stop', function () {
      stopCalls += 1;
      if (stopCalls === 1) {
        return this.deny('too short');
      }
      return this.allow();
    }));

    const adapter = new FakeAdapter([
      { text: 'short', functionCalls: null },
      { text: 'a longer improved answer', functionCalls: null },
    ]);
    const agent = new Agent({
      adapter,
      toolRegistry: registry,
      systemInstruction: 'test',
      maxToolRounds: 2,
      hookRegistry,
      telemetryEngine: engine,
    });

    const reply = await agent.processMessage('sess-stop', 'write');
    assert.strictEqual(reply, 'a longer improved answer');
    await engine.shutdown();

    const chain = exported.find((s) => s.name === 'agent.process_message');
    assert.ok(chain);
    assert.strictEqual(attr(chain, 'agent.self_corrections').intValue, '1');

    const llms = exported.filter((s) => s.name === 'gen_ai.generateContent');
    assert.strictEqual(llms.length, 2);
  });
});
