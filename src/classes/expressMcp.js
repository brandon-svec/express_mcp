import { Router } from 'express';
import pino from 'pino';
import { readFileSync } from 'fs';
import { ToolRegistry } from './toolRegistry.js';
import { KnowledgeBase } from './knowledgeBase.js';
import { ToolExecution } from './toolExecution.js';
import { AuthManager } from './authManager.js';
import { 
  KnowledgeBaseSearchTool,
  KnowledgeBaseListTool,
  KnowledgeBaseGetTool
} from '../tools/knowledgeBase.js';

const packageVersion = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

/**
 * ExpressMcp class that provides MCP functionality
 */
export class ExpressMcp {
  /**
   * Create a new ExpressMcp instance
   * @param {Object} [options={}] - Configuration options
   * @param {string} [options.name] - Name for this ExpressMcp instance (used in logging)
   * @param {string} [options.description] - Description to append to knowledge base tool descriptions
   * @param {boolean} [options.enableKnowledgeBase=true] - Whether to register knowledge base tools (kb_search, kb_list, kb_get)
   * @param {Object} [options.logger] - Custom logger instance (must have info, warn, error, debug methods)
   * @param {Object} [options.loggerOptions] - Pino logger options (used only if logger is not provided)
   *   - Use enabled: true/false to control logging
   *   - Tool arguments are never logged for security reasons
   * @param {Object} [options.auth] - Optional OAuth SSO configuration
   * @param {boolean} [options.auth.enabled=false] - Enable Bearer JWT auth on MCP routes
   * @param {string} [options.auth.provider='github'] - 'github' | 'google'
   * @param {string} options.auth.clientId - OAuth client ID
   * @param {string} options.auth.clientSecret - OAuth client secret
   * @param {string} options.auth.callbackUrl - OAuth redirect URI (e.g. http://localhost:3000/auth/callback)
   * @param {string} options.auth.jwtSecret - Secret for signing MCP session JWTs
   * @param {string} [options.auth.jwtExpiresIn='7d'] - JWT expiry
   * @param {string} options.auth.sessionSecret - Secret for express-session (OAuth handshake only)
   */
  constructor(options = {}) {
    this.options = Object.assign({
      enableKnowledgeBase: true, // Default true
      loggerOptions: {
        level: 'info',
        name: 'express-mcp',
        enabled: true // Default enabled
      },
      auth: {
        enabled: false
      }
    }, options);
    
    // Store the instance name and description
    this.name = this.options.name;
    this.description = this.options.description;
    
    // Initialize logger
    this._initializeLogger();
    
    this.toolRegistry = new ToolRegistry({
      logger: this.logger
    });
    this.knowledgeBase = new KnowledgeBase({
      logger: this.logger,
      description: this.description
    });
    
    if (this.options.enableKnowledgeBase) {
      this.toolRegistry.register(new KnowledgeBaseSearchTool(this.knowledgeBase), this.name);
      this.toolRegistry.register(new KnowledgeBaseListTool(this.knowledgeBase), this.name);
      this.toolRegistry.register(new KnowledgeBaseGetTool(this.knowledgeBase), this.name);
    }

    this.authManager = null;
    if (this.options.auth?.enabled) {
      this._initializeAuth();
    }
    
    this.logger.info('ExpressMcp instance initialized successfully');
  }

  /**
   * Initialize AuthManager when auth is enabled.
   * @private
   */
  _initializeAuth() {
    const auth = this.options.auth;
    const required = ['clientId', 'clientSecret', 'callbackUrl', 'jwtSecret', 'sessionSecret'];
    const missing = required.filter((key) => !auth[key]);

    if (missing.length > 0) {
      throw new Error(
        `Auth enabled but missing required options: ${missing.join(', ')}`
      );
    }

    this.authManager = new AuthManager({
      provider: auth.provider || 'github',
      clientId: auth.clientId,
      clientSecret: auth.clientSecret,
      callbackUrl: auth.callbackUrl,
      jwtSecret: auth.jwtSecret,
      jwtExpiresIn: auth.jwtExpiresIn,
      sessionSecret: auth.sessionSecret,
      logger: this.logger
    });

    this.logger.info(
      { provider: auth.provider || 'github' },
      'OAuth authentication enabled for MCP routes'
    );
  }

  /**
   * Whether authentication is enabled for this instance.
   * @returns {boolean}
   */
  isAuthEnabled() {
    return Boolean(this.authManager);
  }

