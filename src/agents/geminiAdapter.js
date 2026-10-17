import { GoogleGenAI } from '@google/genai';
import { ModelAdapter } from './modelAdapter.js';

/**
 * @param {object} response Gemini generateContent SDK response
 * @returns {{
 *   text: string|null,
 *   functionCalls: Array<object>|null,
 *   modelParts: Array<object>,
 *   thought?: string,
 *   usage?: { promptTokens?: number, completionTokens?: number, totalTokens?: number },
 * }}
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
  const thoughtChunks = [];
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
      if (typeof part.text === 'string' && part.text.length > 0) {
        thoughtChunks.push(part.text);
      }
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

  /** @type {{
   *   text: string|null,
   *   functionCalls: Array<object>|null,
   *   modelParts: Array<object>,
   *   thought?: string,
   *   usage?: { promptTokens?: number, completionTokens?: number, totalTokens?: number },
   * }} */
  const parsed = {
    text,
    functionCalls: functionCalls.length > 0 ? functionCalls : null,
    modelParts: rawParts,
  };

  if (thoughtChunks.length > 0) {
    parsed.thought = thoughtChunks.join('\n');
  }

  const meta = response.usageMetadata;
  if (meta && typeof meta === 'object') {
    /** @type {{ promptTokens?: number, completionTokens?: number, totalTokens?: number }} */
    const usage = {};
    if (typeof meta.promptTokenCount === 'number') {
      usage.promptTokens = meta.promptTokenCount;
    }
    // Thinking models report reasoning in thoughtsTokenCount; include it in
    // completion so output token totals are not undercounted.
    const hasCandidates = typeof meta.candidatesTokenCount === 'number';
    const hasThoughts = typeof meta.thoughtsTokenCount === 'number';
    if (hasCandidates || hasThoughts) {
      usage.completionTokens = (hasCandidates ? meta.candidatesTokenCount : 0)
        + (hasThoughts ? meta.thoughtsTokenCount : 0);
    }
    if (typeof meta.totalTokenCount === 'number') {
      usage.totalTokens = meta.totalTokenCount;
    }
    if (Object.keys(usage).length > 0) {
      parsed.usage = usage;
    }
  }

  return parsed;
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
    if (!Array.isArray(toolDeclarations)) {
      throw new Error('toolDeclarations must be an array');
    }
    // Gemini rejects `tools: [{ functionDeclarations: [] }]` with INVALID_ARGUMENT,
    // so a turn with no declarations must omit the `tools` key entirely.
    const config = { systemInstruction };
    if (toolDeclarations.length > 0) {
      config.tools = [{ functionDeclarations: toolDeclarations }];
    }
    const response = await ai.models.generateContent({
      model: this.model,
      contents,
      config,
    });
    return parseGeminiGenerateContentResponse(response);
  }
}
