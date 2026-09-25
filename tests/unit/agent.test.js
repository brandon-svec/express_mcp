import { assert } from 'chai';
import { Agent, REQUEST_TOOLS_NAME, canonicalizeValue, scrubRequestToolsFromContents } from '../../src/agents/agent.js';
import { ModelAdapter } from '../../src/agents/modelAdapter.js';
import { InMemoryHistoryStore } from '../../src/agents/historyStore.js';
import { ToolRegistry } from '../../src/classes/toolRegistry.js';
import { BaseTool } from '../../src/classes/baseTool.js';

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

const ECHO_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    message: { type: 'string' },
  },
  required: ['message'],
  additionalProperties: false,
};

const ECHO_TOOL_DECLARATION = canonicalizeValue({
  name: 'echo',
  description: 'Echo tool',
  parameters: ECHO_INPUT_SCHEMA,
});

class EchoTool extends BaseTool {
  constructor () {
    super('echo', 'Echo tool', ECHO_INPUT_SCHEMA);
  }

  async execute (args) {
    return { echoed: args.message };
  }
}

/**
 * @param {() => unknown | Promise<unknown>} fn
 * @param {string} expectedMessage
 */
async function assertRejectsWithMessage (fn, expectedMessage) {
  let caught;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  assert.deepStrictEqual(
    {
      message: caught instanceof Error ? caught.message : caught,
    },
    {
      message: expectedMessage,
    },
  );
}

