import { GoogleGenAI } from '@google/genai';
import { ModelAdapter } from './modelAdapter.js';

/**
 * Gemini-backed model adapter using @google/genai.
 */
export class GeminiAdapter extends ModelAdapter {
  /**
   * @param {{ apiKey: string, model: string }} options
   */
  constructor (options) {
    super();
    if (!options || typeof options.apiKey !== 'string' || !options.apiKey.trim()) {
      throw new Error('gemini.apiKey is required and must be a non-empty string');
    }
    if (!options || typeof options.model !== 'string' || !options.model.trim()) {
      throw new Error('gemini.model is required and must be a non-empty string');
    }
    this.apiKey = options.apiKey.trim();
    this.model = options.model.trim();
    this.createClient = options.createClient;
  }

  /**
   * @inheritdoc
   */
  async generate ({ contents, systemInstruction, toolDeclarations }) {
    const ai = this.createClient
      ? this.createClient(this.apiKey)
      : new GoogleGenAI({ apiKey: this.apiKey });
    const response = await ai.models.generateContent({
      model: this.model,
      contents,
      config: {
        systemInstruction,
        tools: [{ functionDeclarations: toolDeclarations }],
      },
    });

    const functionCalls = response.functionCalls;
    return {
      text: typeof response.text === 'string' ? response.text : null,
      functionCalls: functionCalls && functionCalls.length > 0 ? functionCalls : null,
    };
  }
}
