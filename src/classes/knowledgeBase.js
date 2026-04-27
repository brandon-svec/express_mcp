import { Index } from 'flexsearch';

/**
 * Knowledge base storage class
 * Manages document storage and retrieval using FlexSearch
 */
export class KnowledgeBase {
  constructor(options = {}) {
    this.documents = new Map();
    this.description = options.description;
    this.associatedTools = new Set(); // Track tools that use this knowledge base
    
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
  }

  /**
   * Add a document to the knowledge base
   * @param {string} id - Unique document identifier
   * @param {Object} document - Document object with title, content, metadata
   */
  addDocument(id, document) {
    if (!id || !document) {
      throw new Error('Document ID and document object are required');
    }

    if (!document.title || !document.content) {
      throw new Error('Document must have title and content');
    }

    const doc = {
      id,
      title: document.title,
      content: document.content,
      metadata: document.metadata || {},
      tags: document.tags || [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.documents.set(id, doc);
    this._indexDocument(doc);

    return { success: true, documentId: id };
  }

  /**
   * Update an existing document
   * @param {string} id - Document ID
   * @param {Object} updates - Document updates
   */
  updateDocument(id, updates) {
    const existing = this.documents.get(id);
    if (!existing) {
      throw new Error(`Document with ID '${id}' not found`);
    }

    const updated = {
      ...existing,
      ...updates,
      id: existing.id, // Preserve ID
      createdAt: existing.createdAt, // Preserve creation date
      updatedAt: new Date().toISOString()
    };

    this.documents.set(id, updated);
    this._indexDocument(updated);

    return { success: true, documentId: id };
  }

  /**
   * Remove a document from the knowledge base
   * @param {string} id - Document ID
   */
  removeDocument(id) {
    const doc = this.documents.get(id);
    if (!doc) {
      throw new Error(`Document with ID '${id}' not found`);
    }

    this.documents.delete(id);
    this._removeFromIndex(doc);

    return { success: true, documentId: id };
  }

  /**
   * Get a document by ID
   * @param {string} id - Document ID
   */
  getDocument(id) {
    return this.documents.get(id);
  }

  /**
   * List all documents
   * @param {Object} options - Filtering options
   */
  listDocuments(options = {}) {
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
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt
    }));
  }

  /**
   * Search documents by query
   * @param {string} query - Search query
   * @param {Object} options - Search options
   */
  searchDocuments(query, options = {}) {
    if (!query || typeof query !== 'string') {
      throw new Error('Search query is required and must be a string');
    }

    // Use FlexSearch to get search results with scores
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

    // Combine and score results
    const combinedResults = new Map();

    // Process content results (base score)
    contentResults.forEach(id => {
      if (this.documents.has(id)) {
        combinedResults.set(id, { score: 1 });
      }
    });

    // Process title results (higher score)
    titleResults.forEach(id => {
      if (this.documents.has(id)) {
        const existing = combinedResults.get(id) || { score: 0 };
        combinedResults.set(id, { score: existing.score + 3 });
      }
    });

    // Process tag results (medium score)
    tagResults.forEach(id => {
      if (this.documents.has(id)) {
        const existing = combinedResults.get(id) || { score: 0 };
        combinedResults.set(id, { score: existing.score + 2 });
      }
    });

    // Build final results
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
            createdAt: doc.createdAt,
            updatedAt: doc.updatedAt
          },
          score,
          excerpt: this._generateExcerpt(doc.content, searchTerms)
        });
      }
    }

    // Sort by relevance score (descending)
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
  registerTool(tool) {
    this.associatedTools.add(tool);
  }

  /**
   * Unregister a tool from this knowledge base
   * @param {Object} tool - Tool instance to unregister
   */
  unregisterTool(tool) {
    this.associatedTools.delete(tool);
  }

  /**
   * Refresh descriptions for all tools associated with this knowledge base
   */
  refreshToolDescriptions() {
    for (const tool of this.associatedTools) {
      if (typeof tool.refreshDescription === 'function') {
        tool.refreshDescription();
      }
    }
  }

  /**
   * Get knowledge base statistics
   */
  getStats() {
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
  _indexDocument(doc) {
    // Index content in the main search index
    this.searchIndex.add(doc.id, doc.content);
    
    // Index title separately for higher relevance
    this.titleIndex.add(doc.id, doc.title);
    
    // Index tags for exact matching
    if (doc.tags && doc.tags.length > 0) {
      this.tagsIndex.add(doc.id, doc.tags.join(' '));
    }
  }

  /**
   * Private method to remove document from FlexSearch indexes
   */
  _removeFromIndex(doc) {
    this.searchIndex.remove(doc.id);
    this.titleIndex.remove(doc.id);
    this.tagsIndex.remove(doc.id);
  }



  /**
   * Private method to generate excerpt around search terms
   */
  _generateExcerpt(content, searchTerms, maxLength = 200) {
    // Add a reasonable upper limit to avoid processing extremely large documents
    const processableContent = content.length > 10000 ? content.substring(0, 10000) : content;
    const text = processableContent.toLowerCase();
    let bestPosition = 0;
    let bestScore = 0;

    // Find the position with most search term matches
    for (let i = 0; i < text.length - maxLength; i += 50) {
      const snippet = text.substring(i, i + maxLength);
      let score = 0;
      for (const term of searchTerms) {
        score += (snippet.match(new RegExp(term, 'g')) || []).length;
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
