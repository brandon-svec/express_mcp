/**
 * Pluggable LLM adapter for the generic Agent tool loop.
 */
export class ModelAdapter {
  /**
   * @param {Object} params
   * @param {Array<Object>} params.contents - Gemini-style conversation contents
   * @param {string} params.systemInstruction
   * @param {Array<Object>} params.toolDeclarations - function declaration objects
   * @returns {Promise<{ text: string|null, functionCalls: Array<{ name: string, args: object }>|null }>}
   */
  async generate (_params) {
    throw new Error('generate must be implemented by subclass');
  }
}
