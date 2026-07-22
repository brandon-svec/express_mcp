#!/usr/bin/env node

/**
 * Simple MCP Integration Example
 * Shows how to add MCP functionality with tools and knowledge base to any Express server
 */

import express from 'express';
import { ExpressMcp, BaseTool } from '../src/index.js';

// Example custom tool - create your own by extending BaseTool
// It is important to be very descriptive in the description and input schema. 
// This is what the agent uses to understand the tool.
class GreetingTool extends BaseTool {
  constructor() {
    super(
      'hello', // Name of the tool in MCP
      'Says hello with an optional name', // Description of the tool in MCP
      { // Input schema for the tool in MCP
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name to greet' }
        }
      }
    );
  }
  
  async execute(args) {
    const name = args?.name || 'World';
    return `Hello, ${name}! This is a response from an MCP tool.`;
  }
}

// Example calculator tool to demonstrate input validation and error handling
class CalculatorTool extends BaseTool {
  constructor() {
    super('calculator', 'Performs basic mathematical operations');
    this.inputSchema = {
      type: 'object',
      properties: {
        operation: { 
          type: 'string', 
          enum: ['add', 'multiply'],
          description: 'Mathematical operation to perform' 
        },
        a: { type: 'number', description: 'First number' },
        b: { type: 'number', description: 'Second number' }
      },
      required: ['operation', 'a', 'b']
    };
  }
  
  async execute(args, context) {
    // 1. Extract the toolExecution from the context
    const { execution } = context;
    const { operation, a, b } = args;
    
    // 2. Add initial log data about the operation
    execution.addLogData({
      operation,
      operands: { a, b }
    });
    
    let result;
    switch (operation) {
      case 'add':
        result = a + b;
        break;
      case 'multiply':
        result = a * b;
        break;
      default:
        execution.addLogData({ 
          errorType: 'unknown_operation',
          requestedOperation: operation
        });
        throw new Error(`Unknown operation: ${operation}`);
    }
    
    // 3. Add final result log data
    execution.addLogData({ result });
    
    return result;
  }
}

async function startSimpleExample() {
  const port = process.argv[2] ? parseInt(process.argv[2]) : 3000;
  
  console.log('🚀 Starting Simple MCP Example with Enhanced Knowledge Base...');

  // Create ExpressMcp instance with custom description
  // This description will be included in all knowledge base tool descriptions
  const expressMcp = new ExpressMcp({
    name: 'example-mcp-server',
    description: 'Example API documentation and tool server',
    loggerOptions: {
      enabled: true,
      level: 'info'
    }
  });
  
  // Register custom tools
  expressMcp.registerTool(new GreetingTool());
  expressMcp.registerTool(new CalculatorTool());
  console.log('✅ Registered custom tools');

  // Create Express app
  const app = express();
  app.use(express.json());

  // Add MCP functionality with ExpressMcp class
  app.use('/mcp', expressMcp.router());

  console.log('✅ MCP integration complete!');

  // Add comprehensive sample documents to demonstrate KB functionality
  await expressMcp.addDocument('welcome', {
    title: 'Welcome Guide',
    content: 'Welcome to the MCP example server! This server provides greeting and calculator tools, plus knowledge base search capabilities. The knowledge base supports full-text search, tagging, and automatic excerpt generation.',
    tags: ['guide', 'welcome', 'getting-started']
  });

  await expressMcp.addDocument('api-overview', {
    title: 'API Overview',
    content: 'This API provides several endpoints for testing MCP integration. Use the greeting tool to say hello, the calculator for math operations, and the knowledge base tools to search documentation.',
    tags: ['api', 'overview', 'documentation']
  });

  await expressMcp.addDocument('calculator-guide', {
    title: 'Calculator Tool Usage',
    content: 'The calculator tool supports basic mathematical operations including addition and multiplication. Pass the operation type and two numbers as parameters.',
    tags: ['calculator', 'tools', 'math', 'tutorial']
  });

  await expressMcp.addDocument('kb-features', {
    title: 'Knowledge Base Features',
    content: 'The knowledge base includes full-text search powered by FlexSearch, document tagging, metadata support, and automatic excerpt generation. Search results are ranked by relevance and include highlighted excerpts.',
    tags: ['knowledge-base', 'search', 'features', 'flexsearch']
  });

  await expressMcp.addDocument('troubleshooting', {
    title: 'Troubleshooting Common Issues',
    content: 'Common issues include incorrect tool parameters, missing required fields, and network connectivity problems. Check the logs for detailed error messages and ensure all required parameters are provided.',
    tags: ['troubleshooting', 'errors', 'debugging', 'help']
  });

  // Show how tool descriptions now include available tags dynamically
  const tools = expressMcp.getRegisteredTools();
  console.log('📚 Available tools with dynamic descriptions:');
  tools.forEach(tool => {
    console.log(`  • ${tool.name}: ${tool.description}`);
  });

  // Get knowledge base statistics
  const stats = await expressMcp.getKnowledgeBaseStats();
  console.log(`📊 Knowledge Base: ${stats.totalDocuments} documents, ${stats.uniqueTags} unique tags`);
  console.log(`🏷️  Available tags: ${stats.tags.join(', ')}`);

  // Start the server
  app.listen(port, () => {
    console.log(`🌟 Server running on http://localhost:${port}`);
    console.log(`🔧 MCP endpoint: http://localhost:${port}/mcp`);
    console.log(`🛠️  Tools: ${tools.map(t => t.name).join(', ')}`);
    console.log(`\n💡 Try these MCP calls:`);
    console.log(`   • kb_search: Search the knowledge base`);
    console.log(`   • kb_list: List documents by tag`);
    console.log(`   • hello: Get a greeting`);
    console.log(`   • calculator: Do math operations`);
    console.log(`\n🏷️  Knowledge base tags: ${stats.tags.join(', ')}`);
  });
}

// Run the example
startSimpleExample().catch(console.error);
