#!/usr/bin/env node

/**
 * Production server for Heroku and other hosts.
 * Set config vars (see .env.example) then: npm start
 */

import express from 'express';
import { ExpressMcp, BaseTool } from './src/index.js';

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

function isAuthConfigured() {
  const required = [
    'OAUTH_CLIENT_ID',
    'OAUTH_CLIENT_SECRET',
    'JWT_SECRET',
    'SESSION_SECRET'
  ];
  return required.every((key) => Boolean(process.env[key]));
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
      const info = getRuntimeInfo();
      return {
        service: 'mcp-test-express',
        authEnabled: info.authEnabled,
        baseUrl: info.baseUrl,
        provider: info.provider
      };
    }
  };
}

async function startServer() {
  const baseUrl = getBaseUrl();
  const provider = process.env.OAUTH_PROVIDER || 'github';
  const authEnabled =
    process.env.AUTH_ENABLED !== 'false' && isAuthConfigured();

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
    mcpOptions.auth = {
      enabled: true,
      provider,
      clientId: process.env.OAUTH_CLIENT_ID,
      clientSecret: process.env.OAUTH_CLIENT_SECRET,
      callbackUrl:
        process.env.OAUTH_CALLBACK_URL || `${baseUrl}/auth/callback`,
      jwtSecret: process.env.JWT_SECRET,
      jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
      sessionSecret: process.env.SESSION_SECRET
    };
  } else {
    console.warn(
      'Auth disabled: set OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, JWT_SECRET, SESSION_SECRET to enable OAuth.'
    );
  }

  const runtimeInfo = () => ({
    authEnabled,
    baseUrl,
    provider
  });

  const expressMcp = new ExpressMcp(mcpOptions);
  expressMcp.registerTool(new GreetingTool());
  expressMcp.registerTool(new (createStatusTool(runtimeInfo))());

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
      mcpPath: '/mcp'
    });
  });

  app.get('/', (req, res) => {
    const loginLine = authEnabled
      ? `<p><a href="/auth/login">Login with ${provider === 'google' ? 'Google' : 'GitHub'}</a></p>`
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
    }
  });
}

startServer().catch((err) => {
  console.error(err);
  process.exit(1);
});
