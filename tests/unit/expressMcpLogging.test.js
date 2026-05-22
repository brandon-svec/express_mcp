/**
 * ExpressMcp Logging Test Suite
 * Tests logging functionality and error paths
 */

import { strict as assert } from 'assert';
import { ExpressMcp } from '../../src/classes/expressMcp.js';
import { BaseTool } from '../../src/classes/baseTool.js';
import { ToolExecution } from '../../src/classes/toolExecution.js';

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
    let router;
    let mockRes;
    let responses;

    // Tool that throws an exception during execution
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
      router = expressMcp.router();
      
      responses = [];
      mockRes = {
        json: (data) => responses.push(data),
        status: () => mockRes
      };
    });

    it('should log error when tool execution throws exception', async () => {
      // Mock the toolRegistry.executeTool to throw an exception (simulating system error)
      const originalExecuteTool = expressMcp.toolRegistry.executeTool;
      expressMcp.toolRegistry.executeTool = async () => {
        throw new Error('System error during tool execution');
      };

      // Mock response that captures status calls
      let statusCode;
      const mockResWithStatus = {
        json: (data) => responses.push(data),
        status: (code) => {
          statusCode = code;
          return mockResWithStatus;
        }
      };

      const mockReq = {
        body: {
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name: 'exception-tool',
            arguments: {}
          },
          id: 'test-exception'
        }
      };

      // Find the POST handler
      const postHandler = router.stack.find(layer => layer.route?.methods?.post)?.route?.stack?.[0]?.handle;
      assert.ok(postHandler, 'POST handler should exist');

      try {
        await postHandler(mockReq, mockResWithStatus);
        
        // Check that error was logged (should be "Request processing failed" from outer catch)
        const errorLog = logs.find(log => 
          log.level === 'error' && 
          log.message === 'Request processing failed'
        );
        assert.ok(errorLog, 'Should have logged request processing failure');
        assert.strictEqual(errorLog.data.requestId, 'test-exception');
        assert.strictEqual(errorLog.data.error, 'System error during tool execution');
        assert.ok(errorLog.data.stack, 'Should include stack trace');
        
        // Should have sent 500 error response
        assert.strictEqual(statusCode, 500);
        assert.ok(responses.length > 0);
        assert.strictEqual(responses[0].jsonrpc, '2.0');
        assert.ok(responses[0].error);
      } finally {
        // Restore original method
        expressMcp.toolRegistry.executeTool = originalExecuteTool;
      }
    });

    it('should log error when response processing throws exception', async () => {
      // Mock the toolRegistry.executeTool to return success but then mock res.json to throw
      const originalExecuteTool = expressMcp.toolRegistry.executeTool;
      expressMcp.toolRegistry.executeTool = async () => {
        const execution = new ToolExecution('exception-tool', 'test-response', {});
        execution.setStatus('success');
        execution.setResult('success');
        return execution;
      };

      // Mock response that throws when json is called
      const mockResWithError = {
        json: () => {
          throw new Error('Response serialization failed');
        },
        status: () => mockResWithError
      };

      const mockReq = {
        body: {
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name: 'exception-tool',
            arguments: {}
          },
          id: 'test-response'
        }
      };

      // Find the POST handler
      const postHandler = router.stack.find(layer => layer.route?.methods?.post)?.route?.stack?.[0]?.handle;
      assert.ok(postHandler, 'POST handler should exist');

      try {
        await postHandler(mockReq, mockResWithError);
        assert.fail('Should have thrown an error');
      } catch (error) {
        assert.strictEqual(error.message, 'Response serialization failed');
        
        // Check that the inner catch block error was logged (at warn level)
        const errorLog = logs.find(log => 
          log.level === 'warn' && 
          log.message === 'Tool execution failed with exception'
        );
        assert.ok(errorLog, 'Should have logged tool execution exception');
        assert.strictEqual(errorLog.data.requestId, 'test-response');
        assert.strictEqual(errorLog.data.toolName, 'exception-tool');
        assert.strictEqual(errorLog.data.error, 'Response serialization failed');
        assert.ok(errorLog.data.durationMs >= 1, 'Should have timing information');
        assert.ok(errorLog.data.stack, 'Should include stack trace');
      } finally {
        // Restore original method
        expressMcp.toolRegistry.executeTool = originalExecuteTool;
      }
    });
  });

  describe('Child Logger Usage', () => {
    let expressMcp;
    let router;
    let mockRes;

    beforeEach(() => {
      expressMcp = new ExpressMcp({
        logger: mockLogger,
        enableKnowledgeBase: false
      });

      router = expressMcp.router();
      mockRes = {
        json: () => {},
        status: () => mockRes
      };
    });

    it('should log initialize on child logger with requestId', async () => {
      const mockReq = {
        body: {
          jsonrpc: '2.0',
          method: 'initialize',
          id: 'init-test'
        }
      };

      const postHandler = router.stack.find(layer => layer.route?.methods?.post)?.route?.stack?.[0]?.handle;
      await postHandler(mockReq, mockRes);

      const initLog = logs.find(log => log.message === 'MCP client initialized');
      assert.ok(initLog);
      assert.strictEqual(initLog.data.requestId, 'init-test');
    });

    it('should handle unknown method with child logger', async () => {
      const mockReq = {
        body: {
          jsonrpc: '2.0',
          method: 'unknown-method',
          id: 'unknown-test'
        }
      };

      const postHandler = router.stack.find(layer => layer.route?.methods?.post)?.route?.stack?.[0]?.handle;
      await postHandler(mockReq, mockRes);

      const warnLog = logs.find(log => log.message === 'Unknown method called');
      assert.ok(warnLog);
      assert.strictEqual(warnLog.data.requestId, 'unknown-test');
      assert.strictEqual(warnLog.data.method, 'unknown-method');
    });
  });
});
