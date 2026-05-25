import { strict as assert } from 'assert';
import { ModelAdapter } from '../../src/agents/modelAdapter.js';

describe('ModelAdapter', () => {
  it('generate throws not implemented on base class', async () => {
    const adapter = new ModelAdapter();

    try {
      await adapter.generate({
        contents: [],
        systemInstruction: 'test',
        toolDeclarations: [],
      });
      assert.fail('expected generate to throw');
    } catch (err) {
      assert.strictEqual(err.message, 'generate must be implemented by subclass');
    }
  });
});
