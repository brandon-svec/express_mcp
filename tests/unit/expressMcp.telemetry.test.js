import { assert } from 'chai';
import { ExpressMcp } from '../../src/classes/expressMcp.js';
import { BaseTool } from '../../src/classes/baseTool.js';
import { ToolExecution } from '../../src/classes/toolExecution.js';
import { TEST_CONFIG } from '../config.js';

class HelloTool extends BaseTool {
  constructor() {
    super('hello', 'Says hello');
    this.inputSchema = {
      type: 'object',
      properties: { name: { type: 'string' } },
    };
  }

  async execute(args) {
    if (!args || typeof args.name !== 'string') {
      throw new Error('name is required');
    }
    return `Hello, ${args.name}`;
  }
}

describe('ExpressMcp telemetry', () => {
  it('does not create a telemetry engine when omitted', () => {
    const mcp = new ExpressMcp({
      ...TEST_CONFIG.expressMcpDefaults,
      enableKnowledgeBase: false,
    });
    assert.isNull(mcp.telemetryEngine);
  });

  it('throws when enabled without protocol', () => {
    assert.throws(
      () => new ExpressMcp({
        ...TEST_CONFIG.expressMcpDefaults,
        enableKnowledgeBase: false,
        telemetry: { enabled: true, endpoint: 'http://127.0.0.1:9/v1/traces' },
      }),
      /telemetry\.protocol is required/
    );
  });

  it('throws when enabled without endpoint', () => {
    assert.throws(
      () => new ExpressMcp({
        ...TEST_CONFIG.expressMcpDefaults,
        enableKnowledgeBase: false,
        telemetry: { enabled: true, protocol: 'http/json' },
      }),
      /endpoint is required/
    );
  });

  it('starts telemetry engine when enabled; close is fail-open', async () => {
    const mcp = new ExpressMcp({
      ...TEST_CONFIG.expressMcpDefaults,
      name: 'tele-test',
      enableKnowledgeBase: false,
      telemetry: {
        enabled: true,
        protocol: 'http/json',
        endpoint: 'http://127.0.0.1:9/v1/traces',
        batchMaxSpans: 1,
        batchTimeoutMs: 60_000,
        maxRetries: 0,
        requestTimeoutMs: 200,
      },
    });
    assert.ok(mcp.telemetryEngine);

    mcp.registerTool(new HelloTool());
    const execution = await mcp.toolRegistry.executeTool(
      'hello',
      { name: 'Ada' },
      {
        execution: new ToolExecution('hello', null, { name: 'Ada' }),
        user: { sub: 'u1' },
        sessionId: 's1',
        meta: {
          traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        },
      }
    );
    assert.strictEqual(execution.status, 'success');

    await mcp.close();
  });
});
