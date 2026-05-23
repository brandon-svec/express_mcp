/**
 * ExpressMcp Knowledge Base Integration Tests
 * Tests the integration of knowledge base functionality with ExpressMcp
 */

import { strict as assert } from 'assert';
import express from 'express';
import request from 'supertest';
import { ExpressMcp } from '../../src/classes/expressMcp.js';
import { getTestExpressMcpOptions, MCP_STREAMABLE_HTTP_ACCEPT } from '../config.js';

describe('ExpressMcp Knowledge Base Integration', () => {
  let app;
  let expressMcp;
  let agent;

  describe('Knowledge Base Tools Disabled', () => {
    beforeEach(() => {
      expressMcp = new ExpressMcp(getTestExpressMcpOptions({ enableKnowledgeBase: false }));
      app = express();
      app.use(express.json());
      app.use('/mcp', expressMcp.router());
      const baseAgent = request(app);
      agent = {
        post: (path) => baseAgent.post(path).set('Accept', MCP_STREAMABLE_HTTP_ACCEPT)
      };
    });

    it('should have knowledge base instance but no tools when tools disabled', () => {
      // Knowledge base should always exist
      assert.ok(expressMcp.getKnowledgeBase());
      assert.strictEqual(typeof expressMcp.getKnowledgeBase().addDocument, 'function');
      
      // But tools should not be registered
      assert.strictEqual(expressMcp.hasRegisteredTool('kb_search'), false);
      assert.strictEqual(expressMcp.hasRegisteredTool('kb_list'), false);
      assert.strictEqual(expressMcp.hasRegisteredTool('kb_get'), false);
      assert.strictEqual(expressMcp.hasRegisteredTool('kb_register'), false);
      assert.strictEqual(expressMcp.hasRegisteredTool('kb_manage'), false);
    });

    it('should return empty tools list via MCP protocol when tools disabled', async () => {
      const response = await agent
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          method: 'tools/list',
          id: 1
        });

              assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.jsonrpc, '2.0');
        assert.strictEqual(response.body.id, 1);
        assert.ok(Array.isArray(response.body.result.tools));
        
        // Should have no tools when disabled
        const toolNames = response.body.result.tools.map(tool => tool.name);
        assert.strictEqual(toolNames.includes('kb_search'), false);
        assert.strictEqual(toolNames.includes('kb_list'), false);
        assert.strictEqual(toolNames.includes('kb_get'), false);
    });
  });

  describe('Knowledge Base Tools Enabled (Default)', () => {
    beforeEach(() => {
      expressMcp = new ExpressMcp(getTestExpressMcpOptions()); // Default behavior
      app = express();
      app.use(express.json());
      app.use('/mcp', expressMcp.router());
      const baseAgent = request(app);
      agent = {
        post: (path) => baseAgent.post(path).set('Accept', MCP_STREAMABLE_HTTP_ACCEPT)
      };
    });

    it('should always have knowledge base instance', () => {
      const kb = expressMcp.getKnowledgeBase();
      assert.ok(kb);
      assert.strictEqual(typeof kb.addDocument, 'function');
      assert.strictEqual(typeof kb.searchDocuments, 'function');
    });

    it('should register specific knowledge base tools', () => {
      // Check for specific tools that should be available
      assert.strictEqual(expressMcp.hasRegisteredTool('kb_search'), true);
      assert.strictEqual(expressMcp.hasRegisteredTool('kb_list'), true);
      assert.strictEqual(expressMcp.hasRegisteredTool('kb_get'), true);
      
      // Check that management tools are not exposed via MCP
      assert.strictEqual(expressMcp.hasRegisteredTool('kb_register'), false);
      assert.strictEqual(expressMcp.hasRegisteredTool('kb_manage'), false);
    });

    it('should list knowledge base tools via MCP protocol', async () => {
      const response = await agent
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          method: 'tools/list',
          id: 1
        });

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.jsonrpc, '2.0');
      assert.strictEqual(response.body.id, 1);
      assert.ok(Array.isArray(response.body.result.tools));

      const toolNames = response.body.result.tools.map(tool => tool.name);
      
      // Check for specific tools that should be available
      assert.ok(toolNames.includes('kb_search'));
      assert.ok(toolNames.includes('kb_list'));
      assert.ok(toolNames.includes('kb_get'));
      
      // Check that management tools are not exposed
      assert.ok(!toolNames.includes('kb_register'));
      assert.ok(!toolNames.includes('kb_manage'));

      // Check tool structure
      const searchTool = response.body.result.tools.find(tool => tool.name === 'kb_search');
      assert.ok(searchTool);
      assert.strictEqual(searchTool.description, 'Search documents in the knowledge base');
      assert.ok(searchTool.inputSchema);
      assert.deepStrictEqual(searchTool.inputSchema.required, ['query']);
    });

    describe('Knowledge Base Tool Execution via MCP', () => {
      it('should register document via ExpressMcp addDocument method', async () => {
        const result = await expressMcp.addDocument('test-doc', {
          title: 'Test Document',
          content: 'This is test content for the knowledge base',
          tags: ['test', 'example'],
          metadata: { category: 'testing' }
        });

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.documentId, 'test-doc');

        // Verify document was stored in knowledge base
        const kb = expressMcp.getKnowledgeBase();
        const doc = kb.getDocument('test-doc');
        assert.ok(doc);
        assert.strictEqual(doc.title, 'Test Document');
        assert.strictEqual(doc.content, 'This is test content for the knowledge base');
        assert.deepStrictEqual(doc.tags, ['test', 'example']);
        assert.deepStrictEqual(doc.metadata, { category: 'testing' });
      });

      it('should search documents via kb_search tool', async () => {
        // First register a document using ExpressMcp method
        await expressMcp.addDocument('search-test', {
          title: 'JavaScript Programming',
          content: 'Learn JavaScript programming fundamentals',
          tags: ['programming', 'javascript']
        });

        const response = await agent
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            method: 'tools/call',
            params: {
              name: 'kb_search',
              arguments: {
                query: 'JavaScript',
                limit: 10
              }
            },
            id: 1
          });

        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.jsonrpc, '2.0');
        assert.strictEqual(response.body.id, 1);

        const result = JSON.parse(response.body.result.content[0].text);
        assert.ok(result.resultsCount >= 1);
        assert.ok(Array.isArray(result.results));
        assert.ok(result.results[0].title.includes('JavaScript'));
      });

      it('should list documents via kb_list tool', async () => {
        // Add a test document using ExpressMcp method
        await expressMcp.addDocument('list-test', {
          title: 'List Test Document',
          content: 'Document for list testing',
          tags: ['list-test']
        });

        const response = await agent
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            method: 'tools/call',
            params: {
              name: 'kb_list',
              arguments: {
                limit: 10
              }
            },
            id: 1
          });

        assert.strictEqual(response.status, 200);
        const result = JSON.parse(response.body.result.content[0].text);
        assert.ok(result.documentsCount >= 1);
        assert.ok(Array.isArray(result.documents));
      });

      it('should get document via kb_get tool', async () => {
        // Add a test document using ExpressMcp method
        await expressMcp.addDocument('get-test', {
          title: 'Get Test Document',
          content: 'Document for get testing'
        });

        const response = await agent
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            method: 'tools/call',
            params: {
              name: 'kb_get',
              arguments: {
                id: 'get-test'
              }
            },
            id: 1
          });

        assert.strictEqual(response.status, 200);
        const result = JSON.parse(response.body.result.content[0].text);
        assert.ok(result.document);
        assert.strictEqual(result.document.id, 'get-test');
        assert.strictEqual(result.document.title, 'Get Test Document');
      });

      it('should manage documents via ExpressMcp methods', async () => {
        // Test adding a document
        const addResult = await expressMcp.addDocument('manage-test', {
          title: 'Test Document',
          content: 'Test content'
        });
        assert.strictEqual(addResult.success, true);

        // Test getting stats
        const stats = await expressMcp.getKnowledgeBaseStats();
        assert.ok(stats);
        assert.ok(typeof stats.totalDocuments === 'number');

        // Test updating a document
        const updateResult = await expressMcp.updateDocument('manage-test', {
          title: 'Updated Test Document'
        });
        assert.strictEqual(updateResult.success, true);

        // Test removing a document
        const removeResult = await expressMcp.removeDocument('manage-test');
        assert.strictEqual(removeResult.success, true);
      });

      it('should handle tool validation errors', async () => {
        const response = await agent
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            method: 'tools/call',
            params: {
              name: 'kb_search',
              arguments: {
                // Missing required field query
              }
            },
            id: 1
          });

        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.jsonrpc, '2.0');
        assert.ok(response.body.error);
        // Should be either validation error (-32602) or execution error (-32603)
        assert.ok(response.body.error.code === -32602 || response.body.error.code === -32603);
        assert.ok(response.body.error.message.includes('required') || response.body.error.message.includes('Validation failed'));
      });

      it('should handle tool execution errors', async () => {
        const response = await agent
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            method: 'tools/call',
            params: {
              name: 'kb_get',
              arguments: {
                id: 'non-existent-document'
              }
            },
            id: 1
          });

        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.jsonrpc, '2.0');
        assert.ok(response.body.error);
        assert.strictEqual(response.body.error.code, -32604);
        assert.ok(response.body.error.message.includes('not found'));
      });
    });
  });

  describe('Mixed Configuration', () => {
    it('should work with both knowledge base and custom tools', () => {
      const expressMcp = new ExpressMcp(getTestExpressMcpOptions()); // Default has KB tools enabled

      // Add a custom tool
      class CustomTool {
        constructor() {
          this.name = 'custom-tool';
          this.description = 'A custom tool';
        }

        async execute() {
          return 'Custom tool executed';
        }
      }

      expressMcp.registerTool(new CustomTool());

      const tools = expressMcp.getRegisteredTools();
      const toolNames = tools.map(tool => tool.name);

      // Should have both knowledge base tools and custom tool
      assert.ok(toolNames.includes('kb_search'));
      assert.ok(toolNames.includes('kb_list'));
      assert.ok(toolNames.includes('kb_get'));
      assert.ok(toolNames.includes('custom-tool'));
      
      // Should not have management tools
      assert.ok(!toolNames.includes('kb_register'));
      assert.ok(!toolNames.includes('kb_manage'));
      
      // Knowledge base should always be available
      assert.ok(expressMcp.getKnowledgeBase());
    });

    it('should allow clearing all tools including knowledge base tools', () => {
      const expressMcp = new ExpressMcp(getTestExpressMcpOptions()); // Default has KB tools enabled

      // Should initially have knowledge base tools
      assert.strictEqual(expressMcp.hasRegisteredTool('kb_search'), true);
      assert.strictEqual(expressMcp.hasRegisteredTool('kb_list'), true);
      assert.strictEqual(expressMcp.hasRegisteredTool('kb_get'), true);

      expressMcp.clearRegisteredTools();

      // Should no longer have any tools
      assert.strictEqual(expressMcp.hasRegisteredTool('kb_search'), false);
      assert.strictEqual(expressMcp.hasRegisteredTool('kb_list'), false);
      assert.strictEqual(expressMcp.hasRegisteredTool('kb_get'), false);
      
      // But knowledge base instance should still exist
      assert.ok(expressMcp.getKnowledgeBase());
    });
  });
});
