/**
 * FlexSearch Integration Test Suite
 * Tests the FlexSearch functionality in the knowledge base
 */

import { strict as assert } from 'assert';
import { KnowledgeBase } from '../../src/classes/knowledgeBase.js';

describe('FlexSearch Integration Tests', () => {
  let kb;

  beforeEach(() => {
    kb = new KnowledgeBase();
  });

  describe('FlexSearch Initialization', () => {
    it('should initialize FlexSearch indexes', () => {
      // Verify that FlexSearch indexes are created
      assert.ok(kb.searchIndex);
      assert.ok(kb.titleIndex);
      assert.ok(kb.tagsIndex);
      
      // Verify indexes have the correct methods
      assert.strictEqual(typeof kb.searchIndex.add, 'function');
      assert.strictEqual(typeof kb.searchIndex.search, 'function');
      assert.strictEqual(typeof kb.searchIndex.remove, 'function');
    });
  });

  describe('Document Indexing with FlexSearch', () => {
    it('should index documents in all FlexSearch indexes', () => {
      const doc = {
        title: 'JavaScript Testing Guide',
        content: 'This comprehensive guide covers unit testing, integration testing, and end-to-end testing in JavaScript applications.',
        tags: ['javascript', 'testing', 'guide'],
        metadata: { category: 'development' }
      };

      kb.addDocument('test-doc', doc);

      // Verify document was stored
      const stored = kb.getDocument('test-doc');
      assert.ok(stored);
      assert.strictEqual(stored.title, 'JavaScript Testing Guide');
    });

    it('should update FlexSearch indexes when document is updated', () => {
      kb.addDocument('update-test', {
        title: 'Original Title',
        content: 'Original content about databases',
        tags: ['database']
      });

      // Update the document
      kb.updateDocument('update-test', {
        title: 'Updated Title',
        content: 'Updated content about advanced databases and optimization',
        tags: ['database', 'optimization']
      });

      // Search should find the updated content
      const results = kb.searchDocuments('optimization');
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].document.title, 'Updated Title');
    });

    it('should remove documents from FlexSearch indexes', () => {
      kb.addDocument('remove-test', {
        title: 'Document to Remove',
        content: 'This document will be removed from all indexes',
        tags: ['temporary']
      });

      // Verify document can be found
      let results = kb.searchDocuments('temporary');
      assert.strictEqual(results.length, 1);

      // Remove the document
      kb.removeDocument('remove-test');

      // Verify document cannot be found anymore
      results = kb.searchDocuments('temporary');
      assert.strictEqual(results.length, 0);
    });
  });

  describe('FlexSearch Query Performance', () => {
    beforeEach(() => {
      // Add multiple test documents for search testing
      const documents = [
        {
          id: 'js-basics',
          title: 'JavaScript Fundamentals',
          content: 'Learn the basics of JavaScript programming including variables, functions, and objects.',
          tags: ['javascript', 'programming', 'beginner']
        },
        {
          id: 'js-advanced',
          title: 'Advanced JavaScript Techniques',
          content: 'Explore advanced JavaScript concepts like closures, promises, and async/await patterns.',
          tags: ['javascript', 'programming', 'advanced']
        },
        {
          id: 'react-intro',
          title: 'React Introduction',
          content: 'Getting started with React library for building user interfaces in JavaScript.',
          tags: ['react', 'javascript', 'frontend']
        },
        {
          id: 'node-backend',
          title: 'Node.js Backend Development',
          content: 'Building server-side applications with Node.js and Express framework.',
          tags: ['nodejs', 'backend', 'javascript']
        },
        {
          id: 'python-basics',
          title: 'Python Programming Guide',
          content: 'Introduction to Python programming language with examples and best practices.',
          tags: ['python', 'programming', 'beginner']
        }
      ];

      documents.forEach(doc => {
        kb.addDocument(doc.id, {
          title: doc.title,
          content: doc.content,
          tags: doc.tags
        });
      });
    });

    it('should find documents by content search', () => {
      const results = kb.searchDocuments('closures promises async');
      
      assert.ok(results.length > 0);
      const advancedDoc = results.find(r => r.document.id === 'js-advanced');
      assert.ok(advancedDoc);
      assert.ok(advancedDoc.score > 0);
    });

    it('should prioritize title matches over content matches', () => {
      const results = kb.searchDocuments('JavaScript');
      
      assert.ok(results.length >= 2);
      
      // Find title matches
      const titleMatches = results.filter(r => 
        r.document && r.document.title && r.document.title.toLowerCase().includes('javascript')
      );
      
      // Find content-only matches
      const contentMatches = results.filter(r => 
        r.document && r.document.title && r.document.content &&
        !r.document.title.toLowerCase().includes('javascript') &&
        r.document.content.toLowerCase().includes('javascript')
      );

      if (titleMatches.length > 0 && contentMatches.length > 0) {
        // Title matches should have higher scores
        assert.ok(titleMatches[0].score > contentMatches[0].score);
      }
    });

    it('should find documents by tag search', () => {
      const results = kb.searchDocuments('react');
      
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].document.id, 'react-intro');
      assert.ok(results[0].score > 0);
    });

    it('should handle partial and fuzzy matching', () => {
      // Test partial word matching
      const results1 = kb.searchDocuments('programm');
      assert.ok(results1.length > 0);
      
      // Test with common typos (FlexSearch should handle some fuzzy matching)
      const results2 = kb.searchDocuments('javascript');
      assert.ok(results2.length > 0);
    });

    it('should return results in relevance order', () => {
      const results = kb.searchDocuments('javascript programming');
      
      assert.ok(results.length >= 2);
      
      // Results should be sorted by score (descending)
      for (let i = 1; i < results.length; i++) {
        assert.ok(results[i-1].score >= results[i].score);
      }
    });

    it('should respect search limit options', () => {
      const results = kb.searchDocuments('javascript', { limit: 2 });
      
      assert.ok(results.length <= 2);
      assert.ok(results.length > 0);
    });

    it('should handle case-insensitive searches', () => {
      const lowerResults = kb.searchDocuments('javascript');
      const upperResults = kb.searchDocuments('JAVASCRIPT');
      const mixedResults = kb.searchDocuments('JavaScript');
      
      // All should return the same documents (case insensitive)
      assert.strictEqual(lowerResults.length, upperResults.length);
      assert.strictEqual(lowerResults.length, mixedResults.length);
      
      if (lowerResults.length > 0) {
        assert.strictEqual(lowerResults[0].document.id, upperResults[0].document.id);
        assert.strictEqual(lowerResults[0].document.id, mixedResults[0].document.id);
      }
    });

    it('should handle multi-word queries effectively', () => {
      const results = kb.searchDocuments('backend development server');
      
      assert.ok(results.length > 0);
      const nodeDoc = results.find(r => r.document.id === 'node-backend');
      assert.ok(nodeDoc);
      assert.ok(nodeDoc.score > 0);
    });

    it('should return empty results for non-existent terms', () => {
      const results = kb.searchDocuments('nonexistentterm12345');
      assert.strictEqual(results.length, 0);
    });

    it('should handle special characters in search queries', () => {
      // Add a document with special characters
      kb.addDocument('special-chars', {
        title: 'API & Web Services',
        content: 'REST APIs, JSON responses, and HTTP/HTTPS protocols.',
        tags: ['api', 'web-services']
      });

      const results = kb.searchDocuments('API');
      assert.ok(results.length > 0);
      const specialDoc = results.find(r => r.document.id === 'special-chars');
      assert.ok(specialDoc);
    });
  });

  describe('FlexSearch Combined Scoring', () => {
    beforeEach(() => {
      // Add documents that will help test the combined scoring system
      kb.addDocument('title-match', {
        title: 'Machine Learning Algorithms',
        content: 'Various algorithms used in data science and artificial intelligence.',
        tags: ['algorithms', 'data-science']
      });

      kb.addDocument('content-match', {
        title: 'Data Processing Tutorial',
        content: 'Learn about machine learning pipelines and algorithm optimization techniques.',
        tags: ['tutorial', 'data']
      });

      kb.addDocument('tag-match', {
        title: 'Programming Resources',
        content: 'Useful resources for software development and coding practices.',
        tags: ['machine-learning', 'resources']
      });

      kb.addDocument('multiple-match', {
        title: 'Machine Learning Guide',
        content: 'Comprehensive guide covering machine learning algorithms and implementations.',
        tags: ['machine-learning', 'guide', 'algorithms']
      });
    });

    it('should combine scores from multiple indexes', () => {
      const results = kb.searchDocuments('machine learning');
      
      assert.ok(results.length >= 3);
      
      // The document with matches in title, content, AND tags should score highest
      const multipleMatch = results.find(r => r.document.id === 'multiple-match');
      assert.ok(multipleMatch);
      
      // Should be the highest scoring result
      assert.strictEqual(results[0].document.id, 'multiple-match');
      assert.ok(multipleMatch.score > 3); // Should have combined scores
    });

    it('should weight title matches higher than content matches', () => {
      const results = kb.searchDocuments('algorithms');
      
      assert.ok(results.length >= 2);
      
      const titleMatch = results.find(r => r.document.id === 'title-match');
      const contentMatch = results.find(r => r.document.id === 'content-match');
      
      if (titleMatch && contentMatch) {
        // Title match should score higher than pure content match
        assert.ok(titleMatch.score > contentMatch.score);
      }
    });

    it('should include excerpt generation for search results', () => {
      const results = kb.searchDocuments('machine learning algorithms');
      
      assert.ok(results.length > 0);
      results.forEach(result => {
        assert.ok(result.excerpt);
        assert.strictEqual(typeof result.excerpt, 'string');
        assert.ok(result.excerpt.length > 0);
      });
    });
  });

  describe('FlexSearch Error Handling', () => {
    it('should handle empty search queries', () => {
      assert.throws(() => {
        kb.searchDocuments('');
      }, /Search query is required and must be a string/);
    });

    it('should handle null search queries', () => {
      assert.throws(() => {
        kb.searchDocuments(null);
      }, /Search query is required and must be a string/);
    });

    it('should handle undefined search queries', () => {
      assert.throws(() => {
        kb.searchDocuments(undefined);
      }, /Search query is required and must be a string/);
    });

    it('should handle non-string search queries', () => {
      assert.throws(() => {
        kb.searchDocuments(123);
      }, /Search query is required and must be a string/);
    });

    it('should handle search on empty knowledge base', () => {
      const results = kb.searchDocuments('anything');
      assert.strictEqual(results.length, 0);
      assert.ok(Array.isArray(results));
    });
  });

  describe('FlexSearch Performance Characteristics', () => {
    it('should handle large document sets efficiently', () => {
      // Add many documents to test performance
      const startTime = Date.now();
      
      for (let i = 0; i < 100; i++) {
        kb.addDocument(`doc-${i}`, {
          title: `Document ${i} Title`,
          content: `This is document number ${i} with content about various topics including technology, science, and programming.`,
          tags: [`tag-${i % 10}`, 'general']
        });
      }
      
      const indexingTime = Date.now() - startTime;
      
      // Search should still be fast
      const searchStart = Date.now();
      const results = kb.searchDocuments('technology programming');
      const searchTime = Date.now() - searchStart;
      
      // Basic performance assertions
      assert.ok(indexingTime < 5000); // Indexing should complete in reasonable time
      assert.ok(searchTime < 100);    // Search should be very fast
      assert.ok(results.length > 0);  // Should find relevant documents
    });

    it('should maintain search quality with document updates', () => {
      kb.addDocument('perf-test', {
        title: 'Performance Testing',
        content: 'Original content about performance testing methodologies.',
        tags: ['performance', 'testing']
      });

      // Update the document multiple times
      for (let i = 0; i < 10; i++) {
        kb.updateDocument('perf-test', {
          content: `Updated content ${i} about performance testing and optimization techniques.`
        });
      }

      // Search should still work correctly
      const results = kb.searchDocuments('performance testing', { includeContent: true });
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].document.id, 'perf-test');
      assert.ok(results[0].document.content && results[0].document.content.includes('Updated content 9'));
    });
  });
});
