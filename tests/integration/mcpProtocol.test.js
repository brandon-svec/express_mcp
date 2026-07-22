import { assert } from 'chai';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'fs';
import { ExpressMcp, BaseTool } from '../../src/index.js';
import { DataTypeTestTool } from '../testUtils.js';
import { getTestExpressMcpOptions, MCP_STREAMABLE_HTTP_ACCEPT, MCP_SESSION_ID_HEADER, createInitializeRequest, createMcpSession, mcpPostWithSession } from '../config.js';

const packageVersion = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

describe('MCP Protocol Functional Tests', () => {
  let app;
  let expressMcp;
  let agent; // Cached SuperTest agent

  class HelloTool extends BaseTool {
    constructor() {
      super('hello', 'Says hello with optional name');
      this.inputSchema = {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name to greet' }
        }
      };
    }

    async execute(args) {
      const name = args?.name || 'World';
      return `Hello, ${name}!`;
    }
  }

  class CalculatorTool extends BaseTool {
    constructor() {
      super('calculator', 'Performs basic math operations');
      this.inputSchema = {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['add', 'subtract', 'multiply', 'divide'] },
          a: { type: 'number' },
          b: { type: 'number' }
        },
        required: ['operation', 'a', 'b']
      };
    }

    async execute(args) {
      const { operation, a, b } = args;
      switch (operation) {
        case 'add': return a + b;
        case 'subtract': return a - b;
        case 'multiply': return a * b;
        case 'divide': return a / b;
        default: throw new Error(`Unknown operation: ${operation}`);
      }
    }
  }

  beforeEach(async () => {
    // Create Express app for testing
    app = express();
    app.use(express.json());
    
    // Create ExpressMcp instance and register tools (disable KB tools for this test)
    expressMcp = new ExpressMcp(getTestExpressMcpOptions({ enableKnowledgeBase: false }));
    expressMcp.registerTool(new HelloTool());
    expressMcp.registerTool(new CalculatorTool());
    expressMcp.registerTool(new DataTypeTestTool());
    
    // Mount the MCP router
    app.use('/mcp', expressMcp.router());
    
    // Add error handler middleware to catch JSON parsing errors
    app.use((err, req, res, next) => {
      if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        // Handle JSON parsing errors gracefully
        return res.status(400).send('Bad Request: Invalid JSON');
      }
      next(err);
    });
    
    const baseAgent = request(app);
    const sessionId = await createMcpSession(baseAgent);
    agent = {
      post: (path) => mcpPostWithSession(baseAgent, sessionId, path)
    };
  });

  describe('POST /mcp - MCP Protocol', () => {
    describe('initialize method', () => {
      it('should handle initialize request', async () => {
        const response = await request(app)
          .post('/mcp')
          .set('Accept', MCP_STREAMABLE_HTTP_ACCEPT)
          .send(createInitializeRequest(1));

        assert.strictEqual(response.status, 200);
        assert.ok(response.headers[MCP_SESSION_ID_HEADER]);
        assert.deepStrictEqual(response.body, {
          jsonrpc: '2.0',
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: {}
            },
            serverInfo: {
              name: '@express-mcp/express-mcp',
              version: packageVersion
            }
          },
          id: 1
        });
      });
    });

    describe('notifications/initialized method', () => {
      it('should handle initialized notification', async () => {
        const response = await agent
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            method: 'notifications/initialized'
          });

        assert.strictEqual(response.status, 202);
      });
    });

    describe('tools/list method', () => {
      it('should list all registered tools', async () => {
        const response = await agent
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            method: 'tools/list',
            id: 3
          });

        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.jsonrpc, '2.0');
        assert.strictEqual(response.body.id, 3);
        assert.property(response.body.result, 'tools');
        assert.isArray(response.body.result.tools);
        assert.lengthOf(response.body.result.tools, 3);

        const toolNames = response.body.result.tools.map(tool => tool.name);
        assert.include(toolNames, 'hello');
        assert.include(toolNames, 'calculator');
        assert.include(toolNames, 'data-type-test');

        // Check tool structure
        const helloTool = response.body.result.tools.find(tool => tool.name === 'hello');
        assert.deepStrictEqual(helloTool, {
          name: 'hello',
          description: 'Says hello with optional name',
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Name to greet' }
            }
          }
        });
      });

      it('should return empty tools list when no tools registered', async () => {
        const emptyExpressMcp = new ExpressMcp(getTestExpressMcpOptions({ enableKnowledgeBase: false }));
        const emptyApp = express();
        emptyApp.use(express.json());
        emptyApp.use('/empty', emptyExpressMcp.router());

        const emptyAgent = request(emptyApp);
        const emptySessionId = await createMcpSession(emptyAgent, '/empty');
        const response = await mcpPostWithSession(emptyAgent, emptySessionId, '/empty')
          .send({
            jsonrpc: '2.0',
            method: 'tools/list',
            id: 4
          });

        assert.strictEqual(response.status, 200);
        assert.isArray(response.body.result.tools);
        assert.lengthOf(response.body.result.tools, 0);
      });
    });

    describe('tools/call method', () => {
      it('should execute hello tool without parameters', async () => {
        const response = await agent
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            method: 'tools/call',
            params: {
              name: 'hello',
              arguments: {}
            },
            id: 5
          });

        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual(response.body, {
          jsonrpc: '2.0',
          result: {
            content: [{
              type: 'text',
              text: 'Hello, World!'
            }]
          },
          id: 5
        });
      });

      it('should execute hello tool with name parameter', async () => {
        const response = await agent
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            method: 'tools/call',
            params: {
              name: 'hello',
              arguments: {
                name: 'Alice'
              }
            },
            id: 6
          });

        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.result.content[0].text, 'Hello, Alice!');
      });

      it('should execute calculator tool', async () => {
        const response = await agent
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            method: 'tools/call',
            params: {
              name: 'calculator',
              arguments: {
                operation: 'add',
                a: 5,
                b: 3
              }
            },
            id: 7
          });

        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.result.content[0].text, '8');
      });

      it('should return error for non-existent tool', async () => {
        const response = await agent
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            method: 'tools/call',
            params: {
              name: 'non-existent',
              arguments: {}
            },
            id: 8
          });

        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.jsonrpc, '2.0');
        assert.property(response.body, 'error');
        assert.strictEqual(response.body.error.code, -32601);
        assert.include(response.body.error.message, "Tool 'non-existent' not found");
        assert.strictEqual(response.body.id, 8);
      });

      it('should handle tool execution errors', async () => {
        const response = await agent
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            method: 'tools/call',
            params: {
              name: 'calculator',
              arguments: {
                operation: 'invalid',
                a: 1,
                b: 2
              }
            },
            id: 9
          });

        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.jsonrpc, '2.0');
        assert.property(response.body, 'error');
        assert.strictEqual(response.body.error.code, -32603);
        assert.include(response.body.error.message, 'Tool execution failed');
        assert.strictEqual(response.body.id, 9);
      });
    });

    describe('JSON-RPC validation', () => {
      it('should reject invalid JSON-RPC version', async () => {
        const response = await agent
          .post('/mcp')
          .send({
            jsonrpc: '1.0',
            method: 'tools/list',
            id: 10
          });

        assert.strictEqual(response.status, 400);
        assert.strictEqual(response.body.jsonrpc, '2.0');
        assert.property(response.body, 'error');
        assert.strictEqual(response.body.error.code, -32700);
      });

      it('should reject invalid JSON-RPC version with null id', async () => {
        const response = await agent
          .post('/mcp')
          .send({
            jsonrpc: '1.0',
            method: 'tools/list',
            id: null
          });

        assert.strictEqual(response.status, 400);
        assert.strictEqual(response.body.jsonrpc, '2.0');
        assert.property(response.body, 'error');
        assert.strictEqual(response.body.error.code, -32700);
      });

      it('should reject unknown methods', async () => {
        const response = await agent
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            method: 'unknown/method',
            id: 11
          });

        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.jsonrpc, '2.0');
        assert.property(response.body, 'error');
      });

      it('should reject unknown methods with null id', async () => {
        const response = await agent
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            method: 'unknown/method',
            id: null
          });

        assert.strictEqual(response.status, 400);
        assert.strictEqual(response.body.jsonrpc, '2.0');
        assert.property(response.body, 'error');
        assert.strictEqual(response.body.id, null);
      });

      it('should handle malformed JSON from Express', async () => {
        const response = await agent
          .post('/mcp')
          .set('Content-Type', 'application/json')
          .send('invalid json');

        assert.strictEqual(response.status, 400);
        // Our error handler middleware returns a clean error message
        assert.strictEqual(response.text, 'Bad Request: Invalid JSON');
      });
    });

    describe('response format validation', () => {
      it('should always include jsonrpc field', async () => {
        const response = await agent
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            method: 'tools/list',
            id: 12
          });

        assert.property(response.body, 'jsonrpc');
        assert.strictEqual(response.body.jsonrpc, '2.0');
      });

      it('should include id field from request', async () => {
        const response = await agent
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            method: 'tools/list',
            id: 'string-id'
          });

        assert.property(response.body, 'id');
        assert.strictEqual(response.body.id, 'string-id');
      });

      it('should handle null id', async () => {
        const response = await agent
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            method: 'tools/list',
            id: null
          });

        assert.property(response.body, 'id');
        assert.strictEqual(response.body.id, null);
      });

      it('should handle null id in initialize method', async () => {
        const response = await request(app)
          .post('/mcp')
          .set('Accept', MCP_STREAMABLE_HTTP_ACCEPT)
          .send({
            ...createInitializeRequest(null),
            id: null
          });

        assert.strictEqual(response.status, 400);
        assert.property(response.body, 'error');
      });

      it('should handle null id in notifications/initialized method', async () => {
        const response = await agent
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            method: 'notifications/initialized',
            id: null
          });

        assert.strictEqual(response.status, 400);
      });

      it('should handle missing id by setting it to null', async () => {
        const response = await agent
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            method: 'tools/list'
          });

        assert.strictEqual(response.status, 202);
      });
    });

    describe('internal error handling', () => {
      it('should handle internal server errors', async () => {
        // Create a ExpressMcp instance with a tool that will cause an internal error
        class ErrorTool extends BaseTool {
          constructor() {
            super('error-tool', 'Tool that causes internal errors');
          }

          async execute() {
            // This will cause an error in the router's try-catch block
            throw new Error('Internal tool error');
          }
        }

        const errorExpressMcp = new ExpressMcp(getTestExpressMcpOptions());
        errorExpressMcp.registerTool(new ErrorTool());
        
        const errorApp = express();
        errorApp.use(express.json());
        errorApp.use('/mcp', errorExpressMcp.router());

        const errorAgent = request(errorApp);
        const errorSessionId = await createMcpSession(errorAgent);
        const response = await mcpPostWithSession(errorAgent, errorSessionId)
          .send({
            jsonrpc: '2.0',
            method: 'tools/call',
            params: {
              name: 'error-tool',
              arguments: {}
            },
            id: 'error-test'
          });

        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.jsonrpc, '2.0');
        assert.property(response.body, 'error');
        assert.strictEqual(response.body.error.code, -32603);
        assert.include(response.body.error.message, 'Tool execution failed');
        assert.strictEqual(response.body.id, 'error-test');
      });

      it('should handle errors when request body is null', async () => {
        // Mock a scenario where req.body is null to test the error handler
        const malformedApp = express();
        malformedApp.use('/mcp', (req, res, next) => {
          // Simulate a scenario where body parsing failed completely
          req.body = null;
          next();
        });
        malformedApp.use('/mcp', expressMcp.router());

        const response = await request(malformedApp)
          .post('/mcp')
          .set('Accept', MCP_STREAMABLE_HTTP_ACCEPT)
          .send({
            jsonrpc: '2.0',
            method: 'tools/list',
            id: 'test-id'
          });

        assert.strictEqual(response.status, 400);
        assert.strictEqual(response.body.jsonrpc, '2.0');
        assert.property(response.body, 'error');
      });

      it('should handle errors when request body is undefined', async () => {
        // Mock a scenario where req.body is undefined to test the error handler
        const malformedApp = express();
        malformedApp.use('/mcp', (req, res, next) => {
          // Simulate a scenario where body parsing failed completely
          req.body = undefined;
          next();
        });
        malformedApp.use('/mcp', expressMcp.router());

        const response = await request(malformedApp)
          .post('/mcp')
          .set('Accept', MCP_STREAMABLE_HTTP_ACCEPT)
          .send({
            jsonrpc: '2.0',
            method: 'tools/list',
            id: 'test-id'
          });


        assert.strictEqual(response.status, 400);
        assert.strictEqual(response.body.jsonrpc, '2.0');
        assert.property(response.body, 'error');
      });
    });

    describe('tools/call method', () => {
      it('should execute tool returning string and format as text', async () => {
        const response = await agent
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            method: 'tools/call',
            params: {
              name: 'hello',
              arguments: { name: 'Test' }
            },
            id: 'test-call'
          });

        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.jsonrpc, '2.0');
        assert.strictEqual(response.body.id, 'test-call');
        assert.property(response.body, 'result');
        assert.property(response.body.result, 'content');
        assert.isArray(response.body.result.content);
        assert.strictEqual(response.body.result.content.length, 1);
        assert.strictEqual(response.body.result.content[0].type, 'text');
        assert.strictEqual(response.body.result.content[0].text, 'Hello, Test!');
      });

      it('should execute tool returning number and format as text', async () => {
        const response = await agent
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            method: 'tools/call',
            params: {
              name: 'calculator',
              arguments: { operation: 'add', a: 5, b: 3 }
            },
            id: 'calc-test'
          });

        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.jsonrpc, '2.0');
        assert.strictEqual(response.body.id, 'calc-test');
        assert.property(response.body, 'result');
        assert.property(response.body.result, 'content');
        assert.isArray(response.body.result.content);
        assert.strictEqual(response.body.result.content.length, 1);
        assert.strictEqual(response.body.result.content[0].type, 'text');
        assert.strictEqual(response.body.result.content[0].text, '8');
      });

      it('should execute tool returning object and format as text', async () => {
        const response = await agent
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            method: 'tools/call',
            params: {
              name: 'data-type-test',
              arguments: { type: 'object' }
            },
            id: 'object-test'
          });

        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.jsonrpc, '2.0');
        assert.strictEqual(response.body.id, 'object-test');
        assert.property(response.body, 'result');
        assert.property(response.body.result, 'content');
        assert.isArray(response.body.result.content);
        assert.strictEqual(response.body.result.content.length, 1);
        assert.strictEqual(response.body.result.content[0].type, 'text');
        
        const parsedResult = JSON.parse(response.body.result.content[0].text);
        assert.deepStrictEqual(parsedResult, { key: 'value', nested: { count: 3 } });
      });

      it('should execute tool returning array and format as json', async () => {
        const response = await agent
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            method: 'tools/call',
            params: {
              name: 'data-type-test',
              arguments: { type: 'array' }
            },
            id: 'array-test'
          });

        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.jsonrpc, '2.0');
        assert.strictEqual(response.body.id, 'array-test');
        assert.property(response.body, 'result');
        assert.property(response.body.result, 'content');
        assert.isArray(response.body.result.content);
        assert.strictEqual(response.body.result.content.length, 1);
        assert.strictEqual(response.body.result.content[0].type, 'text');
        
        const parsedResult = JSON.parse(response.body.result.content[0].text);
        assert.deepStrictEqual(parsedResult, [1, 2, 3, 'four', { five: 5 }]);
      });

      it('should execute tool returning null and format as json', async () => {
        const response = await agent
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            method: 'tools/call',
            params: {
              name: 'data-type-test',
              arguments: { type: 'null' }
            },
            id: 'null-test'
          });

        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.jsonrpc, '2.0');
        assert.strictEqual(response.body.id, 'null-test');
        assert.property(response.body, 'result');
        assert.property(response.body.result, 'content');
        assert.isArray(response.body.result.content);
        assert.strictEqual(response.body.result.content.length, 1);
        assert.strictEqual(response.body.result.content[0].type, 'text');
        assert.strictEqual(response.body.result.content[0].text, 'null');
      });

      it('should execute tool returning boolean and format as json', async () => {
        const response = await agent
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            method: 'tools/call',
            params: {
              name: 'data-type-test',
              arguments: { type: 'boolean' }
            },
            id: 'boolean-test'
          });

        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.jsonrpc, '2.0');
        assert.strictEqual(response.body.id, 'boolean-test');
        assert.property(response.body, 'result');
        assert.property(response.body.result, 'content');
        assert.isArray(response.body.result.content);
        assert.strictEqual(response.body.result.content.length, 1);
        assert.strictEqual(response.body.result.content[0].type, 'text');
        assert.strictEqual(response.body.result.content[0].text, 'true');
      });

      it('should handle tool not found error', async () => {
        const response = await agent
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            method: 'tools/call',
            params: {
              name: 'nonexistent-tool',
              arguments: {}
            },
            id: 'error-test'
          });

        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.jsonrpc, '2.0');
        assert.strictEqual(response.body.id, 'error-test');
        assert.property(response.body, 'error');
        assert.strictEqual(response.body.error.code, -32601);
        assert.include(response.body.error.message, 'not found');
      });
    });
  });
});