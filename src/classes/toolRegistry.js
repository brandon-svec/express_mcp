import { ToolExecution } from './toolExecution.js';
import { HookBlockedError } from './baseHook.js';
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
    /** @type {import('./hookRegistry.js').HookRegistry|null} */
    this.hookRegistry = options.hookRegistry || null;
    /** @type {import('../telemetry/telemetryEngine.js').TelemetryEngine|null} */
    this.telemetryEngine = options.telemetryEngine || null;
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
   * @param {{ user?: Object|null, sessionId?: string|null, permissionMode?: string, meta?: Object }} [context]
   */
  registerOnMcpServer(mcpServer, context = {}) {
    const server = mcpServer.server;

    server.registerCapabilities({
      tools: {}
    });

    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: this.getToolDefinitions()
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args } = request.params;
      const requestId = extra?.requestId ?? null;
      const sessionId = extra?.sessionId ?? context.sessionId ?? null;
      const headerTraceparent = extra?.requestInfo?.headers?.traceparent
        ?? extra?.requestInfo?.headers?.Traceparent
        ?? null;
      const traceparent = extra?._meta?.traceparent
        ?? headerTraceparent
        ?? context.meta?.traceparent
        ?? null;
      const meta = {
        ...(extra?._meta || {}),
        ...(traceparent ? { traceparent } : {})
      };

      const toolExecution = new ToolExecution(name, requestId, args);
      const toolContext = {
        execution: toolExecution,
        user: context.user ?? null,
        sessionId,
        permissionMode: context.permissionMode ?? 'default',
        meta,
        extra: extra ?? null,
        mcpServer
      };

      const execution = await this.executeTool(name, args, toolContext);

      if (execution.status === 'error') {
        const errorData = execution.getErrorData();
        if (errorData.errorData?.hookBlocked === true) {
          const parts = [{ type: 'text', text: errorData.error }];
          if (errorData.errorData.additionalContext) {
            parts.push({ type: 'text', text: errorData.errorData.additionalContext });
          }
          return { isError: true, content: parts };
        }
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
      const content = [
        {
          type: 'text',
          text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
        }
      ];
      if (execution.hookAdditionalContext) {
        content.push({ type: 'text', text: execution.hookAdditionalContext });
      }
      return { content };
    });
  }

  /**
   * Get tool definitions for MCP protocol
   * @returns {Array} Array of tool definitions
   */
  getToolDefinitions() {
    return this.getTools().map(tool => {
      const definition = {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema || {
          type: "object",
          properties: {},
          required: []
        }
      };
      if (tool.annotations !== undefined) {
        definition.annotations = tool.annotations;
      }
      return definition;
    });
  }

  /**
   * Map a validateInput failure onto execution error fields.
   * @param {import('./baseTool.js').BaseTool} tool
   * @param {Error} validationError
   * @param {ToolExecution} execution
   * @private
   */
  _setValidationError(tool, validationError, execution) {
    let errorDetails = validationError.message;
    let errorData = null;

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

      const errorMessages = ajvErrors.map(err =>
        err.property === 'root'
          ? `${err.message}`
          : `Property '${err.property}' ${err.message}`
      );
      errorDetails = `Validation failed: ${errorMessages.join('; ')}`;
    }

    execution.setError(errorDetails, -32602, errorData);
  }

  /**
   * Whether PermissionRequest hooks should run for this tool call.
   * @param {import('./baseTool.js').BaseTool} tool
   * @param {string} permissionMode
   * @param {Object} eventFields
   * @returns {boolean}
   * @private
   */
  _shouldRunPermissionRequest(tool, permissionMode, eventFields) {
    if (!this.hookRegistry) {
      return false;
    }
    const permissionHooks = this.hookRegistry.getHooks('PermissionRequest');
    if (permissionHooks.length === 0) {
      return false;
    }
    if (permissionMode === 'ask_for_approval') {
      return true;
    }
    if (tool.annotations?.destructiveHint === true) {
      return true;
    }
    // Matcher-less hooks match every tool; otherwise require a tool_name matcher hit.
    const event = this.hookRegistry.buildEventPayload('PermissionRequest', eventFields);
    return permissionHooks.some((hook) => hook.matches(event));
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
    const sessionId = context.sessionId ?? null;
    const meta = context.meta ?? {};

    let toolSpan = null;
    if (this.telemetryEngine) {
      try {
        toolSpan = this.telemetryEngine.startToolSpan({
          toolName: finalName,
          sessionId,
          traceparent: meta.traceparent ?? null,
          user: context.user ?? null,
          args,
        });
      } catch {
        toolSpan = null;
      }
    }

    try {
      if (!tool) {
        execution.setError(`Tool '${toolName}' not found`, -32601);
        return execution;
      }

      // Validate input if tool has schema - handle validation errors separately
      try {
        tool.validateInput(args);
      } catch (validationError) {
        this._setValidationError(tool, validationError, execution);
        return execution;
      }

      let effectiveArgs = args;
      const contextParts = [];
      const userMessages = [];
      const permissionMode = context.permissionMode ?? 'default';
      const hookContext = {
        user: context.user ?? null,
        hostContext: context.hostContext ?? null,
        execution,
        logger: this.logger,
        extra: context.extra ?? null,
        mcpServer: context.mcpServer ?? null
      };

      if (this.hookRegistry) {
        const toolFields = {
          session_id: sessionId ?? 'default',
          permission_mode: permissionMode,
          meta,
          tool_name: finalName,
          tool_input: effectiveArgs,
          tool_annotations: tool.annotations ?? null
        };

        const preResult = await this.hookRegistry.runHooks('PreToolUse', toolFields, hookContext);
        if (preResult.additionalContext) {
          contextParts.push(preResult.additionalContext);
        }
        if (preResult.userMessages?.length) {
          userMessages.push(...preResult.userMessages);
        }
        if (preResult.blocked) {
          execution.setError(preResult.stderr || 'Tool call blocked by hook', -32002, {
            hookBlocked: true,
            hookEvent: preResult.hookEvent,
            additionalContext: preResult.additionalContext,
            userMessage: preResult.userMessages?.[0] ?? null
          });
          execution.hookAdditionalContext = contextParts.length > 0 ? contextParts.join('\n') : null;
          execution.hookUserMessages = userMessages;
          return execution;
        }
        if (preResult.decision === 'modify' && preResult.updatedInput !== undefined) {
          effectiveArgs = preResult.updatedInput;
          try {
            tool.validateInput(effectiveArgs);
          } catch (validationError) {
            this._setValidationError(tool, validationError, execution);
            return execution;
          }
        }

        const permissionFields = {
          ...toolFields,
          tool_input: effectiveArgs
        };
        if (this._shouldRunPermissionRequest(tool, permissionMode, permissionFields)) {
          const permResult = await this.hookRegistry.runHooks(
            'PermissionRequest',
            permissionFields,
            hookContext
          );
          if (permResult.additionalContext) {
            contextParts.push(permResult.additionalContext);
          }
          if (permResult.userMessages?.length) {
            userMessages.push(...permResult.userMessages);
          }
          if (permResult.blocked) {
            execution.setError(permResult.stderr || 'Tool call blocked by hook', -32002, {
              hookBlocked: true,
              hookEvent: permResult.hookEvent,
              additionalContext: permResult.additionalContext,
              userMessage: permResult.userMessages?.[0] ?? null
            });
            execution.hookAdditionalContext = contextParts.length > 0 ? contextParts.join('\n') : null;
            execution.hookUserMessages = userMessages;
            return execution;
          }
          if (permResult.decision === 'modify' && permResult.updatedInput !== undefined) {
            effectiveArgs = permResult.updatedInput;
            try {
              tool.validateInput(effectiveArgs);
            } catch (validationError) {
              this._setValidationError(tool, validationError, execution);
              return execution;
            }
          }
        }
      }

      // Execute the tool - handle execution errors separately
      // Propagate the TOOL span's traceparent so nested work (e.g. agent_ask →
      // processMessage) parents under this toolSpan rather than becoming a sibling.
      try {
        const activeTraceparent = toolSpan?.traceparent ?? meta.traceparent ?? null;
        const executionContext = activeTraceparent
          ? { ...context, meta: { ...meta, traceparent: activeTraceparent } }
          : context;
        const result = await tool.execute(effectiveArgs, executionContext);
        
        // Always set the result unless it's an error status
        // setResult() will automatically set status to 'success' if not already set
        if (execution.status !== 'error') {
          execution.setResult(result);
        }
      } catch (executionError) {
        if (executionError instanceof HookBlockedError) {
          execution.setError(executionError.stderr || executionError.message, -32002, {
            hookBlocked: true,
            hookEvent: executionError.hookEvent,
            additionalContext: executionError.additionalContext,
            userMessage: executionError.userMessage
          });
          if (executionError.additionalContext) {
            contextParts.push(executionError.additionalContext);
          }
          execution.hookAdditionalContext = contextParts.length > 0 ? contextParts.join('\n') : null;
          execution.hookUserMessages = userMessages;
          return execution;
        }
        this.logger?.error?.(
          { toolName: finalName, error: executionError.message, stack: executionError.stack },
          'Tool execution failed'
        );
        execution.setError('Tool execution failed', -32603, null);
        return execution;
      }

      if (execution.status === 'success' && this.hookRegistry) {
        const postResult = await this.hookRegistry.runHooks(
          'PostToolUse',
          {
            session_id: sessionId ?? 'default',
            permission_mode: permissionMode,
            meta,
            tool_name: finalName,
            tool_input: effectiveArgs,
            tool_result: execution.result,
            tool_annotations: tool.annotations ?? null,
            duration_ms: execution.getDuration()
          },
          hookContext
        );
        if (postResult.additionalContext) {
          contextParts.push(postResult.additionalContext);
        }
        if (postResult.userMessages?.length) {
          userMessages.push(...postResult.userMessages);
        }
      }

      if (contextParts.length > 0) {
        execution.hookAdditionalContext = contextParts.join('\n');
      }
      if (userMessages.length > 0) {
        execution.hookUserMessages = userMessages;
      }

      return execution;
    } finally {
      if (toolSpan && this.telemetryEngine) {
        try {
          this.telemetryEngine.endToolSpan(toolSpan, {
            status: execution.status,
            result: execution.result,
            errorData: execution.status === 'error' ? execution.getErrorData() : null,
            durationMs: execution.getDuration(),
          });
        } catch {
          // Telemetry must never affect tool execution
        }
      }
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
