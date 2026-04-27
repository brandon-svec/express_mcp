import { BaseTool } from '../classes/baseTool.js';

/**
 * Base class for knowledge base tools with shared functionality
 */
class BaseKnowledgeBaseTool extends BaseTool {
  constructor(name, description, knowledgeBase) {
    super(name, description);
    this.knowledgeBase = knowledgeBase;
    this.baseDescription = description;
    
    // Register this tool with the knowledge base (if method exists)
    if (typeof this.knowledgeBase.registerTool === 'function') {
      this.knowledgeBase.registerTool(this);
    }
    
    // Initialize description with current state
    this.refreshDescription();
  }

  /**
   * Update the tool description based on current knowledge base state
   */
  refreshDescription() {
    // Handle cases where knowledge base might be a mock or incomplete object
    if (typeof this.knowledgeBase.getStats !== 'function') {
      return; // Can't refresh without stats method
    }
    
    const stats = this.knowledgeBase.getStats();
    let fullDescription = this.baseDescription;
    
    if (stats.tags && stats.tags.length > 0) {
      const tagsList = stats.tags.slice(0, 10).join(', '); // Limit to first 10 tags
      const moreTags = stats.tags.length > 10 ? ` and ${stats.tags.length - 10} more` : '';
      fullDescription += `. Available tags: ${tagsList}${moreTags}`;
    }
    
    if (this.knowledgeBase.description) {
      fullDescription += `. ${this.knowledgeBase.description}`;
    }

    // Update the actual description property that the tool registry uses
    this.description = fullDescription;
  }
}

/**
 * Tool for searching the knowledge base
 */
export class KnowledgeBaseSearchTool extends BaseKnowledgeBaseTool {
  constructor(knowledgeBase) {
    const baseDescription = 'Search documents in the knowledge base';
    super('kb_search', baseDescription, knowledgeBase);
    this.inputSchema = {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query to find relevant documents'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return',
          default: 10,
          minimum: 1,
          maximum: 50
        },
        includeContent: {
          type: 'boolean',
          description: 'Whether to include full document content in results',
          default: false
        }
      },
      required: ['query']
    };
  }

  async execute(args, context) {
    const { execution } = context;
    const { query, limit = 10, includeContent = false } = args;
    
    // Log the search query
    execution.addLogData({
      query,
      searchOptions: { limit, includeContent }
    });
    
    const results = await this.knowledgeBase.searchDocuments(query, { limit, includeContent });
    
    // Log the search results
    execution.addLogData({
      resultsCount: results.length,
      maxScore: results.length > 0 ? Math.max(...results.map(r => r.score)) : 0
    });
    
    const response = {
      resultsCount: results.length,
      results: results.map(result => ({
        ...result.document,
        relevanceScore: result.score,
        excerpt: result.excerpt
      }))
    };
    
    return response;
  }
}

/**
 * Tool for listing documents in the knowledge base
 */
export class KnowledgeBaseListTool extends BaseKnowledgeBaseTool {
  constructor(knowledgeBase) {
    const baseDescription = 'List documents in the knowledge base';
    super('kb_list', baseDescription, knowledgeBase);
    this.inputSchema = {
      type: 'object',
      properties: {
        tag: {
          type: 'string',
          description: 'Filter documents by tag'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of documents to return',
          default: 20,
          minimum: 1,
          maximum: 100
        }
      }
    };
  }

  async execute(args) {
    const { tag, limit = 20 } = args;
    
    const documents = await this.knowledgeBase.listDocuments({ tag, limit });
    
    const response = {
      documentsCount: documents.length,
      documents
    };
    
    return response;
  }
}

/**
 * Tool for getting a specific document from the knowledge base
 */
export class KnowledgeBaseGetTool extends BaseKnowledgeBaseTool {
  constructor(knowledgeBase) {
    const baseDescription = 'Get a specific document from the knowledge base';
    super('kb_get', baseDescription, knowledgeBase);
    this.inputSchema = {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Document ID to retrieve'
        }
      },
      required: ['id']
    };
  }

  async execute(args, context) {
    const { execution } = context;
    const { id } = args;
    
    // Log the document request
    execution.addLogData({
      requestedDocumentId: id
    });
    
    const document = await this.knowledgeBase.getDocument(id);
    
    if (!document) {
      execution.setError(`Document with ID '${id}' not found`, -32604);
      return;
    }
    
    // Log the retrieved document
    execution.addLogData({
      documentId: document.id,
      documentTitle: document.title,
      documentTags: document.tags || [],
      documentSize: document.content ? document.content.length : 0
    });
    
    const response = {
      document
    };
    
    return response;
  }
}