#!/usr/bin/env node

/**
 * Production server for Heroku and other hosts.
 * Set config vars (see .env.example) then: npm start
 */

import express from 'express';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { ExpressMcp, BaseTool, buildAuthOptionsFromEnv, isOAuthConfigured } from './src/index.js';
import { loadEnvFile } from './src/loadEnvFile.js';
import { WhoAmITool } from './src/tools/whoami.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnvFile(join(__dirname, '.env'));

const port = Number(process.env.PORT) || 3000;

function getBaseUrl() {
  if (process.env.BASE_URL) {
    return process.env.BASE_URL.replace(/\/$/, '');
  }
  if (process.env.HEROKU_APP_NAME) {
    return `https://${process.env.HEROKU_APP_NAME}.herokuapp.com`;
  }
  return `http://localhost:${port}`;
}

class GreetingTool extends BaseTool {
  constructor() {
    super('hello', 'Says hello with an optional name', {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name to greet' }
      }
    });
  }

  async execute(args) {
    const name = args?.name || 'World';
    return `Hello, ${name}!`;
  }
}

function createStatusTool(getRuntimeInfo) {
  return class StatusTool extends BaseTool {
    constructor() {
      super('status', 'Returns server status and whether authentication is enabled');
    }

    async execute() {
      return getRuntimeInfo();
    }
  };
}

async function startServer() {
  const baseUrl = getBaseUrl();
  const authOptions = buildAuthOptionsFromEnv({ baseUrl });
  const authEnabled = Boolean(authOptions);

  const mcpOptions = {
    name: process.env.MCP_SERVER_NAME || 'mcp-test-express',
    description:
      process.env.MCP_DESCRIPTION ||
      'MCP test server on Heroku with optional OAuth SSO',
    enableKnowledgeBase: process.env.ENABLE_KB !== 'false',
    loggerOptions: {
      enabled: process.env.LOG_ENABLED !== 'false',
      level: process.env.LOG_LEVEL || 'info'
    }
  };

  if (authEnabled) {
    mcpOptions.auth = { ...authOptions, enabled: true };
  } else if (process.env.AUTH_ENABLED !== 'false' && !isOAuthConfigured()) {
    console.warn(
      'Auth disabled: set GITHUB_* and/or GOOGLE_* OAuth credentials, JWT_SECRET, SESSION_SECRET.'
    );
  }

  const expressMcp = new ExpressMcp(mcpOptions);
  const enabledProviders = expressMcp.enabledAuthProviders || [];

  const runtimeInfo = () => ({
    service: 'mcp-test-express',
    authEnabled,
    baseUrl,
    providers: enabledProviders
  });

  expressMcp.registerTool(new GreetingTool());
  expressMcp.registerTool(new (createStatusTool(runtimeInfo))());
  if (authEnabled) {
    expressMcp.registerTool(new WhoAmITool());
  }

  if (mcpOptions.enableKnowledgeBase) {
    await expressMcp.addDocument('welcome', {
      title: 'Welcome',
      content:
        'MCP server deployed on Heroku. Use /auth/login to sign in, then connect Cursor with a Bearer token.',
      tags: ['heroku', 'welcome']
    });
  }

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());

  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      authEnabled,
      providers: enabledProviders,
      mcpPath: '/mcp'
    });
  });

  app.get('/', (req, res) => {
    const loginLine = authEnabled
      ? '<p><a href="/auth/login">Sign in</a> (GitHub and/or Google)</p>'
      : '<p>OAuth not configured. Set Heroku config vars to enable login.</p>';

    res.send(`<!DOCTYPE html>
<html>
<head><title>MCP Test Express</title></head>
<body>
  <h1>mcp-test-express</h1>
  ${loginLine}
  <p>MCP endpoint: <code>POST ${baseUrl}/mcp</code></p>
  <p>Health: <a href="/health">/health</a></p>
</body>
</html>`);
  });

  if (authEnabled) {
    app.use('/auth', expressMcp.authRouter());
  }

  app.use('/mcp', expressMcp.router());

  app.listen(port, '0.0.0.0', () => {
    console.log(`Listening on 0.0.0.0:${port}`);
    console.log(`Base URL: ${baseUrl}`);
    console.log(`MCP: ${baseUrl}/mcp`);
    if (authEnabled) {
      console.log(`Login: ${baseUrl}/auth/login`);
      console.log(`Providers: ${enabledProviders.join(', ')}`);
    }
  });
}

startServer().catch((err) => {
  console.error(err);
  process.exit(1);
});
