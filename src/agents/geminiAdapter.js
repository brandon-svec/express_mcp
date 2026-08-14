import { GoogleGenAI } from '@google/genai';
import { ModelAdapter } from './modelAdapter.js';

/**
 * @param {object} response Gemini generateContent SDK response
 * @returns {{ text: string|null, functionCalls: Array<object>|null, modelParts: Array<object> }}
 */
export function parseGeminiGenerateContentResponse (response) {
  if (!response || typeof response !== 'object') {
    throw new Error('Gemini generateContent response is required');
  }

  const rawParts = response.candidates &&
    response.candidates[0] &&
    response.candidates[0].content &&
    Array.isArray(response.candidates[0].content.parts)
    ? response.candidates[0].content.parts
    : [];

  const functionCalls = [];
  const textChunks = [];
  for (const part of rawParts) {
    if (!part || typeof part !== 'object') {
      continue;
    }
    if (part.functionCall && typeof part.functionCall === 'object') {
      const mapped = {
        name: part.functionCall.name,
        args: part.functionCall.args,
      };
      if (part.thoughtSignature != null && part.thoughtSignature !== '') {
        mapped.thoughtSignature = part.thoughtSignature;
      }
      functionCalls.push(mapped);
      continue;
    }
    if (part.thought === true) {
      continue;
    }
    if (typeof part.text === 'string' && part.text.length > 0) {
      textChunks.push(part.text);
    }
  }

  if (functionCalls.length === 0 && Array.isArray(response.functionCalls)) {
    for (const fc of response.functionCalls) {
      if (!fc || typeof fc !== 'object') {
        continue;
      }
      functionCalls.push({
        name: fc.name,
        args: fc.args,
      });
      const last = functionCalls[functionCalls.length - 1];
      if (fc.thoughtSignature != null && fc.thoughtSignature !== '') {
        last.thoughtSignature = fc.thoughtSignature;
      }
    }
  }

  let text = textChunks.length > 0 ? textChunks.join('') : null;
  if (text === null && functionCalls.length === 0 && typeof response.text === 'string' && response.text.length > 0) {
    text = response.text;
  }

  return {
    text,
    functionCalls: functionCalls.length > 0 ? functionCalls : null,
    modelParts: rawParts,
  };
}

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
    return parseGeminiGenerateContentResponse(response);
  }
}
