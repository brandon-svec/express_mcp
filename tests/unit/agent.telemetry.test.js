import { assert } from 'chai';
import { Agent, REQUEST_TOOLS_NAME } from '../../src/agents/agent.js';
import { ModelAdapter } from '../../src/agents/modelAdapter.js';
import { InMemoryHistoryStore } from '../../src/agents/historyStore.js';
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
    this.generateParams = [];
  }

  async generate (params) {
    this.generateParams.push(params);
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
  if (!span || !Array.isArray(span.attributes)) {
    throw new Error('span.attributes is required');
  }
  const found = span.attributes.find((a) => a.key === key);
  if (!found) {
    throw new Error(`missing attribute ${key} on ${span.name}`);
  }
  return found.value;
}

describe('Agent telemetry', () => {
  it('emits CHAIN → LLM / TOOL / escalation / LLM hierarchy', async () => {
    const { engine, exported } = createTelemetryEngine();
    const registry = new ToolRegistry({
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

    assert.deepStrictEqual(exported.map((s) => s.name), [
      'gen_ai.generateContent',
      'mcp.tool.echo',
      'gen_ai.generateContent',
      'mcp.tool.request_tools',
      'gen_ai.generateContent',
      'agent.process_message',
    ]);

    const chain = exported[5];
    assert.strictEqual(attr(chain, 'openinference.span.kind').stringValue, 'CHAIN');
    assert.strictEqual(attr(chain, 'mcp.session_id').stringValue, 'sess-1');
    assert.strictEqual(attr(chain, 'agent.escalated').boolValue, true);
    assert.strictEqual(attr(chain, 'agent.escalation_reason').stringValue, 'need other');
    assert.strictEqual(attr(chain, 'gen_ai.usage.total_tokens').intValue, '85');

    const [llm0, tool, llm1, escalation, llm2] = exported;
    for (const child of [llm0, tool, llm1, escalation, llm2]) {
      assert.strictEqual(child.parentSpanId, chain.spanId);
    }
    assert.strictEqual(attr(llm0, 'openinference.span.kind').stringValue, 'LLM');
    assert.strictEqual(attr(llm0, 'gen_ai.thought').stringValue, 'Echo first.');
    assert.strictEqual(attr(llm0, 'agent.round').intValue, '0');
    assert.strictEqual(attr(llm1, 'agent.round').intValue, '1');
    assert.strictEqual(attr(llm2, 'agent.round').intValue, '2');
    assert.strictEqual(attr(escalation, 'openinference.span.kind').stringValue, 'TOOL');

    const expectedRound0 = [{ role: 'user', parts: [{ text: 'go' }] }];
    assert.deepStrictEqual(JSON.parse(attr(chain, 'input.value').stringValue), expectedRound0);
    assert.deepStrictEqual(JSON.parse(attr(llm0, 'input.value').stringValue), expectedRound0);
    assert.match(attr(llm0, 'gen_ai.system_instruction').stringValue, /^narrow\n\nMCP CAPABILITIES/);
    assert.match(attr(llm0, 'gen_ai.system_instruction').stringValue, /AVAILABLE/);
    assert.match(attr(llm2, 'gen_ai.system_instruction').stringValue, /^full\n\nMCP CAPABILITIES/);
    assert.isFalse(/AVAILABLE/.test(attr(llm2, 'gen_ai.system_instruction').stringValue));
  });

  it('records ephemeralPrefix and prior history on CHAIN and LLM input.value', async () => {
    const { engine, exported } = createTelemetryEngine();
    const history = new InMemoryHistoryStore({ windowMinutes: 60 });
    const registry = new ToolRegistry({ telemetryEngine: engine });
    registry.register(new EchoTool());

    const prefix = 'CURRENT_CONTEXT\nstay: home\nUSER_MESSAGE\n';
    const adapter = new FakeAdapter([
      { text: 'first', functionCalls: null },
      {
        text: null,
        functionCalls: [{ name: 'echo', args: { message: 'hi' } }],
      },
      { text: 'second', functionCalls: null },
    ]);
    const agent = new Agent({
      adapter,
      toolRegistry: registry,
      systemInstruction: 'test',
      history,
      maxToolRounds: 4,
      telemetryEngine: engine,
    });

    await agent.processMessage('chat:1', 'hello', { ephemeralPrefix: prefix });
    await agent.processMessage('chat:1', 'again', {
      ephemeralPrefix: prefix,
      toolNames: ['echo'],
    });
    await engine.shutdown();

    const chains = exported.filter((s) => s.name === 'agent.process_message');
    assert.strictEqual(chains.length, 2);

    const turn1Expected = [
      { role: 'user', parts: [{ text: `${prefix}hello` }] },
    ];
    assert.deepStrictEqual(
      JSON.parse(attr(chains[0], 'input.value').stringValue),
      turn1Expected,
    );

    const turn2Round0Expected = [
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ text: 'first' }] },
      { role: 'user', parts: [{ text: `${prefix}again` }] },
    ];
    assert.deepStrictEqual(
      JSON.parse(attr(chains[1], 'input.value').stringValue),
      turn2Round0Expected,
    );

    const turn2Llms = exported.filter(
      (s) => s.name === 'gen_ai.generateContent' && s.parentSpanId === chains[1].spanId,
    );
    assert.strictEqual(turn2Llms.length, 2);
    assert.deepStrictEqual(
      JSON.parse(attr(turn2Llms[0], 'input.value').stringValue),
      turn2Round0Expected,
    );
    const turn2Round1Expected = [
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ text: 'first' }] },
      { role: 'user', parts: [{ text: `${prefix}again` }] },
      {
        role: 'model',
        parts: [{ functionCall: { name: 'echo', args: { message: 'hi' } } }],
      },
      {
        role: 'user',
        parts: [{
          functionResponse: {
            name: 'echo',
            response: { result: { echoed: 'hi' } },
          },
        }],
      },
    ];
    assert.deepStrictEqual(
      JSON.parse(attr(turn2Llms[1], 'input.value').stringValue),
      turn2Round1Expected,
    );
    assert.deepStrictEqual(adapter.generateParams[2].contents, turn2Round1Expected);
  });

  it('records agent.self_corrections when Stop rejects and retries', async () => {
    const { engine, exported } = createTelemetryEngine();
    const registry = new ToolRegistry();
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
