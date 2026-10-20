import { Index } from 'flexsearch';

const SUMMARY_MAX_CHARS = 180;

/**
 * Escape a string for use in a RegExp.
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp (value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build an identifier-safe, longest-first tool-name scan regex.
 * Uses lookaround so hyphens in prefixed names (e.g. widget-service_kb_search)
 * are not treated as word boundaries the way \\b would.
 *
 * @param {Iterable<string>|string[]} toolNames
 * @returns {RegExp|null}
 */
export function buildToolScanRegex (toolNames) {
  if (!toolNames) {
    return null;
  }
  const names = Array.isArray(toolNames) ? toolNames : [...toolNames];
  if (names.length === 0) {
    return null;
  }
  const sorted = [...names].sort((a, b) => b.length - a.length);
  const escaped = sorted.map((name) => escapeRegExp(name));
  return new RegExp(`(?<![a-zA-Z0-9_-])(${escaped.join('|')})(?![a-zA-Z0-9_-])`, 'g');
}

/**
 * Extract a clean 1-sentence summary from markdown content.
 * Skips headings, fenced code, table rows, thematic breaks, and blanks.
 * Strips list/blockquote markers; collapses whitespace; truncates to 180 chars.
 *
 * @param {string} content
 * @returns {string}
 */
export function extractAutoSummary (content) {
  if (typeof content !== 'string' || !content.trim()) {
    return '';
  }

  const lines = content.split(/\r?\n/);
  let inFence = false;
  const paragraphLines = [];

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    if (!trimmed) {
      if (paragraphLines.length > 0) {
        break;
      }
      continue;
    }
    if (/^#{1,6}\s/.test(trimmed)) {
      continue;
    }
    if (/^-{3,}$/.test(trimmed) || /^\*{3,}$/.test(trimmed) || /^_{3,}$/.test(trimmed)) {
      continue;
    }
    if (trimmed.startsWith('|')) {
      continue;
    }

    let cleaned = trimmed
      .replace(/^>\s?/, '')
      .replace(/^[-*]\s+/, '')
      .replace(/^\d+\.\s+/, '');
    cleaned = cleaned.trim();
    if (!cleaned) {
      continue;
    }
    paragraphLines.push(cleaned);
  }

  if (paragraphLines.length === 0) {
    return '';
  }

  let summary = paragraphLines.join(' ').replace(/\s+/g, ' ').trim();
  if (summary.length > SUMMARY_MAX_CHARS) {
    summary = summary.slice(0, SUMMARY_MAX_CHARS);
  }
  return summary;
}

/**
 * Validate optional string[] of non-empty strings.
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {string[]}
 */