  /**
   * Express router for OAuth login, callback, logout, and /me.
   * Mount at `/auth` when auth is enabled.
   * @param {Object} [sessionOptions] - Options passed to express-session
   * @returns {import('express').Router}
   */
  authRouter(sessionOptions = {}) {
    if (!this.authManager) {
      throw new Error('Auth is not enabled. Set options.auth.enabled to true.');
    }
    return this.authManager.createAuthRouter(sessionOptions);
  }

  /**
   * Refresh knowledge base tool descriptions with current state
   * @private
   */
  _refreshKnowledgeBaseToolDescriptions() {
    if (this.options.enableKnowledgeBase) {
      this.knowledgeBase.refreshToolDescriptions();
    }
  }

  /**
   * Initialize logger based on configuration
   * @private
   */
  _initializeLogger() {
    if (this.options.logger) {
      // Use provided logger instance and add version to all logs
      this.logger = this.options.logger.child({ mcpVersion: packageVersion });
    } else {
      // Always create a Pino logger, use enabled flag to control logging
      const loggerOptions = {
        ...this.options.loggerOptions,
        // Add version to all logs
        base: {
          mcpVersion: packageVersion,
          ...(this.options.loggerOptions?.base || {})
        }
      };
      
      // Override logger name if instance name is provided
      if (this.options.name) {
        loggerOptions.name = this.options.name;
      }
      
      this.logger = pino(loggerOptions);
    }
  }

  /**
   * Register a tool with this MCP instance
   * @param {BaseTool} toolInstance - Instance of a class that extends BaseTool
   */
  registerTool(toolInstance) {
    const result = this.toolRegistry.register(toolInstance);
    this.logger.info({ toolName: toolInstance.name }, 'Tool registered successfully');
    return result;
  }

  /**
   * Unregister a tool from this MCP instance
   * @param {string} toolName - Name of the tool to unregister
   */
  unregisterTool(toolName) {
    const result = this.toolRegistry.unregister(toolName);
    this.logger.info({ toolName }, 'Tool unregistered successfully');
    return result;
  }

  /**
   * Get all registered tools
   * @returns {Array} Array of tool instances
   */
  getRegisteredTools() {
    return this.toolRegistry.getTools();
  }

  /**
   * Check if a tool is registered
   * @param {string} toolName - Name of the tool
   * @returns {boolean} True if the tool is registered
   */
  hasRegisteredTool(toolName) {
    return this.toolRegistry.hasTool(toolName);
  }

  /**
   * Get the count of registered tools
   * @returns {number} Number of registered tools
   */
  getRegisteredToolCount() {
    return this.toolRegistry.getToolCount();
  }

  /**
   * Clear all registered tools
   */
  clearRegisteredTools() {
    const result = this.toolRegistry.clear();
    this.logger.info('All registered tools cleared');
    return result;
  }

  /**
   * Get the knowledge base instance
   * @returns {KnowledgeBase} Knowledge base instance
   */
  getKnowledgeBase() {
    return this.knowledgeBase;
  }

  /**
   * Add a document to the knowledge base
   * @param {string} id - Unique document identifier
   * @param {Object} document - Document object with title, content, metadata
   * @returns {Promise<Object>} Result object with success status and document ID
   */
  async addDocument(id, document) {
    try {
      const result = await this.knowledgeBase.addDocument(id, document);
      this._refreshKnowledgeBaseToolDescriptions();
      this.logger.info({ documentId: id }, 'Document added successfully');
      return result;
    } catch (error) {
      this.logger.error({ documentId: id, error: error.message }, 'Failed to add document');
      throw error;
    }
  }

  /**
   * Update an existing document in the knowledge base
   * @param {string} id - Document ID
   * @param {Object} updates - Document updates
   * @returns {Promise<Object>} Result object with success status and document ID
   */
  async updateDocument(id, updates) {
    try {
      const result = await this.knowledgeBase.updateDocument(id, updates);
      this._refreshKnowledgeBaseToolDescriptions();
      this.logger.info({ documentId: id }, 'Document updated successfully');
      return result;
    } catch (error) {
      this.logger.error({ documentId: id, error: error.message }, 'Failed to update document');
      throw error;
    }
  }

  /**
   * Remove a document from the knowledge base
   * @param {string} id - Document ID
   * @returns {Promise<Object>} Result object with success status and document ID
   */
  async removeDocument(id) {
    try {
      const result = await this.knowledgeBase.removeDocument(id);
      this._refreshKnowledgeBaseToolDescriptions();
      this.logger.info({ documentId: id }, 'Document removed successfully');
      return result;
    } catch (error) {
      this.logger.error({ documentId: id, error: error.message }, 'Failed to remove document');
      throw error;
    }
  }

