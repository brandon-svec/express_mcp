import { assert } from 'chai';
import { TelemetryEngine } from '../../src/telemetry/telemetryEngine.js';
import { normalizeTelemetryConfig } from '../../src/telemetry/normalizeTelemetryConfig.js';
import { parseTraceparent } from '../../src/telemetry/traceContext.js';

function createEngine(overrides = {}) {
  /** @type {object[]} */
  const exported = [];
  const config = normalizeTelemetryConfig({
    enabled: true,
    protocol: 'http/json',
    endpoint: 'http://127.0.0.1:9/v1/traces',
    batchMaxSpans: 100,
    batchTimeoutMs: 60_000,
    ...overrides,
  });
  const sender = {
    send: async (spans) => {
      exported.push(...spans);
    },
    destroy() {},
  };
  const engine = new TelemetryEngine({
    config,
    packageVersion: '0.0.0-test',
    sender,
  });
  return { engine, exported, config };
}

describe('TelemetryEngine', () => {
  it('creates TOOL spans with GenAI attributes and parent from traceparent', async () => {
    const { engine, exported } = createEngine();
    const parent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const span = engine.startToolSpan({
      toolName: 'hello',
      sessionId: 'sess-1',
      traceparent: parent,
      user: { sub: 'gh:1' },
      args: { name: 'Ada', password: 'secret' },
    });
    assert.ok(span);
    assert.strictEqual(span.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
    assert.strictEqual(span.parentSpanId, '00f067aa0ba902b7');
    assert.strictEqual(span.name, 'mcp.tool.hello');
    assert.include(span.attributes['input.value'], '[REDACTED]');
    assert.notInclude(span.attributes['input.value'], 'secret');

    engine.endToolSpan(span, {
      status: 'success',
      result: { ok: true },
      durationMs: 5,
    });
    await engine.shutdown();

    assert.strictEqual(exported.length, 1);
    const otlp = exported[0];
    assert.strictEqual(otlp.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
    assert.strictEqual(otlp.parentSpanId, '00f067aa0ba902b7');
    assert.strictEqual(otlp.status.code, 1);
    const kind = otlp.attributes.find((a) => a.key === 'openinference.span.kind');
    assert.strictEqual(kind.value.stringValue, 'TOOL');
    const userId = otlp.attributes.find((a) => a.key === 'user.id');
    assert.strictEqual(userId.value.stringValue, 'gh:1');
  });

  it('omits input/output when capture flags are false', async () => {
    const { engine, exported } = createEngine({
      captureParameters: false,
      captureResults: false,
    });
    const span = engine.startToolSpan({
      toolName: 'hello',
      args: { a: 1 },
    });
    assert.isUndefined(span.attributes['input.value']);
    engine.endToolSpan(span, { status: 'success', result: { b: 2 }, durationMs: 1 });
    await engine.shutdown();
    assert.isUndefined(
      exported[0].attributes.find((a) => a.key === 'input.value')
    );
    assert.isUndefined(
      exported[0].attributes.find((a) => a.key === 'output.value')
    );
  });

  it('marks error TOOL spans with status ERROR', async () => {
    const { engine, exported } = createEngine();
    const span = engine.startToolSpan({ toolName: 'boom' });
    engine.endToolSpan(span, {
      status: 'error',
      errorData: { error: 'Tool execution failed', errorCode: -32603 },
      durationMs: 2,
    });
    await engine.shutdown();
    assert.strictEqual(exported[0].status.code, 2);
    const code = exported[0].attributes.find((a) => a.key === 'error.code');
    assert.strictEqual(code.value.intValue, '-32603');
  });

  it('nests TOOL under CHAIN via agent span traceparent', async () => {
    const { engine, exported } = createEngine();
    const agent = engine.startAgentSpan({
      prompt: 'hi',
      genAiSystem: 'gemini',
    });
    assert.strictEqual(agent.name, 'agent.process_message');
    assert.strictEqual(agent.attributes['openinference.span.kind'], 'CHAIN');

    const child = engine.startToolSpan({
      toolName: 'kb_search',
      traceparent: agent.traceparent,
      args: { q: 'x' },
    });
    assert.strictEqual(child.traceId, agent.traceId);
    assert.strictEqual(child.parentSpanId, agent.spanId);

    const parsed = parseTraceparent(agent.traceparent);
    assert.strictEqual(parsed.spanId, agent.spanId);

    engine.endToolSpan(child, { status: 'success', result: [], durationMs: 1 });
    engine.endAgentSpan(agent, { output: 'done', rounds: 1 });
    await engine.shutdown();

    assert.strictEqual(exported.length, 2);
    const chain = exported.find((s) => s.name === 'agent.process_message');
    const tool = exported.find((s) => s.name === 'mcp.tool.kb_search');
    assert.ok(chain);
    assert.ok(tool);
    assert.strictEqual(tool.parentSpanId, chain.spanId);
  });
});