function validateStringArray (value, fieldName) {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array of non-empty strings`);
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new Error(`${fieldName} must be an array of non-empty strings`);
    }
  }
  return value.map((entry) => entry.trim());
}

/**
 * Knowledge base storage class
 * Manages document storage and retrieval using FlexSearch
 */
export class KnowledgeBase {
  constructor (options = {}) {
    this.documents = new Map();
    this.description = options.description;
    this.associatedTools = new Set(); // Track tools that use this knowledge base
    /** @type {Set<string>} */
    this.knownToolNames = new Set();
    /** @type {Map<string, Set<string>>} */
    this.toolToDocs = new Map();
    /** @type {Map<string, Set<string>>} */
    this.docToTools = new Map();

    // Initialize FlexSearch indexes
    this.searchIndex = new Index({
      preset: 'score',
      tokenize: 'forward',
      resolution: 9,
      cache: true
    });

    this.titleIndex = new Index({
      preset: 'score',
      tokenize: 'forward',
      resolution: 9,
      cache: true
    });

    this.tagsIndex = new Index({
      preset: 'match',
      tokenize: 'forward',
      resolution: 9,
      cache: true
    });

    this.summaryIndex = new Index({
      preset: 'score',
      tokenize: 'forward',
      resolution: 9,
      cache: true
    });

    this.toolsIndex = new Index({
      preset: 'match',
      tokenize: 'forward',
      resolution: 9,
      cache: true
    });
  }

  /**
   * Update the set of known tool names used for auto-association.
   * Re-scans and reindexes documents that did not declare tools explicitly.
   * @param {Iterable<string>|string[]} names
   */
  setKnownToolNames (names) {
    if (names == null) {
      throw new Error('setKnownToolNames requires an iterable of tool names');
    }
    const next = new Set();
    for (const name of names) {
      if (typeof name !== 'string' || !name.trim()) {
        throw new Error('known tool names must be non-empty strings');
      }
      next.add(name.trim());
    }
    this.knownToolNames = next;

    for (const doc of this.documents.values()) {
      if (doc.toolsExplicit) {
        continue;
      }
      const previousTools = [...(doc.tools || [])];
      const scanned = this._scanContentForTools(doc.content);
      doc.tools = scanned;
      this._unlinkDocTools(doc.id);
      this._linkDocTools(doc.id, scanned);
      this._removeFromIndex(doc);
      this._indexDocument(doc);
      // Preserve identity if tools unchanged (index already refreshed above)
      void previousTools;
    }
  }

  /**
   * Scan content for known tool names with identifier-safe boundaries.
   * @param {string} content
   * @returns {string[]}
   * @private
   */
  _scanContentForTools (content) {
    const regex = buildToolScanRegex(this.knownToolNames);
    if (!regex) {
      return [];
    }
    const found = new Set();
    let match;
    while ((match = regex.exec(content)) !== null) {
      found.add(match[1]);
    }
    return [...found];
  }

  /**
   * @param {string} docId
   * @private
   */
  _unlinkDocTools (docId) {
    const previous = this.docToTools.get(docId);
    if (previous) {
      for (const toolName of previous) {
        const docs = this.toolToDocs.get(toolName);
        if (docs) {
          docs.delete(docId);
          if (docs.size === 0) {
            this.toolToDocs.delete(toolName);
          }
        }
      }
      this.docToTools.delete(docId);
    }
  }

  /**
   * @param {string} docId
   * @param {string[]} tools
   * @private
   */
  _linkDocTools (docId, tools) {
    if (!tools || tools.length === 0) {
      return;
    }
    const toolSet = new Set(tools);
    this.docToTools.set(docId, toolSet);
    for (const toolName of toolSet) {
      let docs = this.toolToDocs.get(toolName);
      if (!docs) {
        docs = new Set();
        this.toolToDocs.set(toolName, docs);
      }
      docs.add(docId);
    }
  }

  /**
   * Resolve summary/tools/relatedDocs for a document payload.
   * @param {Object} document
   * @param {Object} [existing]
   * @returns {{ summary: string, tools: string[], relatedDocs: string[], toolsExplicit: boolean }}
   * @private
   */
  _resolvePlaybookFields (document, existing = null) {
    let summary;
    if (Object.prototype.hasOwnProperty.call(document, 'summary')) {
      if (typeof document.summary !== 'string') {
        throw new Error('summary must be a string when provided');
      }
      summary = document.summary;
    } else if (existing && Object.prototype.hasOwnProperty.call(document, 'content') === false) {
      summary = existing.summary;
    } else {
      const content = Object.prototype.hasOwnProperty.call(document, 'content')
        ? document.content
        : existing?.content;
      summary = extractAutoSummary(typeof content === 'string' ? content : '');
    }

    let tools;
    let toolsExplicit;
    if (Object.prototype.hasOwnProperty.call(document, 'tools')) {
      tools = validateStringArray(document.tools, 'tools');
      toolsExplicit = true;
    } else if (existing?.toolsExplicit && Object.prototype.hasOwnProperty.call(document, 'content') === false) {
      tools = [...(existing.tools || [])];
      toolsExplicit = true;
    } else {
      const content = Object.prototype.hasOwnProperty.call(document, 'content')
        ? document.content
        : existing?.content;
      tools = this._scanContentForTools(typeof content === 'string' ? content : '');
      toolsExplicit = false;
    }

    let relatedDocs;
    if (Object.prototype.hasOwnProperty.call(document, 'relatedDocs')) {
      relatedDocs = validateStringArray(document.relatedDocs, 'relatedDocs');
    } else if (existing) {
      relatedDocs = [...(existing.relatedDocs || [])];
    } else {
      relatedDocs = [];
    }

    return { summary, tools, relatedDocs, toolsExplicit };
  }

  /**
   * Add a document to the knowledge base
   * @param {string} id - Unique document identifier
   * @param {Object} document - Document object with title, content, metadata
   */
  addDocument (id, document) {
    if (!id || !document) {
      throw new Error('Document ID and document object are required');
    }

    if (!document.title || !document.content) {
      throw new Error('Document must have title and content');
    }

    const { summary, tools, relatedDocs, toolsExplicit } = this._resolvePlaybookFields(document);

    const doc = {
      id,
      title: document.title,
      content: document.content,
      metadata: document.metadata || {},
      tags: document.tags || [],
      summary,
      tools,
      relatedDocs,
      toolsExplicit,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.documents.set(id, doc);
    this._linkDocTools(id, tools);
    this._indexDocument(doc);

    return { success: true, documentId: id };
  }

  /**
   * Update an existing document
   * @param {string} id - Document ID
   * @param {Object} updates - Document updates
   */
  updateDocument (id, updates) {
    const existing = this.documents.get(id);
    if (!existing) {
      throw new Error(`Document with ID '${id}' not found`);
    }

    if (updates == null || typeof updates !== 'object' || Array.isArray(updates)) {
      throw new Error('Document updates must be a plain object');
    }

    const { summary, tools, relatedDocs, toolsExplicit } = this._resolvePlaybookFields(updates, existing);

    const updated = {
      ...existing,
      ...updates,
      id: existing.id,
      createdAt: existing.createdAt,
      summary,
      tools,
      relatedDocs,
      toolsExplicit,
      updatedAt: new Date().toISOString()
    };

    // Ensure title/content remain valid after merge
    if (!updated.title || !updated.content) {
      throw new Error('Document must have title and content');
    }

    this._removeFromIndex(existing);
    this._unlinkDocTools(id);
    this.documents.set(id, updated);
    this._linkDocTools(id, tools);
    this._indexDocument(updated);

    return { success: true, documentId: id };
  }

  /**
   * Remove a document
   * @param {string} id - Document ID
   */
  removeDocument (id) {
    const doc = this.documents.get(id);
    if (!doc) {
      throw new Error(`Document with ID '${id}' not found`);
    }

    this.documents.delete(id);
    this._unlinkDocTools(id);
    this._removeFromIndex(doc);

    return { success: true, documentId: id };
  }

  /**
   * Get a document by plain ID or by MCP resource URI `kb://{namespace}/{id}`.
   * Exact Map key wins first (including a document stored under a full URI).
   * Otherwise any `kb://…` namespace is stripped and the remainder is looked up.
   * @param {string} id - Document ID or `kb://{namespace}/{id}`
   * @returns {Object|undefined}
   */
  getDocument (id) {
    if (typeof id !== 'string' || !id.trim()) {
      return undefined;
    }
    const cleanId = id.trim();
    if (this.documents.has(cleanId)) {
      return this.documents.get(cleanId);
    }
    const uriMatch = /^kb:\/\/[^/]+\/(.+)$/.exec(cleanId);
    if (uriMatch) {
      const documentId = uriMatch[1];
      if (documentId && this.documents.has(documentId)) {
        return this.documents.get(documentId);
      }
    }
    return undefined;
  }

  /**
   * List all documents
   * @param {Object} options - Filtering options
   */
  listDocuments (options = {}) {
    let docs = Array.from(this.documents.values());

    if (options.tag) {
      docs = docs.filter(doc => doc.tags.includes(options.tag));
    }

    if (options.limit) {
      docs = docs.slice(0, options.limit);
    }

    return docs.map(doc => ({
      id: doc.id,
      title: doc.title,
      tags: doc.tags,
      metadata: doc.metadata,
      summary: doc.summary,
      tools: doc.tools,
      relatedDocs: doc.relatedDocs,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt
    }));
  }

  /**
   * Playbooks that govern a given tool name.
   * @param {string} toolName
   * @returns {Array<{ id: string, title: string, summary: string }>}
   */
  getPlaybooksForTool (toolName) {
    if (typeof toolName !== 'string' || !toolName.trim()) {
      throw new Error('toolName is required and must be a non-empty string');
    }
    const docs = this.toolToDocs.get(toolName.trim());
    if (!docs || docs.size === 0) {
      return [];
    }
    const results = [];
    for (const docId of docs) {
      const doc = this.documents.get(docId);
      if (doc) {
        results.push({
          id: doc.id,
          title: doc.title,
          summary: doc.summary,
        });
      }
    }
    return results;
  }

  /**
   * Compact playbook directory for a namespace (URIs are kb://{namespace}/{id}).
   * @param {string} namespace
   * @returns {Array<{ id: string, title: string, uri: string, summary: string, tools: string[], tags: string[] }>}
   */
  getPlaybooksManifest (namespace) {
    if (typeof namespace !== 'string' || !namespace.trim()) {
      throw new Error('namespace is required and must be a non-empty string');
    }
    const ns = namespace.trim();
    return Array.from(this.documents.values()).map((doc) => ({
      id: doc.id,
      title: doc.title,
      uri: `kb://${ns}/${doc.id}`,
      summary: doc.summary || '',
      tools: [...(doc.tools || [])],
      tags: [...(doc.tags || [])],
    }));
  }

  /**
   * Search documents by query
   * @param {string} query - Search query
   * @param {Object} options - Search options
   */
  searchDocuments (query, options = {}) {
    if (!query || typeof query !== 'string') {
      throw new Error('Search query is required and must be a string');
    }

    const contentResults = this.searchIndex.search(query, {
      limit: options.limit || 50,
      suggest: true
    });

    const titleResults = this.titleIndex.search(query, {
      limit: options.limit || 50,
      suggest: true
    });

    const tagResults = this.tagsIndex.search(query, {
      limit: options.limit || 50
    });

    const summaryResults = this.summaryIndex.search(query, {
      limit: options.limit || 50,
      suggest: true
    });

    const toolsResults = this.toolsIndex.search(query, {
      limit: options.limit || 50
    });

    // Combine and score results
    // tools +3, title +3, summary +2, tags +2, content +1
    const combinedResults = new Map();

    contentResults.forEach(id => {
      if (this.documents.has(id)) {
        combinedResults.set(id, { score: 1 });
      }
    });

    titleResults.forEach(id => {
      if (this.documents.has(id)) {
        const existing = combinedResults.get(id) || { score: 0 };
        combinedResults.set(id, { score: existing.score + 3 });
      }
    });

    tagResults.forEach(id => {
      if (this.documents.has(id)) {
        const existing = combinedResults.get(id) || { score: 0 };
        combinedResults.set(id, { score: existing.score + 2 });
      }
    });

    summaryResults.forEach(id => {
      if (this.documents.has(id)) {
        const existing = combinedResults.get(id) || { score: 0 };
        combinedResults.set(id, { score: existing.score + 2 });
      }
    });

    toolsResults.forEach(id => {
      if (this.documents.has(id)) {
        const existing = combinedResults.get(id) || { score: 0 };
        combinedResults.set(id, { score: existing.score + 3 });
      }
    });

    const results = [];
    const searchTerms = query.toLowerCase().split(/\s+/).filter(term => term.length > 0);

    for (const [docId, { score }] of combinedResults.entries()) {
      const doc = this.documents.get(docId);
      if (doc) {
        results.push({
          document: {
            id: doc.id,
            title: doc.title,
            content: options.includeContent ? doc.content : undefined,
            tags: doc.tags,
            metadata: doc.metadata,
            summary: doc.summary,
            tools: doc.tools,
            relatedDocs: doc.relatedDocs,
            createdAt: doc.createdAt,
            updatedAt: doc.updatedAt
          },
          score,
          excerpt: this._generateExcerpt(doc.content, searchTerms)
        });
      }
    }

    results.sort((a, b) => b.score - a.score);

    if (options.limit) {
      return results.slice(0, options.limit);
    }

    return results;
  }

  /**
   * Register a tool that uses this knowledge base
   * @param {Object} tool - Tool instance that has a refreshDescription method
   */
  registerTool (tool) {
    this.associatedTools.add(tool);
  }

  /**
   * Unregister a tool from this knowledge base
   * @param {Object} tool - Tool instance to unregister
   */
  unregisterTool (tool) {
    this.associatedTools.delete(tool);
  }

  /**
   * Refresh descriptions for all tools associated with this knowledge base
   */
  refreshToolDescriptions () {
    for (const tool of this.associatedTools) {
      if (typeof tool.refreshDescription === 'function') {
        tool.refreshDescription();
      }
    }
  }

  /**
   * Get knowledge base statistics
   */
  getStats () {
    const docs = Array.from(this.documents.values());
    const totalDocuments = docs.length;
    const totalWords = docs.reduce((sum, doc) => sum + doc.content.split(/\s+/).length, 0);
    const allTags = docs.flatMap(doc => doc.tags);
    const uniqueTags = [...new Set(allTags)];

    return {
      totalDocuments,
      totalWords,
      uniqueTags: uniqueTags.length,
      tags: uniqueTags,
      averageWordsPerDocument: totalDocuments > 0 ? Math.round(totalWords / totalDocuments) : 0
    };
  }

  /**
   * Private method to index a document for searching using FlexSearch
   */
  _indexDocument (doc) {
    this.searchIndex.add(doc.id, doc.content);
    this.titleIndex.add(doc.id, doc.title);

    if (doc.tags && doc.tags.length > 0) {
      this.tagsIndex.add(doc.id, doc.tags.join(' '));
    }

    if (doc.summary) {
      this.summaryIndex.add(doc.id, doc.summary);
    }

    if (doc.tools && doc.tools.length > 0) {
      this.toolsIndex.add(doc.id, doc.tools.join(' '));
    }
  }

  /**
   * Private method to remove document from FlexSearch indexes
   */
  _removeFromIndex (doc) {
    this.searchIndex.remove(doc.id);
    this.titleIndex.remove(doc.id);
    this.tagsIndex.remove(doc.id);
    this.summaryIndex.remove(doc.id);
    this.toolsIndex.remove(doc.id);
  }

  /**
   * Private method to generate excerpt around search terms
   */
  _generateExcerpt (content, searchTerms, maxLength = 200) {
    const processableContent = content.length > 10000 ? content.substring(0, 10000) : content;
    const text = processableContent.toLowerCase();
    let bestPosition = 0;
    let bestScore = 0;

    for (let i = 0; i < text.length - maxLength; i += 50) {
      const snippet = text.substring(i, i + maxLength);
      let score = 0;
      for (const term of searchTerms) {
        score += (snippet.match(new RegExp(escapeRegExp(term), 'g')) || []).length;
      }
      if (score > bestScore) {
        bestScore = score;
        bestPosition = i;
      }
    }

    const excerpt = processableContent.substring(bestPosition, bestPosition + maxLength);
    return bestPosition > 0 ? '...' + excerpt + '...' : excerpt + '...';
  }
}
