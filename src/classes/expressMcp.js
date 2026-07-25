import { Router } from 'express';
import pino from 'pino';
import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ToolRegistry } from './toolRegistry.js';
import { KnowledgeBase } from './knowledgeBase.js';
import { AuthManager } from './authManager.js';
import { userLogFields } from '../authz.js';
import { buildAuthOptions } from '../buildAuthOptions.js';
import { normalizeAuthProviders, validateAuthOptions } from '../authConfig.js';
import { 
  KnowledgeBaseSearchTool,
  KnowledgeBaseListTool,
  KnowledgeBaseGetTool
} from '../tools/knowledgeBase.js';
import { SessionTool } from '../tools/session.js';
import { Agent } from '../agents/agent.js';
import { GeminiAdapter } from '../agents/geminiAdapter.js';
import { InMemoryHistoryStore } from '../agents/historyStore.js';
import { AgentTool } from '../tools/agent.js';

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
   * @param {Object} [options.auth] - Optional OAuth SSO (normalized via buildAuthOptions)
   * @param {boolean} [options.auth.enabled=false] - Enable Bearer JWT auth on MCP routes
   * @param {string} [options.auth.baseUrl] - Public origin; issuer derived as baseUrl + resourcePath
   * @param {string} [options.auth.callbackUrl] - OAuth redirect URI (e.g. https://host/mcp/auth/callback)
   * @param {string} [options.auth.jwtSecret] - Secret for signing MCP session JWTs
   * @param {string} [options.auth.jwtExpiresIn] - JWT expiry (e.g. `7d`)
   * @param {string} [options.auth.sessionSecret] - express-session secret for OAuth handshake
   * @param {Object} [options.auth.providers] - { github|google: { clientId, clientSecret } }
   * @param {string} [options.auth.provider] - Single-provider shorthand name
   * @param {string} [options.auth.clientId] - Single-provider client ID
   * @param {string} [options.auth.clientSecret] - Single-provider client secret
   * @param {string} [options.auth.issuer] - Override derived issuer
   * @param {string} [options.auth.resourcePath] - MCP mount path (default `/mcp`)
   * @param {string[]} [options.auth.allowedUsers] - Optional allowlist; `[]` = any authenticated user
   * @param {Object} [options.agent] - Optional generic LLM agent over the tool registry
   * @param {boolean} [options.agent.enabled=false] - Enable the in-process agent
   * @param {boolean} [options.agent.exposeTool=true] - Register agent_ask MCP tool when enabled
   * @param {boolean} [options.agent.allowUnauthenticated=false] - Allow agent when auth is disabled (default: require auth)
   * @param {string[]} [options.agent.toolAllowlist] - If set, agent may only call these tool names
   * @param {string} [options.agent.systemInstruction] - System prompt for the agent
   * @param {import('../agents/modelAdapter.js').ModelAdapter} [options.agent.adapter] - Custom model adapter
   * @param {{ apiKey: string, model: string }} [options.agent.gemini] - Gemini config when adapter omitted
   * @param {import('../agents/historyStore.js').InMemoryHistoryStore} [options.agent.history] - Custom history store
   * @param {number} [options.agent.historyWindowMinutes=60] - TTL for default in-memory history
   * @param {number} [options.agent.maxToolRounds=8] - Max tool-call rounds per message
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

    if (options.auth) {
      this.options.auth = buildAuthOptions(options.auth);
    }

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
    this.enabledAuthProviders = [];
    if (this.options.auth?.enabled) {
      this._initializeAuth();
      this.toolRegistry.register(new SessionTool(this.authManager), this.name);
    } else {
      this.logger.warn(
        'Auth is disabled: MCP endpoints are unauthenticated. Enable options.auth for internet-facing deployments.'
      );
    }

    this.agent = null;
    this._initializeAgent();

    this.logger.info('ExpressMcp instance initialized successfully');
  }

  /**
   * Initialize Agent when agent.enabled is true.
   * @private
   */
  _initializeAgent() {
    const agentOpts = this.options.agent;
    if (!agentOpts || agentOpts.enabled !== true) {
      return;
    }

    const authEnabled = this.options.auth?.enabled === true;
    if (!authEnabled && agentOpts.allowUnauthenticated !== true) {
      throw new Error(
        'agent.enabled requires auth.enabled, or set agent.allowUnauthenticated: true'
      );
    }

    if (typeof agentOpts.systemInstruction !== 'string' || !agentOpts.systemInstruction.trim()) {
      throw new Error('agent.systemInstruction is required when agent is enabled');
    }

    let adapter = agentOpts.adapter;
    if (!adapter) {
      if (!agentOpts.gemini) {
        throw new Error('agent.gemini is required when agent is enabled without agent.adapter');
      }
      adapter = new GeminiAdapter(agentOpts.gemini);
    }

    const historyWindowMinutes = agentOpts.historyWindowMinutes ?? 60;
    if (typeof historyWindowMinutes !== 'number' || !Number.isInteger(historyWindowMinutes) || historyWindowMinutes <= 0) {
      throw new Error(`Invalid agent.historyWindowMinutes: ${historyWindowMinutes}`);
    }

    const history = agentOpts.history ?? new InMemoryHistoryStore({ windowMinutes: historyWindowMinutes });

    const maxToolRounds = agentOpts.maxToolRounds ?? 8;
    if (typeof maxToolRounds !== 'number' || !Number.isInteger(maxToolRounds) || maxToolRounds < 1) {
      throw new Error(`Invalid agent.maxToolRounds: ${maxToolRounds}`);
    }

    const exposeTool = agentOpts.exposeTool !== false;

    const excludeTools = new Set(exposeTool ? ['agent_ask'] : []);
    excludeTools.add('session');
    if (this.name) {
      excludeTools.add(`${this.name}_session`);
      if (exposeTool) {
        excludeTools.add(`${this.name}_agent_ask`);
      }
    }

    let toolAllowlist;
    if (agentOpts.toolAllowlist !== undefined) {
      if (!Array.isArray(agentOpts.toolAllowlist)) {
        throw new Error('agent.toolAllowlist must be an array of tool names when provided');
      }
      toolAllowlist = agentOpts.toolAllowlist;
    }

    this.agent = new Agent({
      adapter,
      toolRegistry: this.toolRegistry,
      systemInstruction: agentOpts.systemInstruction,
      history,
      maxToolRounds,
      excludeTools: [...excludeTools],
      toolAllowlist,
      requireUser: authEnabled,
      logger: this.logger,
    });

    if (exposeTool) {
      this.toolRegistry.register(new AgentTool(this.agent), this.name);
      this.logger.info({ toolName: 'agent_ask' }, 'Agent MCP tool registered');
    }

    this.logger.info('Agent enabled');
  }

  /**
   * @returns {import('../agents/agent.js').Agent}
   */
  getAgent() {
    if (!this.agent) {
      throw new Error('Agent is not enabled. Set options.agent.enabled to true.');
    }
    return this.agent;
  }

  /**
   * Initialize AuthManager when auth is enabled.
   * @private
   */
  _initializeAuth() {
    const auth = this.options.auth;
    validateAuthOptions(auth);

    const { providers, enabledProviders } = normalizeAuthProviders(auth);
    this.enabledAuthProviders = enabledProviders;

    this.authManager = new AuthManager({
      providers,
      callbackUrl: auth.callbackUrl,
      jwtSecret: auth.jwtSecret,
      jwtExpiresIn: auth.jwtExpiresIn,
      sessionSecret: auth.sessionSecret,
      issuer: auth.issuer,
      resourcePath: auth.resourcePath,
      allowedUsers: auth.allowedUsers || [],
      allowedRedirectUris: auth.allowedRedirectUris || [],
      trustedRedirectHosts: auth.trustedRedirectHosts || [],
      allowAnyHttpsRedirect: auth.allowAnyHttpsRedirect === true,
      loginStateExpiresIn: auth.loginStateExpiresIn,
      onTokenIssued: auth.onTokenIssued,
      postLoginRedirectUrl: auth.postLoginRedirectUrl,
      showTokenOnSuccessPage: auth.showTokenOnSuccessPage === true,
      enableDebugEndpoint: auth.enableDebugEndpoint === true,
      sessionStore: auth.sessionStore,
      logger: this.logger
    });

  }

  /**
   * Whether authentication is enabled for this instance.
   * @returns {boolean}
   */
  isAuthEnabled() {
    return Boolean(this.authManager);
  }

  /**
   * Deactivate Bearer access token session by JWT jti.
   * @param {string} jti
   * @returns {Promise<boolean>}
   */
  revokeSession(jti) {
    if (!this.authManager) {
      throw new Error('Auth is not enabled');
    }
    return this.authManager.deactivateVerifiedSessionByJti(jti);
  }

  /**
   * Load active standalone session by library-generated session id.
   * @param {string} sessionId
   * @returns {Promise<{ user: Object, context: Record<string, string> }>}
   */
  getVerifiedSession(sessionId) {
    if (!this.authManager) {
      throw new Error('Auth is not enabled. Set options.auth.enabled to true.');
    }
    return this.authManager.getVerifiedSession(sessionId);
  }

  /**
   * Load active standalone session by host context (alias lookup).
   * @param {unknown} context
   * @returns {Promise<{ user: Object, context: Record<string, string> }>}
   */
  getVerifiedSessionByContext(context) {
    if (!this.authManager) {
      throw new Error('Auth is not enabled. Set options.auth.enabled to true.');
    }
    return this.authManager.getVerifiedSessionByContext(context);
  }

  /**
   * Remove active standalone session for host context (e.g. Telegram sign-out).
   * @param {unknown} context
   * @returns {Promise<boolean>}
   */
  deactivateVerifiedSessionByContext(context) {
    if (!this.authManager) {
      throw new Error('Auth is not enabled. Set options.auth.enabled to true.');
    }
    return this.authManager.deactivateVerifiedSessionByContext(context);
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
   * Express router for MCP OAuth authorization server (DCR, PKCE, metadata).
   * Mount at `/` when auth is enabled.
   * @param {Object} [sessionOptions] - Options passed to express-session
   * @returns {import('express').Router}
   */
  mcpOAuthRouter(sessionOptions = {}) {
    if (!this.authManager) {
      throw new Error('Auth is not enabled. Set options.auth.enabled to true.');
    }
    return this.authManager.createMcpOAuthRouter(sessionOptions);
  }

  /**
   * Combined HTTP router for MCP OAuth, IdP login, and MCP protocol.
   * Mount once on the host app (e.g. `app.use(expressMcp.httpRouter())`).
   * @param {Object} [options]
   * @param {string} [options.mcpPath='/mcp'] - Mount path for MCP OAuth, IdP login, and JSON-RPC
   * @param {Object} [options.sessionOptions] - Options passed to express-session
   * @returns {import('express').Router}
   */
  httpRouter(options = {}) {
    const mcpPath = options.mcpPath || '/mcp';

    if (!this.authManager) {
      this.logger.warn(
        { mcpPath },
        'httpRouter mounted without auth: MCP endpoints are unauthenticated'
      );
      const router = Router();
      router.use(mcpPath, this.router());
      return router;
    }

    const auth = this.options.auth;
    const allowlistInfo =
      auth.allowedUsers?.length > 0
        ? { allowedUserCount: auth.allowedUsers.length }
        : { allowlist: 'open' };

    this.logger.info(
      {
        issuer: auth.issuer,
        origin: this.authManager.origin,
        callbackUrl: auth.callbackUrl,
        resourcePath: auth.resourcePath || mcpPath,
        mcpPath,
        authPath: this.authManager.authPath,
        providers: this.enabledAuthProviders,
        ...allowlistInfo
      },
      'MCP auth enabled'
    );

    return this.authManager.createHttpRouter({
      mcpRouter: this.router(),
      mcpPath,
      sessionOptions: options.sessionOptions || {}
    });
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
   * Build an SDK McpServer with tools registered from ToolRegistry.
   * @param {{ user?: Object|null }} [context]
   * @returns {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer}
   * @private
   */
  _buildMcpServer(context = {}) {
    const serverName = this.name || '@express-mcp/express-mcp';
    const serverOptions = {
      capabilities: {
        tools: {}
      }
    };
    if (typeof this.description === 'string' && this.description.trim().length > 0) {
      serverOptions.instructions = this.description.trim();
    }

    const mcpServer = new McpServer(
      {
        name: serverName,
        version: packageVersion
      },
      serverOptions
    );

    this.toolRegistry.registerOnMcpServer(mcpServer, context);
    return mcpServer;
  }

  /**
   * Creates an Express router with MCP protocol routes
   * @returns {Router} Express router configured for MCP
   */
  router() {
    const router = Router();
    const sessions = new Map();
    const maxSessions = 1000;

    if (this.authManager) {
      for (const middleware of this.authManager.protectedMiddleware()) {
        router.use(middleware);
      }
    }

    const handlePost = async (req, res) => {
      const requestLogger = this.logger.child({
        requestId: req.body?.id || 'unknown',
        ...userLogFields(req.mcpUser)
      });

      const sessionId = req.headers['mcp-session-id'];
      let transport;
      let mcpServer;

      if (sessionId) {
        const session = sessions.get(sessionId);
        if (!session) {
          if (!res.headersSent) {
            res.status(404).json({
              jsonrpc: '2.0',
              error: { code: -32000, message: 'Session not found' },
              id: req.body?.id ?? null
            });
          }
          return;
        }
        ({ transport, mcpServer } = session);
      } else {
        let sessionEntry;
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (sid) => {
            while (sessions.size >= maxSessions) {
              const oldestId = sessions.keys().next().value;
              const oldest = sessions.get(oldestId);
              sessions.delete(oldestId);
              try {
                oldest?.transport?.close?.();
              } catch {
                // ignore close errors during eviction
              }
            }
            sessions.set(sid, sessionEntry);
          }
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            sessions.delete(transport.sessionId);
          }
        };
        transport.onerror = (error) => {
          requestLogger.error({ error: error.message, stack: error.stack }, 'MCP transport error');
        };
        mcpServer = this._buildMcpServer({ user: req.mcpUser ?? null });
        sessionEntry = { transport, mcpServer };
        await mcpServer.connect(transport);
      }

      try {
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        requestLogger.error({ error: error.message, stack: error.stack }, 'MCP request failed');
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: req.body?.id ?? null
          });
        }
      }
    };

    const handleSessionRequest = async (req, res) => {
      const sessionId = req.headers['mcp-session-id'];
      if (!sessionId) {
        if (!res.headersSent) {
          res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Mcp-Session-Id header is required' }
          });
        }
        return;
      }

      const session = sessions.get(sessionId);
      if (!session) {
        if (!res.headersSent) {
          res.status(404).end();
        }
        return;
      }

      try {
        await session.transport.handleRequest(req, res);
      } catch (error) {
        this.logger.error({ error: error.message, stack: error.stack }, 'MCP session request failed');
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' }
          });
        }
      }
    };

    router.post('/', handlePost);
    router.get('/', handleSessionRequest);
    router.delete('/', handleSessionRequest);

    return router;
  }
}