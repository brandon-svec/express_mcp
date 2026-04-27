/**
 * FlexSearch MCP Integration Test Suite
 * Tests FlexSearch functionality through MCP protocol tools
 */

import { strict as assert } from 'assert';
import express from 'express';
import request from 'supertest';
import { ExpressMcp } from '../../src/classes/expressMcp.js';
import { getTestExpressMcpOptions } from '../config.js';

describe('FlexSearch MCP Integration Tests', () => {
  let app;
  let expressMcp;
  let agent;

  beforeEach(() => {
    expressMcp = new ExpressMcp(getTestExpressMcpOptions());
    app = express();
    app.use(express.json());
    app.use('/mcp', expressMcp.router());
    agent = request(app);

    // Pre-populate with test documents for search testing
    expressMcp.addDocument('flexsearch-doc1', {
      title: 'Advanced React Patterns',
      content: 'Learn about higher-order components, render props, and custom hooks in React development.',
      tags: ['react', 'javascript', 'frontend', 'patterns'],
      metadata: { difficulty: 'advanced', category: 'web-development' }
    });

    expressMcp.addDocument('flexsearch-doc2', {
      title: 'Node.js Performance Optimization',
      content: 'Techniques for optimizing Node.js applications including clustering, caching, and profiling.',
      tags: ['nodejs', 'performance', 'backend', 'optimization'],
      metadata: { difficulty: 'intermediate', category: 'backend' }
    });

    expressMcp.addDocument('flexsearch-doc3', {
      title: 'React Testing Strategies',
      content: 'Comprehensive guide to testing React applications with Jest, React Testing Library, and Cypress.',
      tags: ['react', 'testing', 'jest', 'frontend'],
      metadata: { difficulty: 'intermediate', category: 'testing' }
    });

    expressMcp.addDocument('flexsearch-doc4', {
      title: 'JavaScript Performance Tips',
      content: 'Performance optimization techniques for JavaScript including memory management and execution speed.',
      tags: ['javascript', 'performance', 'optimization'],
      metadata: { difficulty: 'advanced', category: 'performance' }
    });
  });

  describe('kb_search Tool with FlexSearch', () => {
    it('should find documents using FlexSearch content matching', async () => {
      const response = await agent
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name: 'kb_search',
            arguments: {
              query: 'React components hooks',
              limit: 5
            }
          },
          id: 1
        });

      assert.strictEqual(response.status, 200);
      const result = JSON.parse(response.body.result.content[0].text);

      assert.ok(result.resultsCount > 0);
      
      // Should find the React patterns document
      const reactDoc = result.results.find(r => r.id === 'flexsearch-doc1');
      assert.ok(reactDoc, 'Should find React patterns document');
      assert.ok(reactDoc.relevanceScore > 0);
      assert.ok(reactDoc.excerpt.length > 0);
    });

    it('should prioritize title matches in FlexSearch results', async () => {
      const response = await agent
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name: 'kb_search',
            arguments: {
              query: 'React',
              limit: 10
            }
          },
          id: 1
        });

      assert.strictEqual(response.status, 200);
      const result = JSON.parse(response.body.result.content[0].text);

      assert.ok(result.resultsCount >= 2);
      
      // Documents with "React" in title should score higher
      const sortedResults = result.results.sort((a, b) => b.relevanceScore - a.relevanceScore);
      const topResult = sortedResults[0];
      
      // Top result should have React in the title
      assert.ok(topResult.title.toLowerCase().includes('react'));
    });

    it('should handle tag-based searches with FlexSearch', async () => {
      const response = await agent
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name: 'kb_search',
            arguments: {
              query: 'performance optimization',
              limit: 5
            }
          },
          id: 1
        });

      assert.strictEqual(response.status, 200);
      const result = JSON.parse(response.body.result.content[0].text);

      assert.ok(result.resultsCount >= 2);
      
      // Should find both performance-related documents
      const performanceDocs = result.results.filter(r => 
        r.tags.includes('performance') || r.tags.includes('optimization')
      );
      assert.ok(performanceDocs.length >= 2);
    });

    it('should handle fuzzy matching with FlexSearch', async () => {
      const response = await agent
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name: 'kb_search',
            arguments: {
              query: 'optimizat', // Partial word
              limit: 5
            }
          },
          id: 1
        });

      assert.strictEqual(response.status, 200);
      const result = JSON.parse(response.body.result.content[0].text);

      // Should still find optimization-related documents
      assert.ok(result.resultsCount > 0);
      const hasOptimization = result.results.some(r => 
        r.title.toLowerCase().includes('optimization') ||
        r.content.toLowerCase().includes('optimization') ||
        r.tags.includes('optimization')
      );
      assert.ok(hasOptimization);
    });

    it('should include content when requested in FlexSearch results', async () => {
      const response = await agent
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name: 'kb_search',
            arguments: {
              query: 'testing strategies',
              includeContent: true,
              limit: 5
            }
          },
          id: 1
        });

      assert.strictEqual(response.status, 200);
      const result = JSON.parse(response.body.result.content[0].text);

      assert.ok(result.resultsCount > 0);
      result.results.forEach(doc => {
        assert.ok(doc.content, 'Content should be included when requested');
        assert.ok(typeof doc.content === 'string');
        assert.ok(doc.content.length > 0);
      });
    });

    it('should respect search limits with FlexSearch', async () => {
      const response = await agent
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name: 'kb_search',
            arguments: {
              query: 'javascript',
              limit: 2
            }
          },
          id: 1
        });

      assert.strictEqual(response.status, 200);
      const result = JSON.parse(response.body.result.content[0].text);

      assert.ok(result.results.length <= 2);
      assert.ok(result.resultsCount <= 2);
    });

    it('should handle case-insensitive searches', async () => {
      const testCases = ['REACT', 'react', 'React', 'rEaCt'];
      const results = [];

      for (const query of testCases) {
        const response = await agent
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            method: 'tools/call',
            params: {
              name: 'kb_search',
              arguments: { query, limit: 5 }
            },
            id: 1
          });

        const result = JSON.parse(response.body.result.content[0].text);
        results.push(result);
      }

      // All searches should return similar results
      const firstResultCount = results[0].resultsCount;
      results.forEach(result => {
        assert.strictEqual(result.resultsCount, firstResultCount);
      });
    });

    it('should return meaningful excerpts with FlexSearch', async () => {
      const response = await agent
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name: 'kb_search',
            arguments: {
              query: 'higher-order components',
              limit: 5
            }
          },
          id: 1
        });

      assert.strictEqual(response.status, 200);
      const result = JSON.parse(response.body.result.content[0].text);

      assert.ok(result.resultsCount > 0);
      result.results.forEach(doc => {
        assert.ok(doc.excerpt);
        assert.strictEqual(typeof doc.excerpt, 'string');
        assert.ok(doc.excerpt.length > 0);
        // Excerpt should contain relevant content
        assert.ok(doc.excerpt.length <= 300); // Should be reasonably sized
      });
    });
  });

  describe('FlexSearch Performance through MCP', () => {
    it('should handle complex multi-term searches efficiently', async () => {
      const startTime = Date.now();

      const response = await agent
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name: 'kb_search',
            arguments: {
              query: 'React testing components performance optimization strategies',
              limit: 10
            }
          },
          id: 1
        });

      const searchTime = Date.now() - startTime;

      assert.strictEqual(response.status, 200);
      assert.ok(searchTime < 1000); // Should complete quickly

      const result = JSON.parse(response.body.result.content[0].text);
      assert.ok(result.resultsCount >= 0); // Should return valid results
    });

    it('should maintain performance with empty search results', async () => {
      const startTime = Date.now();

      const response = await agent
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name: 'kb_search',
            arguments: {
              query: 'nonexistentterm12345xyz',
              limit: 10
            }
          },
          id: 1
        });

      const searchTime = Date.now() - startTime;

      assert.strictEqual(response.status, 200);
      assert.ok(searchTime < 500); // Should complete quickly even with no results

      const result = JSON.parse(response.body.result.content[0].text);
      assert.strictEqual(result.resultsCount, 0);
      assert.strictEqual(result.results.length, 0);
    });
  });

  describe('FlexSearch Integration with Other MCP Tools', () => {
    it('should work correctly after adding documents via ExpressMcp methods', async () => {
      // Add a new document via ExpressMcp method
      expressMcp.addDocument('dynamic-doc', {
        title: 'Dynamic Document',
        content: 'This document was added dynamically and should be searchable immediately.',
        tags: ['dynamic', 'test']
      });

      // Search for the newly added document
      const response = await agent
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name: 'kb_search',
            arguments: {
              query: 'dynamic searchable',
              limit: 5
            }
          },
          id: 1
        });

      assert.strictEqual(response.status, 200);
      const result = JSON.parse(response.body.result.content[0].text);

      assert.ok(result.resultsCount > 0);
      const dynamicDoc = result.results.find(r => r.id === 'dynamic-doc');
      assert.ok(dynamicDoc, 'Should find the dynamically added document');
    });

    it('should reflect document updates in search results', async () => {
      // Update an existing document
      expressMcp.updateDocument('flexsearch-doc1', {
        title: 'Updated React Patterns',
        content: 'Updated content about modern React patterns including Suspense and Concurrent Mode.',
        tags: ['react', 'javascript', 'frontend', 'modern', 'suspense']
      });

      // Search for updated content
      const response = await agent
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name: 'kb_search',
            arguments: {
              query: 'Suspense Concurrent',
              limit: 5
            }
          },
          id: 1
        });

      assert.strictEqual(response.status, 200);
      const result = JSON.parse(response.body.result.content[0].text);

      assert.ok(result.resultsCount > 0);
      const updatedDoc = result.results.find(r => r.id === 'flexsearch-doc1');
      assert.ok(updatedDoc, 'Should find the updated document');
      assert.strictEqual(updatedDoc.title, 'Updated React Patterns');
    });

    it('should remove documents from search when deleted', async () => {
      // Remove a document
      expressMcp.removeDocument('flexsearch-doc2');

      // Search for content that was in the removed document
      const response = await agent
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name: 'kb_search',
            arguments: {
              query: 'clustering caching profiling',
              limit: 10
            }
          },
          id: 1
        });

      assert.strictEqual(response.status, 200);
      const result = JSON.parse(response.body.result.content[0].text);

      // Should not find the removed document
      const removedDoc = result.results.find(r => r.id === 'flexsearch-doc2');
      assert.ok(!removedDoc, 'Should not find the removed document');
    });

    it('should work with kb_list tool results', async () => {
      // First get a list of documents
      const listResponse = await agent
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name: 'kb_list',
            arguments: { limit: 10 }
          },
          id: 1
        });

      assert.strictEqual(listResponse.status, 200);
      const listResult = JSON.parse(listResponse.body.result.content[0].text);
      
      // Search for documents that should exist according to the list
      if (listResult.documents.length > 0) {
        const firstDoc = listResult.documents[0];
        const searchResponse = await agent
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            method: 'tools/call',
            params: {
              name: 'kb_search',
              arguments: {
                query: firstDoc.title,
                limit: 5
              }
            },
            id: 2
          });

        assert.strictEqual(searchResponse.status, 200);
        const searchResult = JSON.parse(searchResponse.body.result.content[0].text);
        
        // Should find the document that was listed
        const foundDoc = searchResult.results.find(r => r.id === firstDoc.id);
        assert.ok(foundDoc, 'Should find document that was in the list');
      }
    });
  });
});

