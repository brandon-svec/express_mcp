import { assert } from 'chai';
import http from 'http';
import express from 'express';
import request from 'supertest';
import { ExpressMcp, BaseTool } from '../../src/index.js';
import { ModelAdapter } from '../../src/agents/modelAdapter.js';
import { ToolExecution } from '../../src/classes/toolExecution.js';
import { decodeExportTraceServiceRequest } from '../../src/telemetry/otlpProtobuf.js';
import {
  getTestExpressMcpOptions,
  createMcpSession,
  mcpPostWithSession,
  MCP_STREAMABLE_HTTP_ACCEPT,
} from '../config.js';

class HelloTool extends BaseTool {
  constructor() {
    super('hello', 'Says hello');
    this.inputSchema = {
      type: 'object',
      properties: { name: { type: 'string' } },
    };
  }

  async execute(args) {
    return `Hello, ${args?.name || 'World'}`;
  }
}

class BoomTool extends BaseTool {
  constructor() {
    super('boom', 'Always fails');
  }

  async execute() {
    throw new Error('intentional failure');
  }
}

class FakeAdapter extends ModelAdapter {
  constructor(script) {
    super();
    this.script = script;
    this.callIndex = 0;
  }

  async generate() {
    const step = this.script[this.callIndex];
    this.callIndex += 1;
    if (!step) {
      throw new Error('FakeAdapter exhausted');
    }
    return step;
  }
}

/**
 * In-process Proudfield-shaped OTLP/HTTP JSON collector.
 * @returns {Promise<{ url: string, batches: object[], close: () => Promise<void> }>}
 */
