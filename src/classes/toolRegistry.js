import { ToolExecution } from './toolExecution.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError
} from '@modelcontextprotocol/sdk/types.js';

/**
 * Internal tool registry for the MCP module
 * Manages registration and execution of MCP tools
 */
export class ToolRegistry {
  constructor(options = {}) {
    this.tools = new Map();
    this.logger = options.logger || null;
    // Track original names to prefixed names mapping
    this.nameMapping = new Map();
  }

  /**
   * Register a tool instance
   * @param {BaseTool} toolInstance - Instance of a class that extends BaseTool
   * @param {string|null} [prefix=null] - Optional prefix to apply to the tool name
   */
  register(toolInstance, prefix = null) {
    if (!toolInstance || typeof toolInstance.execute !== 'function') {
      throw new Error('Tool must have an execute method');
    }
    
    if (!toolInstance.name) {
      throw new Error('Tool must have a name');
    }

    const originalName = toolInstance.name;
    let finalName = originalName;
    
    // Apply prefix if provided
    if (prefix) {
      finalName = `${prefix}_${originalName}`;
      // Update the tool instance's name to the prefixed version
      toolInstance.name = finalName;
    }

    // Check for any existing registration of this original name
    if (this.nameMapping.has(originalName)) {
      throw new Error(`Tool '${originalName}' is already registered. Cannot register duplicate tool names.`);
    }
    
    // Check for final name conflicts with other tools
    if (this.tools.has(finalName)) {
      // Find which original name maps to this final name
      let conflictingOriginalName = null;
      for (const [origName, mappedFinalName] of this.nameMapping.entries()) {
        if (mappedFinalName === finalName) {
          conflictingOriginalName = origName;
          break;
        }
      }
      
      if (conflictingOriginalName) {
        throw new Error(`Tool name conflict: '${originalName}' would create final name '${finalName}' which conflicts with existing tool '${conflictingOriginalName}'.`);
      }
    }

    // Store the tool with the final name
    this.tools.set(finalName, toolInstance);
    
    // Track the mapping from original name to final name for easier unregistration
    this.nameMapping.set(originalName, finalName);
  }


  /**
   * Unregister a tool
   * @param {string} toolName - Name of the tool to unregister (original or final name)
   */
  unregister(toolName) {
    // Check if this is an original name that was mapped to a final name
    const finalName = this.nameMapping.get(toolName) || toolName;
    
    // Remove from tools registry
    const wasRemoved = this.tools.delete(finalName);
    
    // Clean up name mapping if tool was found
    if (wasRemoved) {
      // Find and remove the mapping entry
      for (const [originalName, mappedFinalName] of this.nameMapping.entries()) {
        if (mappedFinalName === finalName) {
          this.nameMapping.delete(originalName);
          break;
        }
      }
    }
    
    return wasRemoved;
  }

  /**
   * Get all registered tools
   * @returns {Array} Array of tool instances
   */
  getTools() {
    return Array.from(this.tools.values());
  }

  /**
   * Register all tools on an SDK McpServer instance using JSON Schema tool definitions.
   * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} mcpServer
   * @param {{ user?: Object|null }} [context]
   */
  registerOnMcpServer(mcpServer, context = {}) {
    const server = mcpServer.server;

    server.registerCapabilities({
      tools: {}
    });

    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: this.getToolDefinitions()
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const toolExecution = new ToolExecution(name, null, args);
      const toolContext = {
        execution: toolExecution,
        user: context.user ?? null
      };

      const execution = await this.executeTool(name, args, toolContext);

      if (execution.status === 'error') {
        const errorData = execution.getErrorData();
        const error = new McpError(
          errorData.errorCode ?? -32603,
          errorData.error ?? 'Tool execution failed'
        );
        if (errorData.errorData) {
          error.data = errorData.errorData;
        }
        throw error;
      }

      const result = execution.result;
      return {
        content: [
          {
            type: 'text',
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
          }
        ]
      };
    });
  }

  /**
   * Get tool definitions for MCP protocol
   * @returns {Array} Array of tool definitions
   */
  getToolDefinitions() {
    return this.getTools().map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema || {
        type: "object",
        properties: {},
        required: []
      }
    }));
  }

  /**
   * Execute a tool by name
   * @param {string} toolName - Name of the tool to execute
   * @param {Object} args - Arguments to pass to the tool
   * @param {Object} context - Context object for the tool execution (must contain execution property)
   * @returns {Object} ToolExecution object with result or error
   */
  async executeTool(toolName, args, context) {
    // Use name mapping to find the actual tool name
    const finalName = this.nameMapping.get(toolName) || toolName;
    const tool = this.tools.get(finalName);
    const { execution } = context;
    
    if (!tool) {
      execution.setError(`Tool '${toolName}' not found`, -32601);
      return execution;
    }

    // Validate input if tool has schema - handle validation errors separately
    try {
      tool.validateInput(args);
    } catch (validationError) {
      // Check if this is an AJV validation error with detailed error information
      let errorDetails = validationError.message;
      let errorData = null;
      
      // If the tool has a validator with errors, provide more structured feedback
      if (tool._validator && tool._validator.errors && tool._validator.errors.length > 0) {
        const ajvErrors = tool._validator.errors.map(err => ({
          path: err.instancePath || '/',
          property: err.instancePath ? err.instancePath.replace(/^\//, '').replace(/\//g, '.') : 'root',
          message: err.message,
          allowedValues: err.params ? err.params.allowedValues : undefined,
          schema: err.schema
        }));
        
        errorData = {
          validationErrors: ajvErrors
        };
        
        // Create a more user-friendly message
        const errorMessages = ajvErrors.map(err => 
          err.property === 'root' 
            ? `${err.message}`
            : `Property '${err.property}' ${err.message}`
        );
        errorDetails = `Validation failed: ${errorMessages.join('; ')}`;
      }
      
      execution.setError(errorDetails, -32602, errorData);
      return execution;
    }

    // Execute the tool - handle execution errors separately  
    try {
      const result = await tool.execute(args, context);
      
      // Always set the result unless it's an error status
      // setResult() will automatically set status to 'success' if not already set
      if (execution.status !== 'error') {
        execution.setResult(result);
      }
      
      return execution;
    } catch (executionError) {
      this.logger?.error?.(
        { toolName: finalName, error: executionError.message, stack: executionError.stack },
        'Tool execution failed'
      );
      execution.setError('Tool execution failed', -32603, null);
      return execution;
    }
  }

  /**
   * Check if a tool is registered
   * @param {string} toolName - Name of the tool (original or final name)
   * @returns {boolean} True if the tool is registered
   */
  hasTool(toolName) {
    // Check if this is an original name that was mapped to a final name
    const finalName = this.nameMapping.get(toolName) || toolName;
    return this.tools.has(finalName);
  }

  /**
   * Get the count of registered tools
   * @returns {number} Number of registered tools
   */
  getToolCount() {
    return this.tools.size;
  }

  /**
   * Clear all registered tools
   */
  clear() {
    this.tools.clear();
    this.nameMapping.clear();
  }
}
