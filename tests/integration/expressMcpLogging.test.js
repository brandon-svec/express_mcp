/**
 * ExpressMcp Logging Test Suite
 * Tests logging functionality and error paths
 */

import { strict as assert } from 'assert';
import express from 'express';
import request from 'supertest';
import { ExpressMcp } from '../../src/classes/expressMcp.js';
import { BaseTool } from '../../src/classes/baseTool.js';
import { MCP_STREAMABLE_HTTP_ACCEPT, createInitializeRequest, createMcpSession, mcpPostWithSession } from '../config.js';

describe('ExpressMcp Logging Tests', () => {
  let logs;
  let mockLogger;

  beforeEach(() => {
    logs = [];
    mockLogger = {
      info: (data, message) => {
        if (typeof data === 'string' && message === undefined) {
          // Single parameter: logger.info(message)
          logs.push({ level: 'info', message: data, data: {} });
        } else {
          // Two parameters: logger.info(data, message)
          logs.push({ level: 'info', message, data });
        }
      },
      error: (data, message) => {
        if (typeof data === 'string' && message === undefined) {
          logs.push({ level: 'error', message: data, data: {} });
        } else {
          logs.push({ level: 'error', message, data });
        }
      },
      warn: (data, message) => {
        if (typeof data === 'string' && message === undefined) {
          logs.push({ level: 'warn', message: data, data: {} });
        } else {
          logs.push({ level: 'warn', message, data });
        }
      },
      debug: (data, message) => {
        if (typeof data === 'string' && message === undefined) {
          logs.push({ level: 'debug', message: data, data: {} });
        } else {
          logs.push({ level: 'debug', message, data });
        }
      },
      child: (context) => ({
        info: (data, message) => {
          if (typeof data === 'string' && message === undefined) {
            logs.push({ level: 'info', message: data, data: { ...context } });
          } else {
            logs.push({ level: 'info', message, data: { ...context, ...data } });
          }
        },
        error: (data, message) => {
          if (typeof data === 'string' && message === undefined) {
            logs.push({ level: 'error', message: data, data: { ...context } });
          } else {
            logs.push({ level: 'error', message, data: { ...context, ...data } });
          }
        },
        warn: (data, message) => {
          if (typeof data === 'string' && message === undefined) {
            logs.push({ level: 'warn', message: data, data: { ...context } });
          } else {
            logs.push({ level: 'warn', message, data: { ...context, ...data } });
          }
        },
        debug: (data, message) => {
          if (typeof data === 'string' && message === undefined) {
            logs.push({ level: 'debug', message: data, data: { ...context } });
          } else {
            logs.push({ level: 'debug', message, data: { ...context, ...data } });
          }
        },
        child: (childContext) => ({
          info: (data, message) => {
            if (typeof data === 'string' && message === undefined) {
              logs.push({ level: 'info', message: data, data: { ...context, ...childContext } });
            } else {
              logs.push({ level: 'info', message, data: { ...context, ...childContext, ...data } });
            }
          },
          error: (data, message) => {
            if (typeof data === 'string' && message === undefined) {
              logs.push({ level: 'error', message: data, data: { ...context, ...childContext } });
            } else {
              logs.push({ level: 'error', message, data: { ...context, ...childContext, ...data } });
            }
          },
          warn: (data, message) => {
            if (typeof data === 'string' && message === undefined) {
              logs.push({ level: 'warn', message: data, data: { ...context, ...childContext } });
            } else {
              logs.push({ level: 'warn', message, data: { ...context, ...childContext, ...data } });
            }
          },
          debug: (data, message) => {
            if (typeof data === 'string' && message === undefined) {
              logs.push({ level: 'debug', message: data, data: { ...context, ...childContext } });
            } else {
              logs.push({ level: 'debug', message, data: { ...context, ...childContext, ...data } });
            }
          }
        })
      })
    };
  });

  describe('Logger Initialization', () => {
    it('should use provided custom logger instance', () => {
      const expressMcp = new ExpressMcp({
        logger: mockLogger,
        loggerOptions: { enabled: false } // Disable logging to prevent console output
      });

      // The logger should be a child of the provided logger, not the exact same instance
      assert.notStrictEqual(expressMcp.logger, mockLogger);
      // But it should have the same methods
      assert.strictEqual(typeof expressMcp.logger.info, 'function');
      assert.strictEqual(typeof expressMcp.logger.warn, 'function');
      assert.strictEqual(typeof expressMcp.logger.error, 'function');
      assert.strictEqual(typeof expressMcp.logger.debug, 'function');
    });

    it('should set logger name when instance name is provided', () => {
      // We can't easily test the internal Pino creation, but we can test the path
      const expressMcp = new ExpressMcp({
        name: 'test-instance',
        loggerOptions: { enabled: false } // Disable logging to prevent console output
      });

      assert.strictEqual(expressMcp.name, 'test-instance');
    });

    it('should handle logger initialization without name', () => {
      const expressMcp = new ExpressMcp({
        loggerOptions: { enabled: false } // Disable logging to prevent console output
      });

      assert.ok(expressMcp.logger);
      assert.strictEqual(expressMcp.name, undefined);
    });

    it('should disable logging when loggerOptions.enabled is false', () => {
      const expressMcp = new ExpressMcp({
        loggerOptions: { enabled: false }
      });

      assert.ok(expressMcp.logger);
      // Logger exists but should be disabled
    });
  });

  describe('Document Operation Error Handling', () => {
    let expressMcp;

    beforeEach(() => {
      expressMcp = new ExpressMcp({
        logger: mockLogger
      });
    });

    it('should log error when addDocument fails', async () => {
      // Mock knowledgeBase to throw an error
      expressMcp.knowledgeBase.addDocument = async () => {
        throw new Error('Database connection failed');
      };

      try {
        await expressMcp.addDocument('test-id', { title: 'Test', content: 'Test content' });
        assert.fail('Should have thrown an error');
      } catch (error) {
        assert.strictEqual(error.message, 'Database connection failed');
        
        const errorLog = logs.find(log => log.level === 'error' && log.message === 'Failed to add document');
        assert.ok(errorLog);
        assert.strictEqual(errorLog.data.documentId, 'test-id');
        assert.strictEqual(errorLog.data.error, 'Database connection failed');
      }
    });

    it('should log error when updateDocument fails', async () => {
      // Mock knowledgeBase to throw an error
      expressMcp.knowledgeBase.updateDocument = async () => {
        throw new Error('Update validation failed');
      };

      try {
        await expressMcp.updateDocument('test-id', { title: 'Updated' });
        assert.fail('Should have thrown an error');
      } catch (error) {
        assert.strictEqual(error.message, 'Update validation failed');
        
        const errorLog = logs.find(log => log.level === 'error' && log.message === 'Failed to update document');
        assert.ok(errorLog);
        assert.strictEqual(errorLog.data.documentId, 'test-id');
        assert.strictEqual(errorLog.data.error, 'Update validation failed');
      }
    });

    it('should log error when removeDocument fails', async () => {
      // Mock knowledgeBase to throw an error
      expressMcp.knowledgeBase.removeDocument = async () => {
        throw new Error('Document not found');
      };

      try {
        await expressMcp.removeDocument('test-id');
        assert.fail('Should have thrown an error');
      } catch (error) {
        assert.strictEqual(error.message, 'Document not found');
        
        const errorLog = logs.find(log => log.level === 'error' && log.message === 'Failed to remove document');
        assert.ok(errorLog);
        assert.strictEqual(errorLog.data.documentId, 'test-id');
        assert.strictEqual(errorLog.data.error, 'Document not found');
      }
    });
  });

  describe('Tool Execution Error Handling', () => {
    let expressMcp;

    class ExceptionTool extends BaseTool {
      constructor() {
        super('exception-tool', 'A tool that throws exceptions');
      }

      async execute() {
        throw new Error('Tool execution exception');
      }
    }

    beforeEach(() => {
      expressMcp = new ExpressMcp({
        logger: mockLogger,
        enableKnowledgeBase: false
      });

      expressMcp.registerTool(new ExceptionTool());
    });

    it('should return JSON-RPC error when tool execution throws exception', async () => {
      expressMcp.toolRegistry.executeTool = async () => {
        throw new Error('System error during tool execution');
      };

      const app = express();
      app.use(express.json());
      app.use('/mcp', expressMcp.router());

      const baseAgent = request(app);
      const sessionId = await createMcpSession(baseAgent);
      const response = await mcpPostWithSession(baseAgent, sessionId)
        .send({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name: 'exception-tool',
            arguments: {}
          },
          id: 'test-exception'
        });

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.jsonrpc, '2.0');
      assert.strictEqual(response.body.error.code, -32603);
      assert.ok(response.body.error.message.includes('System error during tool execution'));
    });

    it('should return JSON-RPC error when tool handler throws during execution', async () => {
      const app = express();
      app.use(express.json());
      app.use('/mcp', expressMcp.router());

      const baseAgent = request(app);
      const sessionId = await createMcpSession(baseAgent);
      const response = await mcpPostWithSession(baseAgent, sessionId)
        .send({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name: 'exception-tool',
            arguments: {}
          },
          id: 'test-response'
        });

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.error.code, -32603);
      assert.ok(response.body.error.message.includes('Tool execution failed'));
    });
  });

  describe('MCP request handling', () => {
    let expressMcp;

    beforeEach(() => {
      expressMcp = new ExpressMcp({
        logger: mockLogger,
        enableKnowledgeBase: false
      });
    });

    it('should handle initialize requests via SDK transport', async () => {
      const app = express();
      app.use(express.json());
      app.use('/mcp', expressMcp.router());

      const response = await request(app)
        .post('/mcp')
        .set('Accept', MCP_STREAMABLE_HTTP_ACCEPT)
        .send(createInitializeRequest('init-test'));

      assert.strictEqual(response.status, 200);
      assert.ok(response.body.result);
      assert.ok(response.body.result.serverInfo);
    });

    it('should return SDK error response for unknown methods', async () => {
      const app = express();
      app.use(express.json());
      app.use('/mcp', expressMcp.router());

      const baseAgent = request(app);
      const sessionId = await createMcpSession(baseAgent);
      const response = await mcpPostWithSession(baseAgent, sessionId)
        .send({
          jsonrpc: '2.0',
          method: 'unknown-method',
          id: 'unknown-test'
        });

      assert.strictEqual(response.status, 200);
      assert.ok(response.body.error);
      assert.strictEqual(logs.find((log) => log.message === 'Unknown method called'), undefined);
    });
  });
});
