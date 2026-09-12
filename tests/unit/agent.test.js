import { assert } from 'chai';
import { Agent } from '../../src/agents/agent.js';
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

const ECHO_TOOL_DECLARATION = {
  name: 'echo',
  description: 'Echo tool',
  parameters: ECHO_INPUT_SCHEMA,
};

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
    assert.strictEqual(reply, 'sorry, that tool is unavailable');
    assert.strictEqual(adapter.callIndex, 2);

    const toolTurn = adapter.generateParams[1].contents.find((entry) => (
      entry.role === 'user' &&
      entry.parts[0] &&
      entry.parts[0].functionResponse
    ));
    assert.deepStrictEqual(toolTurn.parts[0].functionResponse, {
      name: 'missing_tool',
      response: {
        ok: false,
        error: "Tool 'missing_tool' not found",
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
    assert.strictEqual(reply, 'done');
    assert.strictEqual(adapter.callIndex, 3);

    const errorTurn = adapter.generateParams[1].contents.find((entry) => (
      entry.role === 'user' &&
      entry.parts[0] &&
      entry.parts[0].functionResponse
    ));
    assert.strictEqual(errorTurn.parts[0].functionResponse.name, 'echo');
    assert.strictEqual(errorTurn.parts[0].functionResponse.response.ok, false);
    assert.match(
      errorTurn.parts[0].functionResponse.response.error,
      /Validation failed/,
    );

    const successTurn = adapter.generateParams[2].contents.filter((entry) => (
      entry.role === 'user' &&
      entry.parts[0] &&
      entry.parts[0].functionResponse
    )).at(-1);
    assert.deepStrictEqual(successTurn.parts[0].functionResponse, {
      name: 'echo',
      response: { result: { echoed: 'hi' } },
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

    const toolLogs = infoCalls.filter((entry) => entry.msg === 'Agent tool call completed');
    const completed = infoCalls.filter((entry) => entry.msg === 'Agent processMessage completed');
    assert.strictEqual(toolLogs.length, 2);
    assert.deepStrictEqual(toolLogs[0].attrs, {
      round: 0,
      toolName: 'echo',
      status: 'error',
      argKeys: [],
      error: toolLogs[0].attrs.error,
    });
    assert.match(toolLogs[0].attrs.error, /Validation failed/);
    assert.deepStrictEqual(toolLogs[1].attrs, {
      round: 1,
      toolName: 'echo',
      status: 'success',
      argKeys: ['message'],
    });
    assert.strictEqual(completed.length, 1);
    assert.deepStrictEqual(completed[0].attrs, {
      rounds: 2,
      toolCalls: 2,
      errorCalls: 1,
    });
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
});
