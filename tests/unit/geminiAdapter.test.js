import { strict as assert } from 'assert';
import { GeminiAdapter } from '../../src/agents/geminiAdapter.js';

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

    assert.deepStrictEqual(result, { text: 'hello', functionCalls: null });
    assert.deepStrictEqual(generateCalls, [{
      model: 'gemini-2.5-flash',
      contents: params.contents,
      config: {
        systemInstruction: params.systemInstruction,
        tools: [{ functionDeclarations: params.toolDeclarations }],
      },
    }]);
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

    assert.deepStrictEqual(result, { text: null, functionCalls: calls });
  });
});
