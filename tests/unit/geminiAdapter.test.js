import { strict as assert } from 'assert';
import {
  GeminiAdapter,
  parseGeminiGenerateContentResponse,
} from '../../src/agents/geminiAdapter.js';

describe('GeminiAdapter', () => {
  function createMockClient (generateContentImpl, generateCalls) {
    return (apiKey) => ({
      apiKey,
      models: {
        generateContent: async (params) => {
          generateCalls.push(params);
          return generateContentImpl(params);
        },
      },
    });
  }

  it('throws when apiKey is missing', () => {
    assert.throws(
      () => new GeminiAdapter({ apiKey: '', model: 'gemini-2.5-flash' }),
      /gemini.apiKey is required and must be a non-empty string/,
    );
  });

  it('throws when model is missing', () => {
    assert.throws(
      () => new GeminiAdapter({ apiKey: 'key-1', model: '' }),
      /gemini.model is required and must be a non-empty string/,
    );
  });

  it('trims apiKey and model on construction', () => {
    const adapter = new GeminiAdapter({
      apiKey: '  key-1  ',
      model: '  gemini-2.5-flash  ',
      createClient: () => ({}),
    });

    assert.deepStrictEqual(
      { apiKey: adapter.apiKey, model: adapter.model },
      { apiKey: 'key-1', model: 'gemini-2.5-flash' },
    );
  });

  it('generate calls client with exact params and returns text-only response', async () => {
    const generateCalls = [];
    const adapter = new GeminiAdapter({
      apiKey: 'key-1',
      model: 'gemini-2.5-flash',
      createClient: createMockClient(async () => ({
        text: 'hello',
        functionCalls: [],
      }), generateCalls),
    });

    const params = {
      contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
      systemInstruction: 'You are helpful.',
      toolDeclarations: [{ name: 'echo', description: 'Echo', parameters: { type: 'object', properties: {} } }],
    };

    const result = await adapter.generate(params);

    assert.deepStrictEqual(result, { text: 'hello', functionCalls: null, modelParts: [] });
    assert.deepStrictEqual(generateCalls, [{
      model: 'gemini-2.5-flash',
      contents: params.contents,
      config: {
        systemInstruction: params.systemInstruction,
        tools: [{ functionDeclarations: params.toolDeclarations }],
      },
    }]);
  });

  it('generate omits the tools key entirely when there are no declarations', async () => {
    const generateCalls = [];
    const adapter = new GeminiAdapter({
      apiKey: 'key-1',
      model: 'gemini-2.5-flash',
      createClient: createMockClient(async () => ({
        text: 'hello',
        functionCalls: [],
      }), generateCalls),
    });

    const params = {
      contents: [{ role: 'user', parts: [{ text: 'hey' }] }],
      systemInstruction: 'You are helpful.',
      toolDeclarations: [],
    };

    await adapter.generate(params);

    assert.deepStrictEqual(generateCalls, [{
      model: 'gemini-2.5-flash',
      contents: params.contents,
      config: { systemInstruction: params.systemInstruction },
    }]);
    assert.equal(Object.prototype.hasOwnProperty.call(generateCalls[0].config, 'tools'), false);
  });

  it('generate rejects a non-array toolDeclarations', async () => {
    const adapter = new GeminiAdapter({
      apiKey: 'key-1',
      model: 'gemini-2.5-flash',
      createClient: createMockClient(async () => ({ text: 'x', functionCalls: [] }), []),
    });

    await assert.rejects(
      () => adapter.generate({ contents: [], systemInstruction: 'test', toolDeclarations: undefined }),
      { message: 'toolDeclarations must be an array' },
    );
  });

  it('generate returns functionCalls when model requests tools', async () => {
    const calls = [{ name: 'echo', args: { message: 'hi' } }];
    const adapter = new GeminiAdapter({
      apiKey: 'key-1',
      model: 'gemini-2.5-flash',
      createClient: createMockClient(async () => ({
        text: undefined,
        functionCalls: calls,
      }), []),
    });

    const result = await adapter.generate({
      contents: [],
      systemInstruction: 'test',
      toolDeclarations: [],
    });

    assert.deepStrictEqual(result, {
      text: null,
      functionCalls: calls,
      modelParts: [],
    });
  });

  it('generate echoes candidate functionCall parts including thoughtSignature', async () => {
    const modelPart = {
      functionCall: { name: 'echo', args: { message: 'hi' } },
      thoughtSignature: 'sig-1',
    };
    const adapter = new GeminiAdapter({
      apiKey: 'key-1',
      model: 'gemini-2.5-flash',
      createClient: createMockClient(async () => ({
        candidates: [{ content: { parts: [modelPart] } }],
      }), []),
    });

    const result = await adapter.generate({
      contents: [],
      systemInstruction: 'test',
      toolDeclarations: [],
    });

    assert.deepStrictEqual(result.modelParts, [modelPart]);
    assert.deepStrictEqual(result.functionCalls, [{
      name: 'echo',
      args: { message: 'hi' },
      thoughtSignature: 'sig-1',
    }]);
    assert.strictEqual(result.text, null);
  });

  it('parseGeminiGenerateContentResponse extracts thought parts and usageMetadata', () => {
    const parsed = parseGeminiGenerateContentResponse({
      candidates: [{
        content: {
          parts: [
            { thought: true, text: 'Need auth docs.' },
            { thought: true, text: 'Searching KB.' },
            { text: 'Here is the answer.' },
          ],
        },
      }],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 40,
        totalTokenCount: 140,
      },
    });

    assert.strictEqual(parsed.thought, 'Need auth docs.\nSearching KB.');
    assert.strictEqual(parsed.text, 'Here is the answer.');
    assert.deepStrictEqual(parsed.usage, {
      promptTokens: 100,
      completionTokens: 40,
      totalTokens: 140,
    });
  });

  it('parseGeminiGenerateContentResponse omits thought and usage when absent', () => {
    const parsed = parseGeminiGenerateContentResponse({
      candidates: [{ content: { parts: [{ text: 'hi' }] } }],
    });
    assert.strictEqual(parsed.text, 'hi');
    assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'thought'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'usage'), false);
  });

  it('parseGeminiGenerateContentResponse does not put thought text into reply text', () => {
    const parsed = parseGeminiGenerateContentResponse({
      candidates: [{
        content: {
          parts: [
            { thought: true, text: 'secret reasoning' },
            { functionCall: { name: 'echo', args: {} } },
          ],
        },
      }],
    });
    assert.strictEqual(parsed.text, null);
    assert.strictEqual(parsed.thought, 'secret reasoning');
    assert.deepStrictEqual(parsed.functionCalls, [{ name: 'echo', args: {} }]);
  });
});