  /**
   * Get knowledge base statistics
   * @returns {Promise<Object>} Statistics about the knowledge base
   */
  async getKnowledgeBaseStats() {
    return await this.knowledgeBase.getStats();
  }

  /**
   * Creates an Express router with MCP protocol routes
   * @returns {Router} Express router configured for MCP
   */
  router() {
    const router = Router();
    const toolRegistry = this.toolRegistry;

    if (this.authManager) {
      router.use(this.authManager.bearerAuthMiddleware());
    }

    // MCP Streamable HTTP endpoint for Cursor
    router.post('/', async (req, res) => {
      const requestId = req.body?.id || 'unknown';
      const requestLogger = this.logger.child({ requestId });
      
      try {
        const { jsonrpc, method, params, id } = req.body;
        
        // Validate JSON-RPC 2.0 format
        if (jsonrpc !== '2.0') {
          requestLogger.warn({ jsonrpc }, 'Invalid JSON-RPC version');
          return res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32600, message: 'Invalid Request - jsonrpc must be "2.0"' },
            id: id ?? null
          });
        }
        
        // Handle MCP protocol messages
        switch (method) {
          case 'notifications/initialized':
            // Cursor sends this after initialization - just acknowledge it
            res.json({
              jsonrpc: '2.0',
              result: null,
              id: id ?? null
            });
            break;
            
          case 'initialize':
            this.logger.debug('Client connected to MCP server');
            {
              const serverName = this.name || '@express-mcp/express-mcp';
              const result = {
                protocolVersion: '2024-11-05',
                capabilities: {
                  tools: {}
                },
                serverInfo: {
                  name: serverName,
                  version: packageVersion,
                  ...(this.authManager
                    ? {
                        auth: {
                          required: true,
                          provider: this.options.auth.provider || 'github'
                        }
                      }
                    : {})
                }
              };
              if (typeof this.description === 'string' && this.description.trim().length > 0) {
                result.instructions = this.description.trim();
              }
              res.json({
                jsonrpc: '2.0',
                result,
                id: id ?? null
              });
            }
            break;
            
          case 'tools/list': {
            const tools = toolRegistry.getToolDefinitions();
            res.json({
              jsonrpc: '2.0',
              result: {
                tools
              },
              id: id ?? null
            });
            break;
          }
            
          case 'tools/call': {
            const { name, arguments: args } = params;
            
            // Create ToolExecution instance for this tool call
            const toolExecution = new ToolExecution(name, id, args);
            
            const toolContext = {
              execution: toolExecution
            };
            
            try {
              const execution = await toolRegistry.executeTool(name, args, toolContext);
              
              // Get execution data for logging
              const executionData = execution.getLogData();
              
              // Create JSON-RPC response based on execution status
              let response;
              if (execution.status === 'error') {
                const errorData = execution.getErrorData();
                response = {
                  jsonrpc: '2.0',
                  error: {
                    code: errorData.errorCode || -32603,
                    message: errorData.error || 'Tool execution failed'
                  },
                  id: id
                };
                
                if (errorData.errorData) {
                  response.error.data = errorData.errorData;
                }
                
                requestLogger.warn({ ...executionData, errorDetails: errorData }, 'Tool call failed');
              } else {
                response = {
                  jsonrpc: '2.0',
                  result: {
                    content: [
                      {
                        type: 'text',
                        text: typeof execution.result === 'string' ? execution.result : JSON.stringify(execution.result, null, 2)
                      }
                    ]
                  },
                  id: id
                };
                
                requestLogger.info({ 
                  ...executionData
                }, 'Tool call succeeded');
              }
              
              res.json(response);
            } catch (error) {
              // Get execution data even on exception
              const executionData = toolExecution.getLogData();
              
              requestLogger.warn({ 
                ...executionData,
                error: error.message, 
                stack: error.stack 
              }, 'Tool execution failed with exception');
              throw error;
            }
            break;
          }
            
          default:
            requestLogger.warn({ method }, 'Unknown method called');
            res.status(400).json({
              jsonrpc: '2.0',
              error: { code: -32601, message: `Unknown method: ${method}` },
              id: id ?? null
            });
        }
      } catch (error) {
        requestLogger.error({ error: error.message, stack: error.stack }, 'Request processing failed');
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: error.message },
          id: req.body?.id ?? null
        });
      }
    });

    return router;
  }
}