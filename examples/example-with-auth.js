#!/usr/bin/env node

/**
 * MCP example with optional OAuth SSO (GitHub or Google).
 * Copy .env.example to .env and fill in credentials before running.
 */

import express from 'express';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { ExpressMcp, BaseTool } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnvFile(path) {
  if (!existsSync(path)) {
    return;
  }
  const content = readFileSync(path, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(join(__dirname, '../.env'));
loadEnvFile(join(__dirname, '.env'));

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

async function startAuthExample() {
  const port = process.argv[2] ? parseInt(process.argv[2], 10) : 3000;
  const provider = process.env.OAUTH_PROVIDER || 'github';
  const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;

  const required = [
    'OAUTH_CLIENT_ID',
    'OAUTH_CLIENT_SECRET',
    'JWT_SECRET',
    'SESSION_SECRET'
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`Missing required env vars: ${missing.join(', ')}`);
    console.error('Copy examples/.env.example to .env and configure OAuth credentials.');
    process.exit(1);
  }

  const expressMcp = new ExpressMcp({
    name: 'example-mcp-auth',
    description: 'Example MCP server with OAuth SSO',
    enableKnowledgeBase: true,
    loggerOptions: { enabled: true, level: 'info' },
    auth: {
      enabled: true,
      provider,
      clientId: process.env.OAUTH_CLIENT_ID,
      clientSecret: process.env.OAUTH_CLIENT_SECRET,
      callbackUrl: process.env.OAUTH_CALLBACK_URL || `${baseUrl}/auth/callback`,
      jwtSecret: process.env.JWT_SECRET,
      jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
      sessionSecret: process.env.SESSION_SECRET
    }
  });

  expressMcp.registerTool(new GreetingTool());

  const app = express();
  app.use(express.json());

  app.get('/', (req, res) => {
    const label = provider === 'google' ? 'Google' : 'GitHub';
    res.send(`<!DOCTYPE html>
<html>
<head><title>MCP Auth Example</title></head>
<body>
  <h1>express_mcp OAuth example</h1>
  <p><a href="/auth/login">Login with ${label}</a></p>
  <p>MCP endpoint: <code>POST ${baseUrl}/mcp</code> (requires Bearer token after login)</p>
</body>
</html>`);
  });

  app.use('/auth', expressMcp.authRouter());
  app.use('/mcp', expressMcp.router());

  app.listen(port, () => {
    console.log(`Server: ${baseUrl}`);
    console.log(`Login: ${baseUrl}/auth/login`);
    console.log(`MCP:   ${baseUrl}/mcp`);
    console.log(`Provider: ${provider}`);
  });
}

startAuthExample().catch((err) => {
  console.error(err);
  process.exit(1);
});
