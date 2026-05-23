/**
 * Test configuration for ExpressMcp test suite
 * Following admin API test patterns
 */

// Test timeout configuration
export const TEST_TIMEOUT = 10000; // 10 seconds

// Test environment configuration
export const TEST_CONFIG = {
  server: {
    port: 3000,
    host: 'localhost'
  },
  
  // Default ExpressMcp options for tests (disables logging)
  expressMcpDefaults: {
    loggerOptions: {
      enabled: false // Disable logging during tests
    }
  },
  
  // MCP protocol configuration
  mcp: {
    protocolVersion: '2024-11-05',
    jsonrpcVersion: '2.0'
  },
  
  // Test data
  testTools: {
    hello: {
      name: 'hello',
      description: 'Says hello with optional name',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name to greet' }
        }
      }
    },
    
    calculator: {
      name: 'calculator', 
      description: 'Performs basic math operations',
      inputSchema: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['add', 'subtract', 'multiply', 'divide'] },
          a: { type: 'number' },
          b: { type: 'number' }
        },
        required: ['operation', 'a', 'b']
      }
    }
  },
  
  // Sample requests for testing
  sampleRequests: {
    initialize: {
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'express-mcp-test', version: '1.0.0' }
      },
      id: 1
    },
    
    toolsList: {
      jsonrpc: '2.0',
      method: 'tools/list',
      id: 2
    },
    
    helloCall: {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'hello',
        arguments: { name: 'Test' }
      },
      id: 3
    }
  }
};

// Streamable HTTP transport requires both content types in Accept (MCP spec).
export const MCP_STREAMABLE_HTTP_ACCEPT = 'application/json, text/event-stream';

// Test utilities
export const createMcpRequest = (method, params = {}, id = 1) => ({
  jsonrpc: '2.0',
  method,
  params,
  id
});

export const createInitializeRequest = (id = 1) => ({
  jsonrpc: '2.0',
  method: 'initialize',
  params: {
    protocolVersion: TEST_CONFIG.mcp.protocolVersion,
    capabilities: {},
    clientInfo: {
      name: 'express-mcp-test',
      version: '1.0.0'
    }
  },
  id
});

/**
 * Supertest POST helper with Streamable HTTP Accept header.
 * @param {import('supertest').SuperTest} agent
 * @param {string} [path='/mcp']
 */
export function mcpPost(agent, path = '/mcp') {
  return agent.post(path).set('Accept', MCP_STREAMABLE_HTTP_ACCEPT);
}

export const createToolCallRequest = (toolName, args = {}, id = 1) => ({
  jsonrpc: '2.0',
  method: 'tools/call',
  params: {
    name: toolName,
    arguments: args
  },
  id
});

// Helper function to merge test defaults with custom options
export const getTestExpressMcpOptions = (options = {}) => ({
  ...TEST_CONFIG.expressMcpDefaults,
  ...options
});

// Expected response structures
export const EXPECTED_RESPONSES = {
  initialize: {
    jsonrpc: '2.0',
    result: {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {}
      },
      serverInfo: {
        name: '@express-mcp/express-mcp',
        version: '0.0.2'
      }
    }
  },
  
  errorResponse: (code, message, id = null) => ({
    jsonrpc: '2.0',
    error: { code, message },
    id
  }),
  
  successResponse: (result, id = null) => ({
    jsonrpc: '2.0',
    result,
    id
  })
};
