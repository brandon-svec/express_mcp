/**
 * Live tests for GeminiAdapter — real Gemini API calls.
 *
 * Requires tests/live/config.js — see tests/live/README.md
 * Run: npm run test:live
 */

import { strict as assert } from 'assert';
import { GeminiAdapter } from '../../src/agents/geminiAdapter.js';
import { loadLiveGeminiConfig } from './liveConfig.js';

const liveConfig = await loadLiveGeminiConfig();

describe('GeminiAdapter live', function () {
  this.timeout(30000);

  it('generate returns non-empty text for a simple prompt', async () => {
    const adapter = new GeminiAdapter({
      apiKey: liveConfig.apiKey,
      model: liveConfig.model,
    });

    const result = await adapter.generate({
      contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: pong' }] }],
      systemInstruction: 'You are a test assistant.',
      toolDeclarations: [],
    });

    assert.deepStrictEqual(result, {
      text: result.text,
      functionCalls: null,
    });
    assert.strictEqual(typeof result.text, 'string');
    assert.notStrictEqual(result.text.trim(), '');
  });
});