describe('Agent', () => {
  let registry;

  beforeEach(() => {
    registry = new ToolRegistry({ loggerOptions: { enabled: false } });
    registry.register(new EchoTool());
  });

  it('runs tool loop and returns final text', async () => {
    const adapter = new FakeAdapter([
      { text: null, functionCalls: [{ name: 'echo', args: { message: 'hi' } }] },
      { text: 'done', functionCalls: null },
    ]);
    const agent = new Agent({
      adapter,
      toolRegistry: registry,
      systemInstruction: 'test',
      maxToolRounds: 8,
    });

    const reply = await agent.processMessage('user:1', 'say hi');
    assert.strictEqual(reply, 'done');
    assert.strictEqual(adapter.callIndex, 2);
  });

  it('excludes tools from declarations and rejects excluded calls', async () => {
    const adapter = new FakeAdapter([
      { text: null, functionCalls: [{ name: 'agent_ask', args: { prompt: 'x' } }] },
    ]);
    const agent = new Agent({
      adapter,
      toolRegistry: registry,
      systemInstruction: 'test',
      maxToolRounds: 8,
      excludeTools: ['agent_ask'],
    });

    const declarations = agent.buildToolDeclarations();
    assert.isFalse(declarations.some((d) => d.name === 'agent_ask'));

    try {
      await agent.processMessage('k', 'go');
      assert.fail('expected processMessage to throw');
    } catch (err) {
      assert.match(err.message, /Tool is not available to the agent: agent_ask/);
    }
  });

  it('throws when max tool rounds exceeded without final text', async () => {
    const adapter = new FakeAdapter([
      { text: null, functionCalls: [{ name: 'echo', args: { message: 'a' } }] },
      { text: null, functionCalls: [{ name: 'echo', args: { message: 'b' } }] },
    ]);
    const agent = new Agent({
      adapter,
      toolRegistry: registry,
      systemInstruction: 'test',
      maxToolRounds: 1,
    });

    try {
      await agent.processMessage('k', 'loop');
      assert.fail('expected processMessage to throw');
    } catch (err) {
      assert.match(err.message, /Model returned empty response/);
    }
  });

  it('returns unknown tool errors as functionResponse and continues', async () => {
    const adapter = new FakeAdapter([
      { text: null, functionCalls: [{ name: 'missing_tool', args: {} }] },
      { text: 'sorry, that tool is unavailable', functionCalls: null },
    ]);
    const agent = new Agent({
      adapter,
      toolRegistry: registry,
      systemInstruction: 'test',
      maxToolRounds: 8,
    });

    const reply = await agent.processMessage('k', 'x');

    assert.deepStrictEqual({
      reply,
      callIndex: adapter.callIndex,
      functionResponse: adapter.generateParams[1].contents.find((entry) => (
        entry.role === 'user' &&
        entry.parts[0] &&
        entry.parts[0].functionResponse
      )).parts[0].functionResponse,
    }, {
      reply: 'sorry, that tool is unavailable',
      callIndex: 2,
      functionResponse: {
        name: 'missing_tool',
        response: {
          ok: false,
          error: "Tool 'missing_tool' not found",
        },
      },
    });
  });

  it('returns schema validation errors as functionResponse and retries', async () => {
    const adapter = new FakeAdapter([
      { text: null, functionCalls: [{ name: 'echo', args: {} }] },
      { text: null, functionCalls: [{ name: 'echo', args: { message: 'hi' } }] },
      { text: 'done', functionCalls: null },
    ]);
    const agent = new Agent({
      adapter,
      toolRegistry: registry,
      systemInstruction: 'test',
      maxToolRounds: 8,
    });

    const reply = await agent.processMessage('user:1', 'say hi');
    const functionResponses = adapter.generateParams[2].contents
      .filter((entry) => (
        entry.role === 'user' &&
        entry.parts[0] &&
        entry.parts[0].functionResponse
      ))
      .map((entry) => entry.parts[0].functionResponse);

    assert.deepStrictEqual({
      reply,
      callIndex: adapter.callIndex,
      functionResponses,
    }, {
      reply: 'done',
      callIndex: 3,
      functionResponses: [
        {
          name: 'echo',
          response: {
            ok: false,
            error: "Validation failed: must have required property 'message'",
          },
        },
        {
          name: 'echo',
          response: { result: { echoed: 'hi' } },
        },
      ],
    });
  });

  it('logs tool call and processMessage dispositions across rounds', async () => {
    const infoCalls = [];
    const logger = {
      info (attrs, msg) {
        infoCalls.push({ attrs, msg });
      },
    };
    const adapter = new FakeAdapter([
      { text: null, functionCalls: [{ name: 'echo', args: {} }] },
      { text: null, functionCalls: [{ name: 'echo', args: { message: 'hi' } }] },
      { text: 'done', functionCalls: null },
    ]);
    const agent = new Agent({
      adapter,
      toolRegistry: registry,
      systemInstruction: 'test',
      maxToolRounds: 8,
      logger,
    });

    await agent.processMessage('user:1', 'say hi');

    assert.deepStrictEqual(infoCalls.slice(0, 2), [
      {
        attrs: {
          round: 0,
          toolName: 'echo',
          status: 'error',
          argKeys: [],
          error: "Validation failed: must have required property 'message'",
        },
        msg: 'Agent tool call completed',
      },
      {
        attrs: {
          round: 1,
          toolName: 'echo',
          status: 'success',
          argKeys: ['message'],
        },
        msg: 'Agent tool call completed',
      },
    ]);
    assert.deepStrictEqual(infoCalls[2].msg, 'Agent processMessage completed');
    assert.deepStrictEqual(
      {
        rounds: infoCalls[2].attrs.rounds,
        toolCalls: infoCalls[2].attrs.toolCalls,
        errorCalls: infoCalls[2].attrs.errorCalls,
        historyTurns: infoCalls[2].attrs.historyTurns,
        escalated: infoCalls[2].attrs.escalated,
        toolCount: infoCalls[2].attrs.toolCount,
      },
      {
        rounds: 2,
        toolCalls: 2,
        errorCalls: 1,
        historyTurns: 0,
        escalated: false,
        toolCount: 1,
      },
    );
    assert.strictEqual(typeof infoCalls[2].attrs.contentsChars, 'number');
    assert.strictEqual(typeof infoCalls[2].attrs.systemInstructionChars, 'number');
    assert.strictEqual(typeof infoCalls[2].attrs.toolDeclarationChars, 'number');
  });

  it('traces each generate request with sizes breakdown', async () => {
    const traceCalls = [];
    const logger = {
      info () {},
      trace (attrs, msg) {
        traceCalls.push({ attrs, msg });
      },
    };
    const adapter = new FakeAdapter([
      { text: null, functionCalls: [{ name: 'echo', args: { message: 'hi' } }] },
      { text: 'done', functionCalls: null },
    ]);
    const agent = new Agent({
      adapter,
      toolRegistry: registry,
      systemInstruction: 'sys',
      maxToolRounds: 8,
      logger,
    });

    await agent.processMessage('user:1', 'say hi');

    assert.strictEqual(traceCalls.length, 2);
    assert.deepStrictEqual(
      {
        msg0: traceCalls[0].msg,
        msg1: traceCalls[1].msg,
        round0: traceCalls[0].attrs.round,
        round1: traceCalls[1].attrs.round,
        historyTurns: traceCalls[0].attrs.historyTurns,
        systemInstruction: traceCalls[0].attrs.systemInstruction,
        toolDeclarations: traceCalls[0].attrs.toolDeclarations,
        firstContent: traceCalls[0].attrs.contents[0],
        sizes0: {
          systemInstructionChars: traceCalls[0].attrs.sizes.systemInstructionChars,
          toolCount: traceCalls[0].attrs.sizes.toolCount,
          byContent: traceCalls[0].attrs.sizes.byContent,
        },
      },
      {
        msg0: 'Agent model generate request',
        msg1: 'Agent model generate request',
        round0: 0,
        round1: 1,
        historyTurns: 0,
        systemInstruction: 'sys',
        toolDeclarations: [ECHO_TOOL_DECLARATION],
        firstContent: { role: 'user', parts: [{ text: 'say hi' }] },
        sizes0: {
          systemInstructionChars: 3,
          toolCount: 1,
          byContent: [{
            index: 0,
            role: 'user',
            partKinds: ['text'],
            chars: JSON.stringify({ role: 'user', parts: [{ text: 'say hi' }] }).length,
          }],
        },
      },
    );
  });

  it('sends ephemeralPrefix to the model but stores only the raw user text', async () => {
    const history = new InMemoryHistoryStore({ windowMinutes: 60 });
    const adapter = new FakeAdapter([
      { text: 'first', functionCalls: null },
      { text: 'second', functionCalls: null },
    ]);
    const agent = new Agent({
      adapter,
      toolRegistry: registry,
      systemInstruction: 'test',
      history,
      maxToolRounds: 8,
    });
    const prefix = 'CURRENT_CONTEXT\nstay: home\nUSER_MESSAGE\n';

    await agent.processMessage('chat:1', 'hello', { ephemeralPrefix: prefix });
    await agent.processMessage('chat:1', 'again', { ephemeralPrefix: prefix });

    assert.deepStrictEqual({
      firstGenerate: adapter.generateParams[0].contents,
      secondGenerate: adapter.generateParams[1].contents,
      stored: history.get('chat:1'),
    }, {
      firstGenerate: [
        { role: 'user', parts: [{ text: `${prefix}hello` }] },
      ],
      secondGenerate: [
        { role: 'user', parts: [{ text: 'hello' }] },
        { role: 'model', parts: [{ text: 'first' }] },
        { role: 'user', parts: [{ text: `${prefix}again` }] },
      ],
      stored: [
        { role: 'user', parts: [{ text: 'hello' }] },
        { role: 'model', parts: [{ text: 'first' }] },
        { role: 'user', parts: [{ text: 'again' }] },
        { role: 'model', parts: [{ text: 'second' }] },
      ],
    });
  });

  it('keeps ephemeralPrefix on in-turn tool-loop generate calls', async () => {
    const history = new InMemoryHistoryStore({ windowMinutes: 60 });
    const adapter = new FakeAdapter([
      { text: null, functionCalls: [{ name: 'echo', args: { message: 'hi' } }] },
      { text: 'done', functionCalls: null },
    ]);
    const agent = new Agent({
      adapter,
      toolRegistry: registry,
      systemInstruction: 'test',
      history,
      maxToolRounds: 8,
    });
    const prefix = 'PREFIX\n';

    await agent.processMessage('chat:1', 'do it', { ephemeralPrefix: prefix });

    assert.deepStrictEqual(
      adapter.generateParams.map((params) => params.contents[0]),
      [
        { role: 'user', parts: [{ text: `${prefix}do it` }] },
        { role: 'user', parts: [{ text: `${prefix}do it` }] },
      ],
    );
    assert.deepStrictEqual(history.get('chat:1')[0], {
      role: 'user',
      parts: [{ text: 'do it' }],
    });
  });

  it('throws when ephemeralPrefix is empty', async () => {
    const agent = new Agent({
      adapter: new FakeAdapter([]),
      toolRegistry: registry,
      systemInstruction: 'test',
      maxToolRounds: 8,
    });

    await assertRejectsWithMessage(
      () => agent.processMessage('k', 'hello', { ephemeralPrefix: '' }),
      'ephemeralPrefix must be a non-empty string when provided',
    );
  });

  it('historyToolTurns omit stores only user text and final reply', async () => {
    const history = new InMemoryHistoryStore({ windowMinutes: 60 });
    const adapter = new FakeAdapter([
      { text: null, functionCalls: [{ name: 'echo', args: { message: 'hi' } }] },
      { text: 'done', functionCalls: null },
      { text: 'next', functionCalls: null },
    ]);
    const agent = new Agent({
      adapter,
      toolRegistry: registry,
      systemInstruction: 'test',
      history,
      maxToolRounds: 8,
      historyToolTurns: 'omit',
    });

    await agent.processMessage('chat:1', 'first');
    await agent.processMessage('chat:1', 'second');

    assert.deepStrictEqual({
      stored: history.get('chat:1'),
      secondGeneratePrior: adapter.generateParams[2].contents.slice(0, 2),
      secondGenerateHasFunctionResponse: adapter.generateParams[2].contents.some((entry) => (
        entry.parts && entry.parts[0] && entry.parts[0].functionResponse
      )),
    }, {
      stored: [
        { role: 'user', parts: [{ text: 'first' }] },
        { role: 'model', parts: [{ text: 'done' }] },
        { role: 'user', parts: [{ text: 'second' }] },
        { role: 'model', parts: [{ text: 'next' }] },
      ],
      secondGeneratePrior: [
        { role: 'user', parts: [{ text: 'first' }] },
        { role: 'model', parts: [{ text: 'done' }] },
      ],
      secondGenerateHasFunctionResponse: false,
    });
  });

  it('historyToolTurns full keeps tool parts in stored history', async () => {
    const history = new InMemoryHistoryStore({ windowMinutes: 60 });
    const adapter = new FakeAdapter([
      { text: null, functionCalls: [{ name: 'echo', args: { message: 'hi' } }] },
      { text: 'done', functionCalls: null },
    ]);
    const agent = new Agent({
      adapter,
      toolRegistry: registry,
      systemInstruction: 'test',
      history,
      maxToolRounds: 8,
      historyToolTurns: 'full',
    });

    await agent.processMessage('chat:1', 'first');

    assert.deepStrictEqual(history.get('chat:1'), [
      { role: 'user', parts: [{ text: 'first' }] },
      { role: 'model', parts: [{ functionCall: { name: 'echo', args: { message: 'hi' } } }] },
      {
        role: 'user',
        parts: [{
          functionResponse: {
            name: 'echo',
            response: { result: { echoed: 'hi' } },
          },
        }],
      },
      { role: 'model', parts: [{ text: 'done' }] },
    ]);
  });

  it('throws for invalid historyToolTurns', () => {
    assert.throws(
      () => new Agent({
        adapter: new FakeAdapter([]),
        toolRegistry: registry,
        systemInstruction: 'test',
        maxToolRounds: 8,
        historyToolTurns: 'trim',
      }),
      /Invalid historyToolTurns: trim/,
    );
  });

  it('throws when adapter is missing', () => {
    assert.throws(
      () => new Agent({
        toolRegistry: registry,
        systemInstruction: 'test',
        maxToolRounds: 8,
      }),
      /adapter is required/,
    );
  });

  it('throws when toolRegistry is missing', () => {
    assert.throws(
      () => new Agent({
        adapter: new FakeAdapter([]),
        systemInstruction: 'test',
        maxToolRounds: 8,
      }),
      /toolRegistry is required/,
    );
  });

  it('throws when systemInstruction is empty', () => {
    assert.throws(
      () => new Agent({
        adapter: new FakeAdapter([]),
        toolRegistry: registry,
        systemInstruction: '   ',
        maxToolRounds: 8,
      }),
      /systemInstruction is required/,
    );
  });

  it('throws when maxToolRounds is omitted', () => {
    assert.throws(
      () => new Agent({
        adapter: new FakeAdapter([]),
        toolRegistry: registry,
        systemInstruction: 'test',
      }),
      /Invalid maxToolRounds: undefined/,
    );
  });

  it('throws when historyKey is empty', async () => {
    const agent = new Agent({
      adapter: new FakeAdapter([]),
      toolRegistry: registry,
      systemInstruction: 'test',
      maxToolRounds: 8,
    });

    try {
      await agent.processMessage('', 'hello');
      assert.fail('expected processMessage to throw');
    } catch (err) {
      assert.strictEqual(err.message, 'historyKey is required');
    }
  });

  it('throws when text is whitespace only', async () => {
    const agent = new Agent({
      adapter: new FakeAdapter([]),
      toolRegistry: registry,
      systemInstruction: 'test',
      maxToolRounds: 8,
    });

    try {
      await agent.processMessage('k', '   ');
      assert.fail('expected processMessage to throw');
    } catch (err) {
      assert.strictEqual(err.message, 'text is required');
    }
  });

  it('throws when model function call has no name', async () => {
    const adapter = new FakeAdapter([
      { text: null, functionCalls: [{ name: undefined, args: {} }] },
    ]);
    const agent = new Agent({
      adapter,
      toolRegistry: registry,
      systemInstruction: 'test',
      maxToolRounds: 8,
    });

    try {
      await agent.processMessage('k', 'go');
      assert.fail('expected processMessage to throw');
    } catch (err) {
      assert.strictEqual(err.message, 'Model function call missing name');
    }
  });

  it('clearHistory is a no-op when agent has no history store', () => {
    const agent = new Agent({
      adapter: new FakeAdapter([]),
      toolRegistry: registry,
      systemInstruction: 'test',
      maxToolRounds: 8,
    });

    assert.doesNotThrow(() => agent.clearHistory('k'));
    assert.doesNotThrow(() => agent.clearHistory());
  });

  it('clearHistory clears a specific key in the history store', async () => {
    const history = new InMemoryHistoryStore({ windowMinutes: 60 });
    const agent = new Agent({
      adapter: new FakeAdapter([{ text: 'reply', functionCalls: null }]),
      toolRegistry: registry,
      systemInstruction: 'test',
      history,
      maxToolRounds: 8,
    });

    await agent.processMessage('chat:1', 'hello');
    agent.clearHistory('chat:1');

    assert.deepStrictEqual(history.get('chat:1'), []);
  });

  it('throws before adapter when requireUser is true and user is missing', async () => {
    const adapter = new FakeAdapter([
      { text: 'should not run', functionCalls: null },
    ]);
    const agent = new Agent({
      adapter,
      toolRegistry: registry,
      systemInstruction: 'test',
      maxToolRounds: 8,
      requireUser: true,
    });

    try {
      await agent.processMessage('k', 'hello');
      assert.fail('expected processMessage to throw');
    } catch (err) {
      assert.strictEqual(
        err.message,
        'Agent requires an authenticated user but none was provided.',
      );
      assert.strictEqual(adapter.callIndex, 0);
    }
  });

  it('succeeds when requireUser is true and user is provided', async () => {
    const adapter = new FakeAdapter([
      { text: 'authenticated reply', functionCalls: null },
    ]);
    const agent = new Agent({
      adapter,
      toolRegistry: registry,
      systemInstruction: 'test',
      maxToolRounds: 8,
      requireUser: true,
    });

    const reply = await agent.processMessage('k', 'hello', {
      user: { sub: 'user:1', email: 'a@example.com', jti: 'jti-1' },
    });

    assert.strictEqual(reply, 'authenticated reply');
    assert.strictEqual(adapter.callIndex, 1);
  });

  it('appends turns to history store', async () => {
    const history = new InMemoryHistoryStore({ windowMinutes: 60 });
    const adapter = new FakeAdapter([
      { text: 'first reply', functionCalls: null },
      { text: 'second reply', functionCalls: null },
    ]);
    const agent = new Agent({
      adapter,
      toolRegistry: registry,
      systemInstruction: 'test',
      history,
      maxToolRounds: 8,
    });

    await agent.processMessage('chat:1', 'one');
    await agent.processMessage('chat:1', 'two');

    const stored = history.get('chat:1');
    assert.isAtLeast(stored.length, 4);
    assert.strictEqual(stored[0].parts[0].text, 'one');
    assert.strictEqual(stored[stored.length - 1].parts[0].text, 'second reply');
  });

  it('processMessage skips history.append when appendHistory is false', async () => {
    const history = new InMemoryHistoryStore({ windowMinutes: 60 });
    const adapter = new FakeAdapter([
      { text: 'silent draft', functionCalls: null },
    ]);
    const agent = new Agent({
      adapter,
      toolRegistry: registry,
      systemInstruction: 'test',
      history,
      maxToolRounds: 8,
    });

    await agent.recordAssistantMessage('owner:1', 'prior reminder');
    const reply = await agent.processMessage('owner:1', 'check calendar', {
      appendHistory: false,
    });

    assert.strictEqual(reply, 'silent draft');
    assert.deepStrictEqual(history.get('owner:1'), [
      { role: 'model', parts: [{ text: 'prior reminder' }] },
    ]);
    assert.deepStrictEqual(adapter.generateParams[0].contents, [
      { role: 'user', parts: [{ text: '[continued]' }] },
      { role: 'model', parts: [{ text: 'prior reminder' }] },
      { role: 'user', parts: [{ text: 'check calendar' }] },
    ]);
  });

  it('processMessage still appends history when appendHistory is true', async () => {
    const history = new InMemoryHistoryStore({ windowMinutes: 60 });
    const adapter = new FakeAdapter([
      { text: 'recorded reply', functionCalls: null },
    ]);
    const agent = new Agent({
      adapter,
      toolRegistry: registry,
      systemInstruction: 'test',
      history,
      maxToolRounds: 8,
    });

    const reply = await agent.processMessage('owner:1', 'hello', {
      appendHistory: true,
    });

    assert.strictEqual(reply, 'recorded reply');
    assert.deepStrictEqual(history.get('owner:1'), [
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ text: 'recorded reply' }] },
    ]);
  });

  it('processMessage rejects a non-boolean appendHistory', async () => {
    const agent = new Agent({
      adapter: new FakeAdapter([{ text: 'x', functionCalls: null }]),
      toolRegistry: registry,
      systemInstruction: 'test',
      history: new InMemoryHistoryStore({ windowMinutes: 60 }),
      maxToolRounds: 8,
    });

    try {
      await agent.processMessage('k', 'hello', { appendHistory: 'no' });
      assert.fail('expected processMessage to throw');
    } catch (err) {
      assert.match(err.message, /appendHistory must be a boolean/);
    }
  });

  it('recordAssistantMessage appends exactly one model turn', async () => {
    const history = new InMemoryHistoryStore({ windowMinutes: 60 });
    const agent = new Agent({
      adapter: new FakeAdapter([]),
      toolRegistry: registry,
      systemInstruction: 'test',
      history,
      maxToolRounds: 8,
    });

    await agent.recordAssistantMessage('owner:1', 'Would you like to stretch today?');

    assert.deepStrictEqual(history.get('owner:1'), [
      { role: 'model', parts: [{ text: 'Would you like to stretch today?' }] },
    ]);
  });

  it('processMessage prepends a synthetic continued user turn when history starts with model', async () => {
    const history = new InMemoryHistoryStore({ windowMinutes: 60 });
    const adapter = new FakeAdapter([
      { text: 'marked done', functionCalls: null },
    ]);
    const agent = new Agent({
      adapter,
      toolRegistry: registry,
      systemInstruction: 'test',
      history,
      maxToolRounds: 8,
    });

    await agent.recordAssistantMessage('owner:1', 'Would you like to stretch today?');
    const reply = await agent.processMessage('owner:1', 'just completed for today');

    assert.deepStrictEqual({
      reply,
      generate: adapter.generateParams,
      stored: history.get('owner:1'),
    }, {
      reply: 'marked done',
      generate: [{
        contents: [
          { role: 'user', parts: [{ text: '[continued]' }] },
          { role: 'model', parts: [{ text: 'Would you like to stretch today?' }] },
          { role: 'user', parts: [{ text: 'just completed for today' }] },
        ],
        systemInstruction: 'test',
        toolDeclarations: [ECHO_TOOL_DECLARATION],
      }],
      stored: [
        { role: 'model', parts: [{ text: 'Would you like to stretch today?' }] },
        { role: 'user', parts: [{ text: 'just completed for today' }] },
        { role: 'model', parts: [{ text: 'marked done' }] },
      ],
    });
  });

  it('processMessage does not prepend a continued turn when history starts with user', async () => {
    const history = new InMemoryHistoryStore({ windowMinutes: 60 });
    const adapter = new FakeAdapter([
      { text: 'hello back', functionCalls: null },
    ]);
    const agent = new Agent({
      adapter,
      toolRegistry: registry,
      systemInstruction: 'test',
      history,
      maxToolRounds: 8,
    });

    const reply = await agent.processMessage('owner:1', 'hello');

    assert.deepStrictEqual({
      reply,
      generate: adapter.generateParams,
      stored: history.get('owner:1'),
    }, {
      reply: 'hello back',
      generate: [{
        contents: [
          { role: 'user', parts: [{ text: 'hello' }] },
        ],
        systemInstruction: 'test',
        toolDeclarations: [ECHO_TOOL_DECLARATION],
      }],
      stored: [
        { role: 'user', parts: [{ text: 'hello' }] },
        { role: 'model', parts: [{ text: 'hello back' }] },
      ],
    });
  });

  it('keeps the synthetic continued user turn on later tool-loop generate calls', async () => {
    const history = new InMemoryHistoryStore({ windowMinutes: 60 });
    const adapter = new FakeAdapter([
      { text: null, functionCalls: [{ name: 'echo', args: { message: 'hi' } }] },
      { text: 'done', functionCalls: null },
    ]);
    const agent = new Agent({
      adapter,
      toolRegistry: registry,
      systemInstruction: 'test',
      history,
      maxToolRounds: 8,
    });

    await agent.recordAssistantMessage('owner:1', 'Stretch today?');
    const reply = await agent.processMessage('owner:1', 'do it');

    assert.deepStrictEqual({
      reply,
      generateContents: adapter.generateParams.map((params) => params.contents),
    }, {
      reply: 'done',
      generateContents: [
        [
          { role: 'user', parts: [{ text: '[continued]' }] },
          { role: 'model', parts: [{ text: 'Stretch today?' }] },
          { role: 'user', parts: [{ text: 'do it' }] },
        ],
        [
          { role: 'user', parts: [{ text: '[continued]' }] },
          { role: 'model', parts: [{ text: 'Stretch today?' }] },
          { role: 'user', parts: [{ text: 'do it' }] },
          { role: 'model', parts: [{ functionCall: { name: 'echo', args: { message: 'hi' } } }] },
          {
            role: 'user',
            parts: [{
              functionResponse: {
                name: 'echo',
                response: { result: { echoed: 'hi' } },
              },
            }],
          },
        ],
      ],
    });
  });

  it('recordAssistantMessage throws without a history store', async () => {
    const agent = new Agent({
      adapter: new FakeAdapter([]),
      toolRegistry: registry,
      systemInstruction: 'test',
      maxToolRounds: 8,
    });

    await assertRejectsWithMessage(
      () => agent.recordAssistantMessage('owner:1', 'hello'),
      'history store is required to record assistant messages',
    );
  });

  it('recordAssistantMessage throws for an empty historyKey', async () => {
    const history = new InMemoryHistoryStore({ windowMinutes: 60 });
    const agent = new Agent({
      adapter: new FakeAdapter([]),
      toolRegistry: registry,
      systemInstruction: 'test',
      history,
      maxToolRounds: 8,
    });

    await assertRejectsWithMessage(
      () => agent.recordAssistantMessage('', 'hello'),
      'historyKey is required',
    );
  });

  it('recordAssistantMessage throws for blank text', async () => {
    const history = new InMemoryHistoryStore({ windowMinutes: 60 });
    const agent = new Agent({
      adapter: new FakeAdapter([]),
      toolRegistry: registry,
      systemInstruction: 'test',
      history,
      maxToolRounds: 8,
    });

    await assertRejectsWithMessage(
      () => agent.recordAssistantMessage('owner:1', '  '),
      'text is required',
    );
  });

  it('echoes thoughtSignature on the model functionCall turn', async () => {
    const modelParts = [{
      functionCall: { name: 'echo', args: { message: 'hi' } },
      thoughtSignature: 'sig-1',
    }];
    const adapter = new FakeAdapter([
      {
        text: null,
        functionCalls: [{ name: 'echo', args: { message: 'hi' }, thoughtSignature: 'sig-1' }],
        modelParts,
      },
      { text: 'done', functionCalls: null },
    ]);
    const agent = new Agent({
      adapter,
      toolRegistry: registry,
      systemInstruction: 'test',
      maxToolRounds: 8,
    });

    await agent.processMessage('user:1', 'say hi');

    const secondContents = adapter.generateParams[1].contents;
    const modelTurn = secondContents.find((entry) => (
      entry.role === 'model' &&
      entry.parts[0] &&
      entry.parts[0].functionCall
    ));
    assert.strictEqual(modelTurn.parts[0].thoughtSignature, 'sig-1');
  });

  it('batches parallel functionResponses into one user content', async () => {
    const adapter = new FakeAdapter([
      {
        text: null,
        functionCalls: [
          { name: 'echo', args: { message: 'a' } },
          { name: 'echo', args: { message: 'b' } },
        ],
      },
      { text: 'done', functionCalls: null },
    ]);
    const agent = new Agent({
      adapter,
      toolRegistry: registry,
      systemInstruction: 'test',
      maxToolRounds: 8,
    });

    await agent.processMessage('user:1', 'both');

    const secondContents = adapter.generateParams[1].contents;
    const userToolTurns = secondContents.filter((entry) => (
      entry.role === 'user' &&
      entry.parts[0] &&
      entry.parts[0].functionResponse
    ));
    assert.strictEqual(userToolTurns.length, 1);
    assert.strictEqual(userToolTurns[0].parts.length, 2);
  });

  it('buildToolDeclarations is byte-identical across calls and sorts schema keys', () => {
    const agent = new Agent({
      adapter: new FakeAdapter([]),
      toolRegistry: registry,
      systemInstruction: 'test',
      maxToolRounds: 8,
    });
    const first = agent.buildToolDeclarations();
    const second = agent.buildToolDeclarations();
    assert.deepStrictEqual(first, second);
    assert.strictEqual(JSON.stringify(first), JSON.stringify(second));
    assert.deepStrictEqual(
      Object.keys(first[0].parameters),
      ['additionalProperties', 'properties', 'required', 'type'],
    );
  });

  it('processMessage toolNames restricts declarations and rejects other tools', async () => {
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
    registry.register(new OtherTool());

    const adapter = new FakeAdapter([
      { text: null, functionCalls: [{ name: 'other', args: {} }] },
    ]);
    const agent = new Agent({
      adapter,
      toolRegistry: registry,
      systemInstruction: 'full',
      maxToolRounds: 8,
    });

    assert.deepStrictEqual(
      agent.buildToolDeclarations(['echo']).map((d) => d.name),
      ['echo'],
    );

    await assertRejectsWithMessage(
      () => agent.processMessage('k', 'go', { toolNames: ['echo'] }),
      'Tool is not available to the agent: other',
    );
  });

  it('uses per-turn systemInstruction', async () => {
    const adapter = new FakeAdapter([
      { text: 'ok', functionCalls: null },
    ]);
    const agent = new Agent({
      adapter,
      toolRegistry: registry,
      systemInstruction: 'default',
      maxToolRounds: 8,
    });

    await agent.processMessage('k', 'hi', { systemInstruction: 'override' });
    assert.strictEqual(adapter.generateParams[0].systemInstruction, 'override');
  });

  it('escalates via request_tools, adds round budget, and scrubs history', async () => {
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
    registry.register(new OtherTool());

    const history = new InMemoryHistoryStore({ windowMinutes: 60 });
    const infoCalls = [];
    const adapter = new FakeAdapter([
      {
        text: null,
        functionCalls: [{ name: REQUEST_TOOLS_NAME, args: { reason: 'need other' } }],
      },
      { text: null, functionCalls: [{ name: 'other', args: {} }] },
      { text: null, functionCalls: [{ name: 'echo', args: { message: 'hi' } }] },
      { text: 'done', functionCalls: null },
    ]);
    const agent = new Agent({
      adapter,
      toolRegistry: registry,
      systemInstruction: 'narrow',
      history,
      maxToolRounds: 2,
      historyToolTurns: 'full',
      logger: {
        info (attrs, msg) {
          infoCalls.push({ attrs, msg });
        },
      },
    });

    const reply = await agent.processMessage('chat:1', 'go', {
      toolNames: ['echo'],
      systemInstruction: 'narrow',
      escalation: {
        toolNames: ['echo', 'other'],
        systemInstruction: 'full prompt',
      },
    });

    assert.strictEqual(reply, 'done');
    assert.strictEqual(adapter.callIndex, 4);
    assert.strictEqual(adapter.generateParams[0].systemInstruction, 'narrow');
    assert.isTrue(
      adapter.generateParams[0].toolDeclarations.some((d) => d.name === REQUEST_TOOLS_NAME),
    );
    assert.strictEqual(adapter.generateParams[1].systemInstruction, 'full prompt');
    assert.isFalse(
      adapter.generateParams[1].toolDeclarations.some((d) => d.name === REQUEST_TOOLS_NAME),
    );

    const stored = history.get('chat:1');
    const serialized = JSON.stringify(stored);
    assert.isFalse(serialized.includes(REQUEST_TOOLS_NAME));
    assert.deepStrictEqual(
      scrubRequestToolsFromContents([
        { role: 'model', parts: [{ functionCall: { name: REQUEST_TOOLS_NAME, args: { reason: 'x' } } }] },
        { role: 'user', parts: [{ functionResponse: { name: REQUEST_TOOLS_NAME, response: { ok: true } } }] },
        { role: 'model', parts: [{ text: 'kept' }] },
      ]),
      [{ role: 'model', parts: [{ text: 'kept' }] }],
    );

    const escalateLog = infoCalls.find((c) => c.msg === 'Agent tool set escalated');
    assert.deepStrictEqual(escalateLog.attrs.from, ['echo']);
    assert.deepStrictEqual(escalateLog.attrs.to, ['echo', 'other']);
    const completed = infoCalls.find((c) => c.msg === 'Agent processMessage completed');
    assert.strictEqual(completed.attrs.escalated, true);
  });

  it('throws when escalation is set without toolNames', async () => {
    const agent = new Agent({
      adapter: new FakeAdapter([]),
      toolRegistry: registry,
      systemInstruction: 'test',
      maxToolRounds: 8,
    });

    await assertRejectsWithMessage(
      () => agent.processMessage('k', 'hi', {
        escalation: {
          toolNames: ['echo'],
          systemInstruction: 'full',
        },
      }),
      'escalation requires toolNames',
    );
  });

  it('throws when escalation.toolNames is not a superset', async () => {
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
    registry.register(new OtherTool());

    const agent = new Agent({
      adapter: new FakeAdapter([]),
      toolRegistry: registry,
      systemInstruction: 'test',
      maxToolRounds: 8,
    });

    await assertRejectsWithMessage(
      () => agent.processMessage('k', 'hi', {
        toolNames: ['echo', 'other'],
        escalation: {
          toolNames: ['echo'],
          systemInstruction: 'full',
        },
      }),
      'escalation.toolNames must be a superset of toolNames; missing other',
    );
  });
});
