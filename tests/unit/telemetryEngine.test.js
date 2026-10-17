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

function attr(span, key) {
  if (!span || !Array.isArray(span.attributes)) {
    throw new Error('span.attributes is required');
  }
  const found = span.attributes.find((a) => a.key === key);
  if (!found) {
    throw new Error(`missing attribute ${key} on ${span.name}`);
  }
  return found.value;
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
    assert.strictEqual(attr(otlp, 'openinference.span.kind').stringValue, 'TOOL');
    assert.strictEqual(attr(otlp, 'user.id').stringValue, 'gh:1');
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
      sessionId: 'sess-a',
    });
    assert.strictEqual(agent.name, 'agent.process_message');
    assert.strictEqual(agent.attributes['openinference.span.kind'], 'CHAIN');
    assert.strictEqual(agent.attributes['mcp.session_id'], 'sess-a');

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

  it('creates LLM spans with tokens and thought when present', async () => {
    const { engine, exported } = createEngine();
    const agent = engine.startAgentSpan({
      prompt: 'hi',
      genAiSystem: 'gemini',
      sessionId: 'sess-1',
    });
    const llm = engine.startLlmSpan({
      traceparent: agent.traceparent,
      genAiSystem: 'gemini',
      model: 'gemini-2.5-flash',
      round: 0,
      sessionId: 'sess-1',
    });
    assert.strictEqual(llm.name, 'gen_ai.generateContent');
    assert.strictEqual(llm.attributes['openinference.span.kind'], 'LLM');
    assert.strictEqual(llm.parentSpanId, agent.spanId);

    engine.endLlmSpan(llm, {
      usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
      thought: 'Searching knowledge base.',
      output: { functionCalls: [{ name: 'kb_search', args: { q: 'x' } }] },
    });
    engine.endAgentSpan(agent, {
      output: 'done',
      rounds: 1,
      promptTokens: 10,
      completionTokens: 4,
      totalTokens: 14,
    });
    await engine.shutdown();

    const llmOut = exported.find((s) => s.name === 'gen_ai.generateContent');
    assert.ok(llmOut);
    assert.strictEqual(attr(llmOut, 'gen_ai.usage.input_tokens').intValue, '10');
    assert.strictEqual(attr(llmOut, 'gen_ai.thought').stringValue, 'Searching knowledge base.');
    const chain = exported.find((s) => s.name === 'agent.process_message');
    assert.strictEqual(attr(chain, 'gen_ai.usage.total_tokens').intValue, '14');
  });

  it('omits thought and output.value when captureResults is false', async () => {
    const { engine, exported } = createEngine({ captureResults: false });
    const agent = engine.startAgentSpan({ prompt: 'hi' });
    const llm = engine.startLlmSpan({
      traceparent: agent.traceparent,
      round: 0,
    });
    engine.endLlmSpan(llm, {
      usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 },
      thought: 'should not appear',
      output: 'reply',
    });
    engine.endAgentSpan(agent, { output: 'done', rounds: 0 });
    await engine.shutdown();

    const llmOut = exported.find((s) => s.name === 'gen_ai.generateContent');
    assert.ok(llmOut);
    assert.isUndefined(llmOut.attributes.find((a) => a.key === 'gen_ai.thought'));
    assert.isUndefined(llmOut.attributes.find((a) => a.key === 'output.value'));
    assert.strictEqual(attr(llmOut, 'gen_ai.usage.input_tokens').intValue, '3');
  });

  it('omits usage token attributes when usage is absent', async () => {
    const { engine, exported } = createEngine();
    const agent = engine.startAgentSpan({ prompt: 'hi' });
    const llm = engine.startLlmSpan({
      traceparent: agent.traceparent,
      round: 0,
    });
    engine.endLlmSpan(llm, { output: 'reply' });
    engine.endAgentSpan(agent, { output: 'done', rounds: 0 });
    await engine.shutdown();

    const llmOut = exported.find((s) => s.name === 'gen_ai.generateContent');
    assert.ok(llmOut);
    assert.isUndefined(llmOut.attributes.find((a) => a.key === 'gen_ai.usage.input_tokens'));
    assert.isUndefined(llmOut.attributes.find((a) => a.key === 'gen_ai.usage.output_tokens'));
    assert.isUndefined(llmOut.attributes.find((a) => a.key === 'gen_ai.usage.total_tokens'));
  });

  it('startLlmSpan records contents and systemInstruction when captureParameters is on', async () => {
    const { engine, exported } = createEngine();
    const agent = engine.startAgentSpan({ prompt: 'raw' });
    const contents = [
      { role: 'user', parts: [{ text: 'PREFIX\nhello' }] },
    ];
    const llm = engine.startLlmSpan({
      traceparent: agent.traceparent,
      round: 0,
      contents,
      systemInstruction: 'You are helpful.',
    });
    assert.deepStrictEqual(JSON.parse(llm.attributes['input.value']), contents);
    assert.strictEqual(llm.attributes['gen_ai.system_instruction'], 'You are helpful.');

    engine.endLlmSpan(llm, { output: 'ok' });
    engine.endAgentSpan(agent, { output: 'ok', rounds: 0 });
    await engine.shutdown();

    const llmOut = exported.find((s) => s.name === 'gen_ai.generateContent');
    assert.deepStrictEqual(JSON.parse(attr(llmOut, 'input.value').stringValue), contents);
    assert.strictEqual(attr(llmOut, 'gen_ai.system_instruction').stringValue, 'You are helpful.');
  });

  it('startLlmSpan omits input.value and system_instruction when captureParameters is false', async () => {
    const { engine, exported } = createEngine({ captureParameters: false });
    const agent = engine.startAgentSpan({ prompt: 'raw' });
    const llm = engine.startLlmSpan({
      traceparent: agent.traceparent,
      round: 0,
      contents: [{ role: 'user', parts: [{ text: 'secret' }] }],
      systemInstruction: 'hidden',
    });
    assert.isUndefined(llm.attributes['input.value']);
    assert.isUndefined(llm.attributes['gen_ai.system_instruction']);

    engine.endLlmSpan(llm, { output: 'ok' });
    engine.endAgentSpan(agent, { output: 'ok', rounds: 0 });
    await engine.shutdown();

    const llmOut = exported.find((s) => s.name === 'gen_ai.generateContent');
    assert.isUndefined(llmOut.attributes.find((a) => a.key === 'input.value'));
    assert.isUndefined(llmOut.attributes.find((a) => a.key === 'gen_ai.system_instruction'));
  });

  it('setSpanInput overwrites CHAIN input.value when captureParameters is on', () => {
    const { engine } = createEngine();
    const agent = engine.startAgentSpan({ prompt: 'raw' });
    assert.strictEqual(agent.attributes['input.value'], 'raw');
    const assembled = [
      { role: 'user', parts: [{ text: 'PREFIX\nraw' }] },
    ];
    engine.setSpanInput(agent, assembled);
    assert.deepStrictEqual(JSON.parse(agent.attributes['input.value']), assembled);
  });

  it('setSpanInput is a no-op when captureParameters is false', () => {
    const { engine } = createEngine({ captureParameters: false });
    const agent = engine.startAgentSpan({ prompt: 'raw' });
    assert.isUndefined(agent.attributes['input.value']);
    engine.setSpanInput(agent, [{ role: 'user', parts: [{ text: 'x' }] }]);
    assert.isUndefined(agent.attributes['input.value']);
  });

  it('recordEscalation emits TOOL child and annotates CHAIN parent', async () => {
    const { engine, exported } = createEngine();
    const agent = engine.startAgentSpan({
      prompt: 'hi',
      sessionId: 'sess-e',
    });
    engine.recordEscalation(agent, {
      reason: 'need filesystem',
      grantedTools: ['fs_read'],
      round: 1,
      sessionId: 'sess-e',
    });
    assert.strictEqual(agent.attributes['agent.escalated'], true);
    assert.strictEqual(agent.attributes['agent.escalation_reason'], 'need filesystem');

    engine.endAgentSpan(agent, {
      output: 'done',
      rounds: 2,
      selfCorrections: 1,
    });
    await engine.shutdown();

    const esc = exported.find((s) => s.name === 'mcp.tool.request_tools');
    assert.ok(esc);
    assert.strictEqual(esc.parentSpanId, agent.spanId);
    assert.strictEqual(attr(esc, 'openinference.span.kind').stringValue, 'TOOL');
    const chain = exported.find((s) => s.name === 'agent.process_message');
    assert.strictEqual(attr(chain, 'agent.escalated').boolValue, true);
    assert.strictEqual(attr(chain, 'agent.self_corrections').intValue, '1');
  });
});
