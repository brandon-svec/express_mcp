#!/usr/bin/env node

/**
 * MCP example with optional OAuth SSO (GitHub and/or Google).
 * Copy examples/.env.example to examples/.env and fill in credentials before running.
 */

import express from 'express';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  ExpressMcp,
  BaseTool,
  buildAuthOptionsFromEnv,
  isOAuthConfigured
} from '../src/index.js';
import { loadEnvFile } from '../src/loadEnvFile.js';
import { WhoAmITool } from '../src/tools/whoami.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
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
  const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;

  if (!isOAuthConfigured()) {
    console.error(
      'Missing OAuth config. Set GITHUB_CLIENT_* and/or GOOGLE_CLIENT_*, plus JWT_SECRET and SESSION_SECRET.'
    );
    console.error('Copy examples/.env.example to examples/.env and configure credentials.');
    process.exit(1);
  }

  const authOptions = buildAuthOptionsFromEnv({ baseUrl });
  const callbackUrl = authOptions.callbackUrl;

  const expressMcp = new ExpressMcp({
    name: 'example-mcp-auth',
    description: 'Example MCP server with OAuth SSO',
    enableKnowledgeBase: true,
    loggerOptions: { enabled: true, level: 'info' },
    auth: { ...authOptions, enabled: true }
  });

  const enabledProviders = expressMcp.enabledAuthProviders || [];

  expressMcp.registerTool(new GreetingTool());
  expressMcp.registerTool(new WhoAmITool());

  const app = express();
  app.use(express.json());

  const providerLinks = enabledProviders
    .map((name) => {
      const label = name === 'google' ? 'Google' : 'GitHub';
      return `<li><a href="/auth/login/${name}">Login with ${label}</a></li>`;
    })
    .join('\n');

  app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html>
<head><title>MCP Auth Example</title></head>
<body>
  <h1>express_mcp OAuth example</h1>
  <p><a href="/auth/login">Sign in</a></p>
  <ul>${providerLinks}</ul>
  <p>MCP endpoint: <code>POST ${baseUrl}/mcp</code> (requires Bearer token after login)</p>
  <p><strong>OAuth redirect URI</strong> (register on each provider app):</p>
  <pre style="background:#f4f4f4;padding:0.5em;">${callbackUrl}</pre>
  <p><a href="/auth/debug">OAuth debug JSON</a></p>
</body>
</html>`);
  });

  app.use(expressMcp.httpRouter());

  app.listen(port, () => {
    console.log(`Server: ${baseUrl}`);
    console.log(`Login: ${baseUrl}/auth/login`);
    console.log(`MCP:   ${baseUrl}/mcp`);
    console.log(`Providers: ${enabledProviders.join(', ')}`);
  });
}

startAuthExample().catch((err) => {
  console.error(err);
  process.exit(1);
});