async function startCollector() {
  /** @type {object[]} */
  const batches = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.includes('/v1/traces')) {
      res.writeHead(404);
      res.end();
      return;
    }
    const auth = req.headers.authorization;
    if (auth !== 'Bearer collector-key') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Unauthorized' }));
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        batches.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      } catch {
        res.writeHead(400);
        res.end('bad json');
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v1/traces`,
    batches,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function allSpans(batches) {
  const spans = [];
  for (const batch of batches) {
    for (const rs of batch.resourceSpans || []) {
      for (const ss of rs.scopeSpans || []) {
        spans.push(...(ss.spans || []));
      }
    }
  }
  return spans;
}

function attr(span, key) {
  return span.attributes?.find((a) => a.key === key)?.value;
}

describe('Telemetry OTLP integration', () => {
  /** @type {Awaited<ReturnType<typeof startCollector>>} */
  let collector;

  beforeEach(async () => {
    collector = await startCollector();
  });

  afterEach(async () => {
    await collector.close();
  });

  it('exports TOOL span linked to upstream traceparent', async () => {
    const expressMcp = new ExpressMcp(getTestExpressMcpOptions({
      enableKnowledgeBase: false,
      name: 'otlp-int',
      telemetry: {
        enabled: true,
        protocol: 'http/json',
        endpoint: collector.url,
        headers: { Authorization: 'Bearer collector-key' },
        batchMaxSpans: 1,
        batchTimeoutMs: 50,
      },
    }));
    expressMcp.registerTool(new HelloTool());

    const app = express();
    app.use(express.json());
    app.use('/mcp', expressMcp.router());

    const baseAgent = request(app);
    const sessionId = await createMcpSession(baseAgent);

    const response = await mcpPostWithSession(baseAgent, sessionId, '/mcp')
      .set('traceparent', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')
      .send({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: {
          name: 'hello',
          arguments: { name: 'Ada' },
        },
      });

    assert.strictEqual(response.status, 200);
    assert.ok(response.body.result);

    await expressMcp.close();

    const spans = allSpans(collector.batches);
    assert.isAtLeast(spans.length, 1);
    const tool = spans.find((s) => s.name === 'mcp.tool.hello');
    assert.ok(tool);
    assert.strictEqual(tool.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
    assert.strictEqual(tool.parentSpanId, '00f067aa0ba902b7');
    assert.strictEqual(attr(tool, 'openinference.span.kind').stringValue, 'TOOL');
    assert.strictEqual(attr(tool, 'gen_ai.system').stringValue, 'express_mcp');
    assert.strictEqual(attr(tool, 'gen_ai.tool.name').stringValue, 'hello');
  });

  it('exports CHAIN parent and TOOL child from processMessage', async () => {
    const expressMcp = new ExpressMcp(getTestExpressMcpOptions({
      enableKnowledgeBase: false,
      telemetry: {
        enabled: true,
        protocol: 'http/json',
        endpoint: collector.url,
        headers: { Authorization: 'Bearer collector-key' },
        batchMaxSpans: 10,
        batchTimeoutMs: 50,
      },
      agent: {
        enabled: true,
        allowUnauthenticated: true,
        exposeTool: false,
        systemInstruction: 'test',
        maxToolRounds: 4,
        adapter: new FakeAdapter([
          {
            text: null,
            functionCalls: [{ name: 'hello', args: { name: 'from-agent' } }],
            modelParts: [{ functionCall: { name: 'hello', args: { name: 'from-agent' } } }],
          },
          {
            text: 'done',
            functionCalls: null,
            modelParts: [{ text: 'done' }],
          },
        ]),
      },
    }));
    expressMcp.registerTool(new HelloTool());

    const reply = await expressMcp.getAgent().processMessage('hist-1', 'please greet');
    assert.strictEqual(reply, 'done');
    await expressMcp.close();

    const spans = allSpans(collector.batches);
    const chain = spans.find((s) => s.name === 'agent.process_message');
    const tool = spans.find((s) => s.name === 'mcp.tool.hello');
    assert.ok(chain, 'expected CHAIN span');
    assert.ok(tool, 'expected TOOL span');
    assert.strictEqual(attr(chain, 'openinference.span.kind').stringValue, 'CHAIN');
    assert.strictEqual(tool.traceId, chain.traceId);
    assert.strictEqual(tool.parentSpanId, chain.spanId);
  });

  it('exports ERROR status when tool throws but MCP still returns error', async () => {
    const expressMcp = new ExpressMcp(getTestExpressMcpOptions({
      enableKnowledgeBase: false,
      telemetry: {
        enabled: true,
        protocol: 'http/json',
        endpoint: collector.url,
        headers: { Authorization: 'Bearer collector-key' },
        batchMaxSpans: 1,
        batchTimeoutMs: 50,
      },
    }));
    expressMcp.registerTool(new BoomTool());

    const app = express();
    app.use(express.json());
    app.use('/mcp', expressMcp.router());
    const baseAgent = request(app);
    const sessionId = await createMcpSession(baseAgent);

    const response = await mcpPostWithSession(baseAgent, sessionId, '/mcp')
      .set('Accept', MCP_STREAMABLE_HTTP_ACCEPT)
      .send({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: { name: 'boom', arguments: {} },
      });

    // MCP returns JSON-RPC error or isError content — either way request is handled
    assert.strictEqual(response.status, 200);
    assert.ok(response.body.error || response.body.result?.isError);

    await expressMcp.close();
    const spans = allSpans(collector.batches);
    const tool = spans.find((s) => s.name === 'mcp.tool.boom');
    assert.ok(tool);
    assert.strictEqual(tool.status.code, 2);
  });

  it('payload attribute keys would classify as GenAI in Proudfield', async () => {
    const expressMcp = new ExpressMcp(getTestExpressMcpOptions({
      enableKnowledgeBase: false,
      telemetry: {
        enabled: true,
        protocol: 'http/json',
        endpoint: collector.url,
        headers: { Authorization: 'Bearer collector-key' },
        batchMaxSpans: 1,
        batchTimeoutMs: 50,
      },
    }));
    expressMcp.registerTool(new HelloTool());

    await expressMcp.toolRegistry.executeTool(
      'hello',
      { name: 'x' },
      { execution: new ToolExecution('hello', null, { name: 'x' }), meta: {} }
    );
    await expressMcp.close();

    const spans = allSpans(collector.batches);
    assert.isAtLeast(spans.length, 1);
    const keys = spans[0].attributes.map((a) => a.key);
    assert.include(keys, 'openinference.span.kind');
    assert.isTrue(keys.some((k) => k.startsWith('gen_ai.')));
  });
});

describe('OTLP http/protobuf export (integration)', () => {
  /** @type {{ url: string, batches: Buffer[], contentTypes: string[], close: () => Promise<void> }} */
  let collector;

  beforeEach(async () => {
    /** @type {Buffer[]} */
    const batches = [];
    /** @type {string[]} */
    const contentTypes = [];
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST' || !req.url?.includes('/v1/traces')) {
        res.writeHead(404);
        res.end();
        return;
      }
      contentTypes.push(String(req.headers['content-type'] || ''));
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        batches.push(Buffer.concat(chunks));
        res.writeHead(200);
        res.end();
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    collector = {
      url: `http://127.0.0.1:${port}/v1/traces`,
      batches,
      contentTypes,
      close: () => new Promise((resolve) => server.close(resolve)),
    };
  });

  afterEach(async () => {
    await collector.close();
  });

  it('POSTs protobuf body that decodes to TOOL span', async () => {
    const expressMcp = new ExpressMcp(getTestExpressMcpOptions({
      enableKnowledgeBase: false,
      telemetry: {
        enabled: true,
        protocol: 'http/protobuf',
        endpoint: collector.url,
        headers: { Authorization: 'Bearer unused' },
        batchMaxSpans: 1,
        batchTimeoutMs: 50,
      },
    }));
    expressMcp.registerTool(new HelloTool());

    await expressMcp.toolRegistry.executeTool(
      'hello',
      { name: 'Ada' },
      {
        execution: new ToolExecution('hello', null, { name: 'Ada' }),
        meta: {
          traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        },
      }
    );
    await expressMcp.close();

    assert.strictEqual(collector.batches.length, 1);
    assert.include(collector.contentTypes[0], 'application/x-protobuf');
    assert.throws(() => JSON.parse(collector.batches[0].toString('utf8')));

    const decoded = decodeExportTraceServiceRequest(collector.batches[0]);
    const span = decoded.resourceSpans[0].scopeSpans[0].spans[0];
    assert.strictEqual(span.name, 'mcp.tool.hello');
    assert.strictEqual(
      Buffer.from(span.traceId).toString('hex'),
      '4bf92f3577b34da6a3ce929d0e0e4736'
    );
    const kind = span.attributes.find((a) => a.key === 'openinference.span.kind');
    assert.strictEqual(kind.value.stringValue, 'TOOL');
  });
});
