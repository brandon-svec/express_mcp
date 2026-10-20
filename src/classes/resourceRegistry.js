import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { BaseResource } from './baseResource.js';

/**
 * Registry for MCP resources, optionally bridged to a KnowledgeBase.
 */
export class ResourceRegistry {
  /**
   * @param {{
   *   logger?: Object|null,
   *   knowledgeBase?: import('./knowledgeBase.js').KnowledgeBase|null,
   *   namespace?: string,
   * }} [options]
   */
  constructor (options = {}) {
    this.logger = options.logger || null;
    this.knowledgeBase = options.knowledgeBase ?? null;
    const namespace = options.namespace;
    if (typeof namespace !== 'string' || !namespace.trim()) {
      throw new Error('ResourceRegistry namespace is required and must be a non-empty string');
    }
    this.namespace = namespace.trim();
    /** @type {Map<string, BaseResource>} */
    this.resources = new Map();
  }

  /**
   * @param {string} documentId
   * @returns {string}
   */
  kbUriForDocument (documentId) {
    return `kb://${this.namespace}/${documentId}`;
  }

  /**
   * @param {string} uri
   * @returns {string|null} document id when uri is a kb:// URI for this namespace
   */
  parseKbUri (uri) {
    const prefix = `kb://${this.namespace}/`;
    if (typeof uri !== 'string' || !uri.startsWith(prefix)) {
      return null;
    }
    const documentId = uri.slice(prefix.length);
    if (!documentId) {
      return null;
    }
    return documentId;
  }

  /**
   * @param {BaseResource} resource
   */
  register (resource) {
    if (!(resource instanceof BaseResource)) {
      throw new Error('Resource must be an instance of BaseResource');
    }
    if (this.resources.has(resource.uri)) {
      throw new Error(`Resource '${resource.uri}' is already registered. Cannot register duplicate URIs.`);
    }
    this.resources.set(resource.uri, resource);
  }

  /**
   * @param {string} uri
   * @returns {boolean}
   */
  unregister (uri) {
    return this.resources.delete(uri);
  }

  /**
   * @param {string} uri
   * @returns {boolean}
   */
  has (uri) {
    return this.resources.has(uri);
  }

  /**
   * @returns {BaseResource[]}
   */
  getRegistered () {
    return Array.from(this.resources.values());
  }

  clear () {
    this.resources.clear();
  }

  /**
   * @param {Object} doc
   * @returns {Object}
   * @private
   */
  _kbDocumentToResource (doc) {
    const uri = this.kbUriForDocument(doc.id);
    const mimeType = typeof doc.metadata?.mimeType === 'string' && doc.metadata.mimeType.trim()
      ? doc.metadata.mimeType.trim()
      : 'text/markdown';
    const definition = {
      uri,
      name: doc.id,
      title: doc.title,
      mimeType,
      annotations: {
        audience: ['assistant'],
        lastModified: doc.updatedAt,
      },
    };
    if (Array.isArray(doc.tags) && doc.tags.length > 0) {
      definition.description = `Tags: ${doc.tags.join(', ')}`;
    }
    return definition;
  }

  /**
   * Merge explicit resources with KnowledgeBase documents.
   * @returns {Object[]}
   */
  listResources () {
    const resources = this.getRegistered().map((resource) => resource.getDefinition());
    const explicitUris = new Set(resources.map((r) => r.uri));

    if (this.knowledgeBase && typeof this.knowledgeBase.listDocuments === 'function') {
      for (const doc of this.knowledgeBase.listDocuments()) {
        const uri = this.kbUriForDocument(doc.id);
        if (explicitUris.has(uri)) {
          continue;
        }
        resources.push(this._kbDocumentToResource(doc));
      }
    }

    return resources;
  }

  /**
   * @param {string} uri
   * @param {Object} [context]
   * @returns {Promise<{ contents: Object[] }>}
   */
  async readResource (uri, context = {}) {
    const explicit = this.resources.get(uri);
    if (explicit) {
      const payload = await explicit.read(context);
      if (payload && typeof payload.text === 'string') {
        return {
          contents: [{
            uri,
            mimeType: explicit.mimeType,
            text: payload.text,
          }],
        };
      }
      if (payload && typeof payload.blob === 'string') {
        return {
          contents: [{
            uri,
            mimeType: explicit.mimeType,
            blob: payload.blob,
          }],
        };
      }
      throw new McpError(-32603, `Resource read returned neither text nor blob: ${uri}`);
    }

    const documentId = this.parseKbUri(uri);
    if (documentId && this.knowledgeBase && typeof this.knowledgeBase.getDocument === 'function') {
      const doc = this.knowledgeBase.getDocument(documentId);
      if (doc) {
        const mimeType = typeof doc.metadata?.mimeType === 'string' && doc.metadata.mimeType.trim()
          ? doc.metadata.mimeType.trim()
          : 'text/markdown';
        return {
          contents: [{
            uri,
            mimeType,
            text: doc.content,
          }],
        };
      }
    }

    throw new McpError(-32002, `Resource not found: ${uri}`);
  }

  /**
   * Register resources/list and resources/read handlers on an SDK McpServer.
   * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} mcpServer
   * @param {{ user?: Object|null, sessionId?: string|null, meta?: Object }} [context]
   */
  registerOnMcpServer (mcpServer, context = {}) {
    const server = mcpServer.server;

    server.registerCapabilities({
      resources: {},
    });

    server.setRequestHandler(ListResourcesRequestSchema, () => ({
      resources: this.listResources(),
    }));

    server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
      const uri = request.params.uri;
      return this.readResource(uri, {
        user: context.user ?? null,
        sessionId: extra?.sessionId ?? context.sessionId ?? null,
        meta: context.meta ?? {},
      });
    });
  }
}
