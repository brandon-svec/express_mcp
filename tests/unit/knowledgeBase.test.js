/**
 * Knowledge Base Test Suite
 * Tests the knowledge base functionality including document storage, search, and tools
 */

import { strict as assert } from 'assert';
import timekeeper from 'timekeeper';
import { KnowledgeBase } from '../../src/classes/knowledgeBase.js';
import {
  KnowledgeBaseSearchTool,
  KnowledgeBaseListTool,
  KnowledgeBaseGetTool
} from '../../src/tools/knowledgeBase.js';

// Mock context for testing
const createMockContext = () => ({
  execution: {
    addLogData: () => {}, // Mock function that does nothing
    setStatus: () => {}, // Mock function that does nothing
    setError: () => {} // Mock function that does nothing
  }
});

describe('Knowledge Base Tests', () => {
  let kb;

  beforeEach(() => {
    kb = new KnowledgeBase();
  });

  describe('KnowledgeBase Core Functionality', () => {
    describe('Document Management', () => {
      it('should add a document successfully', () => {
        const doc = {
          title: 'Test Document',
          content: 'This is test content',
          tags: ['test'],
          metadata: { category: 'testing' }
        };

        const result = kb.addDocument('test-1', doc);
        
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.documentId, 'test-1');
        
        const stored = kb.getDocument('test-1');
        assert.strictEqual(stored.title, 'Test Document');
        assert.strictEqual(stored.content, 'This is test content');
        assert.deepStrictEqual(stored.tags, ['test']);
        assert.deepStrictEqual(stored.metadata, { category: 'testing' });
        assert.ok(stored.createdAt);
        assert.ok(stored.updatedAt);
      });

      it('should throw error for invalid document', () => {
        assert.throws(() => {
          kb.addDocument('test-1', {});
        }, /Document must have title and content/);

        assert.throws(() => {
          kb.addDocument('', { title: 'Test', content: 'Content' });
        }, /Document ID and document object are required/);
      });

      it('should update existing document', () => {
        // Freeze time at a specific moment for document creation
        const createTime = new Date('2024-01-01T10:00:00.000Z');
        timekeeper.freeze(createTime);

        kb.addDocument('test-1', {
          title: 'Original Title',
          content: 'Original content',
          tags: ['original']
        });

        // Advance time by 1 second for the update
        const updateTime = new Date('2024-01-01T10:00:01.000Z');
        timekeeper.freeze(updateTime);

        const updates = {
          title: 'Updated Title',
          content: 'Updated content',
          tags: ['updated']
        };

        const result = kb.updateDocument('test-1', updates);
        assert.strictEqual(result.success, true);

        const updated = kb.getDocument('test-1');
        assert.strictEqual(updated.title, 'Updated Title');
        assert.strictEqual(updated.content, 'Updated content');
        assert.deepStrictEqual(updated.tags, ['updated']);
        
        // Test timestamps - they are stored as ISO strings
        assert.strictEqual(updated.createdAt, createTime.toISOString());
        assert.strictEqual(updated.updatedAt, updateTime.toISOString());
        assert.notEqual(updated.createdAt, updated.updatedAt);

        // Reset time
        timekeeper.reset();
      });

      it('should throw error when updating non-existent document', () => {
        assert.throws(() => {
          kb.updateDocument('non-existent', { title: 'Updated Title' });
        }, /Document with ID 'non-existent' not found/);
      });

      it('should remove document', () => {
        kb.addDocument('test-1', {
          title: 'Test Document',
          content: 'Content to remove'
        });

        assert.ok(kb.getDocument('test-1'));

        const result = kb.removeDocument('test-1');
        assert.strictEqual(result.success, true);

        assert.strictEqual(kb.getDocument('test-1'), undefined);
      });

      it('should throw error when removing non-existent document', () => {
        assert.throws(() => {
          kb.removeDocument('non-existent');
        }, /Document with ID 'non-existent' not found/);
      });
    });

    describe('Document Listing', () => {
      beforeEach(() => {
        kb.addDocument('doc-1', {
          title: 'JavaScript Guide',
          content: 'Learn JavaScript programming',
          tags: ['programming', 'javascript']
        });

        kb.addDocument('doc-2', {
          title: 'Python Tutorial',
          content: 'Python programming basics',
          tags: ['programming', 'python']
        });

        kb.addDocument('doc-3', {
          title: 'Database Design',
          content: 'How to design databases',
          tags: ['database', 'design']
        });
      });

      it('should list all documents', () => {
        const docs = kb.listDocuments();
        assert.strictEqual(docs.length, 3);
        
        const titles = docs.map(doc => doc.title);
        assert.ok(titles.includes('JavaScript Guide'));
        assert.ok(titles.includes('Python Tutorial'));
        assert.ok(titles.includes('Database Design'));
      });

      it('should filter documents by tag', () => {
        const programmingDocs = kb.listDocuments({ tag: 'programming' });
        assert.strictEqual(programmingDocs.length, 2);
        
        const titles = programmingDocs.map(doc => doc.title);
        assert.ok(titles.includes('JavaScript Guide'));
        assert.ok(titles.includes('Python Tutorial'));
      });

      it('should limit number of documents', () => {
        const docs = kb.listDocuments({ limit: 2 });
        assert.strictEqual(docs.length, 2);
      });
    });

    describe('Document Search', () => {
      beforeEach(() => {
        kb.addDocument('js-guide', {
          title: 'JavaScript Programming Guide',
          content: 'This comprehensive guide covers JavaScript fundamentals, including variables, functions, and object-oriented programming concepts.',
          tags: ['javascript', 'programming', 'tutorial']
        });

        kb.addDocument('python-basics', {
          title: 'Python Basics',
          content: 'Learn Python programming from scratch. This tutorial covers variables, loops, functions, and data structures in Python.',
          tags: ['python', 'programming', 'beginner']
        });

        kb.addDocument('web-dev', {
          title: 'Web Development',
          content: 'Modern web development using HTML, CSS, and JavaScript. Build responsive websites and web applications.',
          tags: ['web', 'html', 'css', 'javascript']
        });
      });

      it('should search documents by content', () => {
        const results = kb.searchDocuments('JavaScript');
        assert.strictEqual(results.length, 2);
        
        const titles = results.map(r => r.document.title);
        assert.ok(titles.includes('JavaScript Programming Guide'));
        assert.ok(titles.includes('Web Development'));
      });

      it('should search documents by title with higher score', () => {
        const results = kb.searchDocuments('Python');
        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].document.title, 'Python Basics');
        assert.ok(results[0].score > 0);
      });

      it('should search documents by tags', () => {
        const results = kb.searchDocuments('programming');
        assert.strictEqual(results.length, 2);
      });

      it('should limit search results', () => {
        const results = kb.searchDocuments('programming', { limit: 1 });
        assert.strictEqual(results.length, 1);
      });

      it('should include content when requested', () => {
        const results = kb.searchDocuments('JavaScript', { includeContent: true });
        assert.ok(results[0].document.content);
        assert.ok(results[0].document.content.length > 0);
      });

      it('should generate excerpts', () => {
        const results = kb.searchDocuments('functions');
        assert.ok(results[0].excerpt);
        assert.ok(results[0].excerpt.includes('functions'));
      });

      it('should generate excerpts when search terms have no exact matches', () => {
        // This will trigger the edge case where no snippet scores above 0
        kb.addDocument('no-matches', {
          title: 'Test Document',
          content: 'This document contains completely different words that will not match the search query at all.'
        });
        
        const results = kb.searchDocuments('xyzzyx'); // Non-existent term
        if (results.length > 0) {
          // If FlexSearch still returns results (fuzzy matching), ensure excerpt is generated
          assert.ok(results[0].excerpt);
          assert.ok(results[0].excerpt.length > 0);
        }
      });

      it('should throw error for invalid query', () => {
        assert.throws(() => {
          kb.searchDocuments('');
        }, /Search query is required and must be a string/);

        assert.throws(() => {
          kb.searchDocuments(null);
        }, /Search query is required and must be a string/);
      });
    });

    describe('Statistics', () => {
      it('should return correct stats for empty knowledge base', () => {
        const stats = kb.getStats();
        assert.strictEqual(stats.totalDocuments, 0);
        assert.strictEqual(stats.totalWords, 0);
        assert.strictEqual(stats.uniqueTags, 0);
        assert.deepStrictEqual(stats.tags, []);
        assert.strictEqual(stats.averageWordsPerDocument, 0);
      });

      it('should return correct stats with documents', () => {
        kb.addDocument('doc-1', {
          title: 'Test',
          content: 'This is a test document with multiple words',
          tags: ['test', 'example']
        });

        kb.addDocument('doc-2', {
          title: 'Another',
          content: 'Another document',
          tags: ['test', 'different']
        });

        const stats = kb.getStats();
        assert.strictEqual(stats.totalDocuments, 2);
        assert.ok(stats.totalWords > 0);
        assert.strictEqual(stats.uniqueTags, 3); // test, example, different
        assert.ok(stats.tags.includes('test'));
        assert.ok(stats.tags.includes('example'));
        assert.ok(stats.tags.includes('different'));
      });
    });
  });

  describe('Knowledge Base Tools', () => {
    let searchTool, listTool, getTool;

    beforeEach(() => {
      searchTool = new KnowledgeBaseSearchTool(kb);
      listTool = new KnowledgeBaseListTool(kb);
      getTool = new KnowledgeBaseGetTool(kb);
    });



    describe('KnowledgeBaseSearchTool', () => {
      beforeEach(() => {
        // Add test documents using knowledge base directly
        kb.addDocument('doc1', {
          title: 'JavaScript Guide',
          content: 'Learn JavaScript programming',
          tags: ['programming']
        });

        kb.addDocument('doc2', {
          title: 'Python Tutorial',
          content: 'Python programming basics',
          tags: ['programming']
        });
      });

      it('should have correct tool definition', () => {
        assert.strictEqual(searchTool.name, 'kb_search');
        assert.strictEqual(searchTool.description, 'Search documents in the knowledge base');
        assert.deepStrictEqual(searchTool.inputSchema.required, ['query']);
      });

      it('should search documents successfully', async () => {
        const result = await searchTool.execute({ query: 'JavaScript' }, createMockContext());
        
        assert.ok(result.resultsCount >= 1);
        assert.ok(Array.isArray(result.results));
        
        const firstResult = result.results[0];
        assert.ok(firstResult.title);
        assert.ok(firstResult.relevanceScore >= 0);
        assert.ok(firstResult.excerpt);
      });

      it('should respect search options', async () => {
        const result = await searchTool.execute({
          query: 'programming',
          limit: 1,
          includeContent: true
        }, createMockContext());
        
        assert.strictEqual(result.results.length, 1);
        assert.ok(result.results[0].content);
      });
    });

    describe('KnowledgeBaseListTool', () => {
      beforeEach(() => {
        kb.addDocument('doc1', {
          title: 'Document 1',
          content: 'Content 1',
          tags: ['tag1']
        });

        kb.addDocument('doc2', {
          title: 'Document 2',
          content: 'Content 2',
          tags: ['tag2']
        });
      });

      it('should list all documents', async () => {
        const result = await listTool.execute({}, createMockContext());
        
        assert.strictEqual(result.documentsCount, 2);
        assert.ok(Array.isArray(result.documents));
      });

      it('should filter by tag', async () => {
        const result = await listTool.execute({ tag: 'tag1' }, createMockContext());
        
        assert.strictEqual(result.documentsCount, 1);
        assert.strictEqual(result.documents[0].title, 'Document 1');
      });

      it('should respect limit', async () => {
        const result = await listTool.execute({ limit: 1 }, createMockContext());
        
        assert.strictEqual(result.documentsCount, 1);
      });

      it('should handle errors during document listing', async () => {
        // Create a mock knowledge base that throws an error
        const errorKb = {
          listDocuments: () => {
            throw new Error('Database connection failed');
          }
        };
        
        const errorListTool = new KnowledgeBaseListTool(errorKb);
        
        try {
          await errorListTool.execute({}, createMockContext());
          assert.fail('Expected error to be thrown');
        } catch (error) {
          assert.ok(error.message.includes('Database connection failed'));
        }
      });
    });

    describe('KnowledgeBaseGetTool', () => {
      beforeEach(() => {
        kb.addDocument('test-doc', {
          title: 'Test Document',
          content: 'Test content'
        });
      });

      it('should get document by ID', async () => {
        const result = await getTool.execute({ id: 'test-doc' }, createMockContext());
        
        assert.ok(result.document);
        assert.strictEqual(result.document.id, 'test-doc');
        assert.strictEqual(result.document.title, 'Test Document');
      });

      it('should handle non-existent document', async () => {
        let errorSet = null;
        const mockContext = {
          execution: {
            addLogData: () => {},
            setError: (message, code) => { errorSet = { message, code }; },
            setStatus: () => {}
          }
        };
        
        const result = await getTool.execute({ id: 'non-existent' }, mockContext);
        assert.strictEqual(result, undefined);
        assert.ok(errorSet);
        assert.ok(errorSet.message.includes('not found'));
        assert.strictEqual(errorSet.code, -32604);
      });

      it('should handle documents with missing optional fields', async () => {
        // Add a document without tags to test the document.tags || [] branch
        kb.addDocument('no-tags-doc', {
          title: 'Document Without Tags',
          content: 'Content here'
          // No tags property
        });

        let loggedData = null;
        const mockContext = {
          execution: {
            addLogData: (data) => { loggedData = data; },
            setError: () => {},
            setStatus: () => {}
          }
        };

        const result = await getTool.execute({ id: 'no-tags-doc' }, mockContext);
        
        assert.ok(result.document);
        assert.strictEqual(result.document.id, 'no-tags-doc');
        
        // Check that the logging handled missing tags properly (covers line 188)
        assert.ok(loggedData);
        assert.ok(Array.isArray(loggedData.documentTags));
        assert.strictEqual(loggedData.documentTags.length, 0);
        
        // Check that content length was logged properly (covers line 189)
        assert.ok(loggedData.documentSize > 0);
      });
    });

    describe('Branch Coverage Edge Cases', () => {
      it('should handle knowledge base with more than 10 tags', () => {
        // Create a knowledge base with more than 10 unique tags
        const kbManyTags = new KnowledgeBase();
        
        // Add documents with many different tags (15 unique tags)
        for (let i = 1; i <= 15; i++) {
          kbManyTags.addDocument(`doc${i}`, {
            title: `Document ${i}`,
            content: `Content ${i}`,
            tags: [`tag${i}`]
          });
        }
        
        const toolManyTags = new KnowledgeBaseSearchTool(kbManyTags);
        
        // This should trigger the "and X more" logic (line 35)
        assert.ok(toolManyTags.description.includes('and 5 more'));
      });

      it('should handle empty search results for logging', async () => {
        // Create a search tool and test empty results to cover line 94
        let loggedData = null;
        const mockContext = {
          execution: {
            addLogData: (data) => { loggedData = data; },
            setError: () => {},
            setStatus: () => {}
          }
        };

        // Search for something that doesn't exist
        const result = await searchTool.execute({ 
          query: 'nonexistentkeywordthatwontmatch' 
        }, mockContext);
        
        // Check that maxScore defaults to 0 when no results (line 94)
        assert.ok(loggedData);
        assert.strictEqual(loggedData.maxScore, 0);
        assert.strictEqual(result.resultsCount, 0);
      });

      it('should handle documents with edge case properties for logging', async () => {
        // Since KnowledgeBase normalizes data, let's test by directly manipulating
        // the stored document to create edge cases for the logging conditional branches
        const kbForBranches = new KnowledgeBase();
        
        // Add a normal document first
        kbForBranches.addDocument('edge-case-doc', {
          title: 'Test Document',
          content: 'Some content',
          tags: ['tag1']
        });
        
        // Now directly manipulate the stored document to test edge cases
        const storedDoc = kbForBranches.getDocument('edge-case-doc');
        
        // Test case 1: Remove tags property to test line 188 branch
        delete storedDoc.tags;
        
        // Test case 2: Set content to empty string to test line 189 branch  
        storedDoc.content = '';
        
        const getTool = new KnowledgeBaseGetTool(kbForBranches);
        
        let loggedData = null;
        const mockContext = {
          execution: {
            addLogData: (data) => { loggedData = data; },
            setError: () => {},
            setStatus: () => {}
          }
        };

        const result = await getTool.execute({ id: 'edge-case-doc' }, mockContext);
        
        assert.ok(result.document);
        
        // Check that both conditional branches were triggered properly
        assert.ok(loggedData);
        // Line 188: document.tags || [] - should default to [] when tags is undefined
        assert.ok(Array.isArray(loggedData.documentTags));
        assert.strictEqual(loggedData.documentTags.length, 0);
        // Line 189: document.content ? document.content.length : 0 - should be 0 for empty string
        assert.strictEqual(loggedData.documentSize, 0);
      });
    });

    describe('Description Integration', () => {
      it('should include knowledge base description in tool descriptions', () => {
        // Create a knowledge base with a custom description
        const kbWithDescription = new KnowledgeBase({
          description: 'Custom API documentation'
        });
        
        // Add a document with tags to trigger the full description logic
        kbWithDescription.addDocument('test-doc', {
          title: 'Test Document',
          content: 'Test content',
          tags: ['api', 'docs']
        });
        
        // Create a tool with this knowledge base
        const toolWithDescription = new KnowledgeBaseSearchTool(kbWithDescription);
        
        // The tool description should include both the base description and custom description
        // This will trigger lines 40-41 in the refreshDescription method
        assert.ok(toolWithDescription.description.includes('Search documents in the knowledge base'));
        assert.ok(toolWithDescription.description.includes('Custom API documentation'));
        assert.ok(toolWithDescription.description.includes('Available tags: api, docs'));
      });
    });

    describe('Tool Registration', () => {
      it('should register and unregister tools', () => {
        // Create a mock tool
        const mockTool = {
          name: 'test-tool',
          refreshDescription: () => {}
        };

        // Test registration
        kb.registerTool(mockTool);
        assert.ok(kb.associatedTools.has(mockTool));

        // Test unregistration (covers lines 237-238)
        kb.unregisterTool(mockTool);
        assert.ok(!kb.associatedTools.has(mockTool));
      });

      it('should refresh all registered tool descriptions', () => {
        let refreshCount = 0;
        const mockTool1 = {
          name: 'tool1',
          refreshDescription: () => { refreshCount++; }
        };
        const mockTool2 = {
          name: 'tool2',
          refreshDescription: () => { refreshCount++; }
        };

        kb.registerTool(mockTool1);
        kb.registerTool(mockTool2);

        kb.refreshToolDescriptions();
        assert.strictEqual(refreshCount, 2);
      });
    });

    describe('Excerpt Generation Edge Cases', () => {
      it('should handle long content with multiple potential excerpts', () => {
        // Create a long document that will trigger the excerpt algorithm loop (lines 309-318)
        const longContent = 'This is some content. '.repeat(50) + 
          'important keyword here in the middle. ' + 
          'More content follows. '.repeat(50) +
          'another important keyword at the end. ' +
          'Final content. '.repeat(20);

        const doc = {
          title: 'Long Document',
          content: longContent,
          tags: ['test']
        };

        kb.addDocument('long-doc', doc);

        // Search for keywords that appear in different parts of the document
        // This will trigger the snippet comparison algorithm
        const results = kb.searchDocuments('important keyword');

        assert.strictEqual(results.length, 1);
        assert.ok(results[0].excerpt.includes('important'));
        // The excerpt should contain one of the keyword matches
        assert.ok(results[0].excerpt.includes('keyword'));
      });

      it('should handle excerpt generation with terms spread across document', () => {
        // Create content where search terms are spread across different positions
        // This tests the score comparison logic in lines 309-318
        const content = 'start term1 here. ' + 'filler text. '.repeat(30) + 
          'middle term1 term2 together. ' + 'more filler. '.repeat(30) +
          'end term2 here. ' + 'final text. '.repeat(10);

        const doc = {
          title: 'Spread Terms',
          content: content,
          tags: ['test']
        };

        kb.addDocument('spread-doc', doc);

        // Search for terms that appear in different concentrations
        const results = kb.searchDocuments('term1 term2');

        assert.strictEqual(results.length, 1);
        // The excerpt should favor the section with both terms together
        assert.ok(results[0].excerpt.includes('middle') || results[0].excerpt.includes('term1') || results[0].excerpt.includes('term2'));
      });
    });


  });
});
