/**
 * Base class for MCP resources (playbooks, SOPs, schemas).
 */
export class BaseResource {
  /**
   * @param {{
   *   uri: string,
   *   name: string,
   *   title?: string,
   *   description?: string,
   *   mimeType?: string,
   *   annotations?: Object,
   *   text?: string,
   *   blob?: string,
   * }} options
   */
  constructor (options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new Error('Resource options must be a plain object');
    }

    const { uri, name, title, description, mimeType, annotations, text, blob } = options;

    if (typeof uri !== 'string' || !uri.trim()) {
      throw new Error('Resource uri is required and must be a non-empty string');
    }
    if (typeof name !== 'string' || !name.trim()) {
      throw new Error('Resource name is required and must be a non-empty string');
    }

    if (text !== undefined && blob !== undefined) {
      throw new Error('Resource cannot have both text and blob');
    }
    if (text !== undefined && typeof text !== 'string') {
      throw new Error('Resource text must be a string when provided');
    }
    if (blob !== undefined && typeof blob !== 'string') {
      throw new Error('Resource blob must be a string when provided');
    }

    if (annotations !== undefined) {
      if (typeof annotations !== 'object' || annotations === null || Array.isArray(annotations)) {
        throw new Error('Annotations must be a plain object if provided');
      }
      this.annotations = annotations;
    }

    this.uri = uri.trim();
    this.name = name.trim();
    if (typeof title === 'string') {
      this.title = title;
    }
    if (typeof description === 'string') {
      this.description = description;
    }
    this.mimeType = typeof mimeType === 'string' && mimeType.trim()
      ? mimeType.trim()
      : 'text/markdown';

    if (text !== undefined) {
      this._staticText = text;
    }
    if (blob !== undefined) {
      this._staticBlob = blob;
    }
  }

  /**
   * Get the MCP Resource descriptor for resources/list
   * @returns {Object}
   */
  getDefinition () {
    const definition = {
      uri: this.uri,
      name: this.name,
      mimeType: this.mimeType,
    };
    if (this.title !== undefined) {
      definition.title = this.title;
    }
    if (this.description !== undefined) {
      definition.description = this.description;
    }
    if (this.annotations !== undefined) {
      definition.annotations = this.annotations;
    }
    return definition;
  }

  /**
   * Read the resource contents.
   * @param {Object} [_context] - Optional read context (user, sessionId, meta)
   * @returns {Promise<{ text: string }|{ blob: string }>}
   */
  async read (_context) {
    if (this._staticText !== undefined) {
      return { text: this._staticText };
    }
    if (this._staticBlob !== undefined) {
      return { blob: this._staticBlob };
    }
    throw new Error('read method must be implemented by subclass');
  }
}
