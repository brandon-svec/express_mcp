/**
 * Test utilities for ExpressMcp test suite
 * Common helper functions and test tools
 */

import { BaseTool } from '../src/classes/baseTool.js';

/**
 * Creates a simple test tool for testing purposes
 */
export class SimpleTestTool extends BaseTool {
  constructor(name = 'simple-test', description = 'A simple test tool') {
    super(name, description);
  }

  async execute(args) {
    return `SimpleTestTool executed with: ${JSON.stringify(args)}`;
  }
}

/**
 * Creates a test tool that throws errors for error testing
 */
export class ErrorTestTool extends BaseTool {
  constructor(message = 'Test error') {
    super('error-test', 'Tool that throws errors for testing');
    this.errorMessage = message;
  }

  async execute() {
    throw new Error(this.errorMessage);
  }
}

/**
 * Creates a test tool that returns different data types
 */
export class DataTypeTestTool extends BaseTool {
  constructor() {
    super('data-type-test', 'Tool that returns different data types');
    this.inputSchema = {
      type: 'object',
      properties: {
        type: { 
          type: 'string', 
          enum: ['string', 'number', 'object', 'array', 'boolean', 'null'],
          description: 'Type of data to return'
        }
      },
      required: ['type']
    };
  }

  async execute(args) {
    const { type } = args;
    
    switch (type) {
      case 'string':
        return 'test string';
      case 'number':
        return 42;
      case 'object':
        return { key: 'value', nested: { count: 3 } };
      case 'array':
        return [1, 2, 3, 'four', { five: 5 }];
      case 'boolean':
        return true;
      case 'null':
        return null;
      default:
        return `Unknown type: ${type}`;
    }
  }
}

/**
 * Creates a test tool with complex input schema
 */
export class ComplexSchemaTestTool extends BaseTool {
  constructor() {
    super('complex-schema-test', 'Tool with complex input schema');
    this.inputSchema = {
      type: 'object',
      properties: {
        requiredParam: {
          type: 'string',
          description: 'A required parameter'
        },
        optionalParam: {
          type: 'number',
          description: 'An optional parameter',
          default: 10
        },
        enumParam: {
          type: 'string',
          enum: ['option1', 'option2', 'option3'],
          description: 'Parameter with enum values'
        },
        nestedObject: {
          type: 'object',
          properties: {
            nestedString: { type: 'string' },
            nestedNumber: { type: 'number' }
          },
          required: ['nestedString']
        },
        arrayParam: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of strings'
        }
      },
      required: ['requiredParam', 'enumParam']
    };
  }

  async execute(args) {
    return {
      message: 'ComplexSchemaTestTool executed successfully',
      receivedArgs: args,
      validation: 'passed'
    };
  }
}

/**
 * Validates JSON-RPC 2.0 response structure
 */
export function validateJsonRpcResponse(response, expectedId = null) {
  if (!response || typeof response !== 'object') {
    throw new Error('Response must be an object');
  }

  if (response.jsonrpc !== '2.0') {
    throw new Error('Response must have jsonrpc: "2.0"');
  }

  if (response.id !== expectedId) {
    throw new Error(`Expected id ${expectedId}, got ${response.id}`);
  }

  if (response.result !== undefined && response.error !== undefined) {
    throw new Error('Response cannot have both result and error');
  }

  if (response.result === undefined && response.error === undefined) {
    throw new Error('Response must have either result or error');
  }

  return true;
}

/**
 * Validates MCP tool definition structure
 */
export function validateToolDefinition(toolDef) {
  if (!toolDef || typeof toolDef !== 'object') {
    throw new Error('Tool definition must be an object');
  }

  if (typeof toolDef.name !== 'string' || !toolDef.name) {
    throw new Error('Tool definition must have a non-empty name string');
  }

  if (typeof toolDef.description !== 'string' || !toolDef.description) {
    throw new Error('Tool definition must have a non-empty description string');
  }

  if (!toolDef.inputSchema || typeof toolDef.inputSchema !== 'object') {
    throw new Error('Tool definition must have an inputSchema object');
  }

  return true;
}

/**
 * Creates a mock Express app for testing
 */
export function createMockExpressApp() {
  const app = {
    use: function(path, router) {
      this.routes = this.routes || [];
      this.routes.push({ path, router });
    },
    routes: []
  };
  
  return app;
}

/**
 * Waits for a specified amount of time
 */
export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Generates unique test IDs
 */
export function generateTestId() {
  return Math.floor(Math.random() * 1000000);
}

/**
 * Creates multiple test tools for bulk testing
 */
export function createTestTools(count = 3) {
  const tools = [];
  
  for (let i = 1; i <= count; i++) {
    tools.push(new SimpleTestTool(`test-tool-${i}`, `Test tool number ${i}`));
  }
  
  return tools;
}

/**
 * Validates that a function throws a specific error
 */
export async function expectToThrow(fn, expectedMessage) {
  try {
    await fn();
    throw new Error('Expected function to throw, but it did not');
  } catch (error) {
    if (expectedMessage && !error.message.includes(expectedMessage)) {
      throw new Error(`Expected error message to include "${expectedMessage}", got "${error.message}"`);
    }
    return error;
  }
}

/**
 * Deep clones an object for test isolation
 */
export function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}
