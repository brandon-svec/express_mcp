# Express MCP

Mount the [Model Context Protocol](https://modelcontextprotocol.io/) on any Express app so AI clients (Cursor, Claude, and other MCP-compatible tools) can agentically interact with your pre-existing API server without standing up a separate MCP server.

Register tools against your existing business logic, optionally add OAuth SSO (GitHub/Google), a FlexSearch knowledge base, and an in-process LLM agent. This package ships **routers and middleware only**; your host Express app remains in control of TLS, CORS, body parsers, and rate limits.

## Features

- **Drop-in MCP on Express** — Mount JSON-RPC MCP endpoints on the app you already run
- **Your tools, your data** — Register custom tools that wrap existing APIs and services
- **Optional OAuth SSO** — GitHub/Google login, Bearer JWTs, PKCE, and Dynamic Client Registration for MCP clients
- **Built-in knowledge base** — Full-text document search via FlexSearch (`kb_search`, `kb_list`, `kb_get`)
- **Tool name prefixing** — Avoid collisions when multiple MCP services share a client
- **Optional agent** — Gemini-backed `agent_ask` that can call your registered tools

## Requirements

- **Node.js**: Version 20 or higher
- **Express**: Version ^4.18.0 || ^5.0.0 (peer dependency)

## Installation

```bash
npm install @brandon-svec/express_mcp express
```

Express is a peer dependency. Ensure you have Express ^4.18.0 or ^5.0.0 installed in your project.

## Quick Start

```javascript
import express from 'express';
import { ExpressMcp, BaseTool } from '@brandon-svec/express_mcp';

const app = express();
app.use(express.json());

const expressMcp = new ExpressMcp();

// Extend BaseTool: name + description for tools/list, inputSchema for args, execute for the handler
class GreetingTool extends BaseTool {
  constructor() {
    super('greeting', 'A simple greeting tool'); // Tool name and description for your agent to know when to use the tool
    this.inputSchema = {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name to greet' } // Good descriptions improve agent operations
      },
      required: ['name']
    };
  }

  async execute(params) {
    return `Hello, ${params.name}!`;
  }
}

expressMcp.registerTool(new GreetingTool());
app.use('/mcp', expressMcp.router());

app.listen(3000, () => {
  console.log('MCP endpoint: http://localhost:3000/mcp');
});
```

When auth is enabled, `execute` can take a second `context` argument and read `context.user` (`sub`, `login`, `email`, `provider`).

## Knowledge Base

Express MCP includes a FlexSearch-backed knowledge base with three MCP tools: `kb_search`, `kb_list`, and `kb_get`. When you pass a `name` to `ExpressMcp`, those tools are prefixed (e.g. `my-service_kb_search`) so multiple MCP services can coexist in one client.

```javascript
import { ExpressMcp } from '@brandon-svec/express_mcp';

const expressMcp = new ExpressMcp({
  name: 'my-api-server',
  description: 'Internal API documentation and guides'
});

await expressMcp.addDocument('getting-started', {
  title: 'Getting Started Guide',
  content: 'This guide will help you get started with our API...',
  tags: ['guide', 'tutorial', 'beginner'],
  metadata: { category: 'documentation' }
});
```

### Document management

```javascript
await expressMcp.addDocument('doc-id', {
  title: 'Document Title',
  content: 'Document content goes here...',
  tags: ['tag1', 'tag2'],
  metadata: { key: 'value' }
});

await expressMcp.updateDocument('doc-id', {
  title: 'Updated Title',
  content: 'Updated content...'
});

await expressMcp.removeDocument('doc-id');

const stats = await expressMcp.getKnowledgeBaseStats();
// { totalDocuments, totalWords, uniqueTags, tags }
```

### Built-in MCP tools

| Tool | Purpose |
|------|---------|
| `kb_search` / `{name}_kb_search` | Full-text search (`query`, optional `limit`, `includeContent`) |
| `kb_list` / `{name}_kb_list` | List documents (optional `tag`, `limit`) |
| `kb_get` / `{name}_kb_get` | Fetch one document by `id` |

Tool descriptions update as you add documents: available tags and your custom `description` are included so AI clients know what is searchable.

Disable the knowledge base with `enableKnowledgeBase: false`.

## Authentication (OAuth SSO)

Optional GitHub and/or Google login. Users receive a JWT; MCP clients send `Authorization: Bearer <token>` on each request.

See **[docs/AUTH.md](docs/AUTH.md)** for the full config reference, env vars, session stores, and OAuth provider setup.

```javascript
import { ExpressMcp } from '@brandon-svec/express_mcp';

const expressMcp = new ExpressMcp({
  name: 'my-service',
  auth: {
    enabled: true,
    baseUrl: 'https://my-host.example.com',
    callbackUrl: 'https://my-host.example.com/mcp/auth/callback',
    jwtSecret: process.env.JWT_SECRET,
    sessionSecret: process.env.SESSION_SECRET,
    jwtExpiresIn: '7d',
    allowedUsers: [],
    providers: {
      google: { clientId: '...', clientSecret: '...' },
      github: { clientId: '...', clientSecret: '...' }
    }
  }
});

app.use(expressMcp.httpRouter()); // OAuth + MCP on one router
```

Or build auth from environment variables:

```javascript
import { buildAuthOptionsFromEnv } from '@brandon-svec/express_mcp';

const auth = buildAuthOptionsFromEnv({ baseUrl: 'http://localhost:3000' });
if (auth) {
  const expressMcp = new ExpressMcp({ name: 'my-service', auth });
}
```

Env vars: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `JWT_SECRET`, `SESSION_SECRET`. Optional: `JWT_EXPIRES_IN`, `AUTH_ALLOWED_USERS`, `OAUTH_CALLBACK_URL`.

## Optional AI Agent

Enable an in-process Gemini agent that can call your registered tools (exposed as `agent_ask` by default):

```javascript
const expressMcp = new ExpressMcp({
  name: 'my-service',
  auth: { /* auth config */ },
  agent: {
    enabled: true,
    systemInstruction: 'You help users with this service.',
    gemini: {
      apiKey: process.env.GEMINI_API_KEY,
      model: 'gemini-2.0-flash'
    }
  }
});
```

Requires auth by default (`agent.allowUnauthenticated: true` to opt out). `@google/genai` is an optional peer dependency.

## API Reference

### `ExpressMcp`

```javascript
const expressMcp = new ExpressMcp({
  name: 'my-service',           // Instance name (tool prefixing + logger name)
  description: 'My API docs',   // Appended to knowledge base tool descriptions
  enableKnowledgeBase: true,    // Register kb_* tools (default: true)
  loggerOptions: {
    enabled: true,
    level: 'info',
    name: 'express-mcp'
  },
  logger: customLoggerInstance, // Optional; overrides loggerOptions
  auth: { /* see docs/AUTH.md */ },
  agent: { /* optional; see above */ }
});
```

#### Tool name prefixing

When `name` is set, knowledge base tools become `{name}_kb_search`, `{name}_kb_list`, `{name}_kb_get`. Use a unique name per service so clients like Cursor can route calls correctly when multiple MCP servers are connected.

Custom tools from `registerTool()` are **not** prefixed by default. To prefix a custom tool:

```javascript
expressMcp.toolRegistry.register(new MyTool(), 'my-service');
```

Management APIs (`hasRegisteredTool`, `unregisterTool`, etc.) accept the **original** tool name.

#### Tool management

- `registerTool(tool)` — Register a tool (custom tools are not prefixed)
- `unregisterTool(name)` — Unregister by original name
- `hasRegisteredTool(name)` / `getRegisteredTool(name)`
- `getRegisteredToolCount()` / `clearRegisteredTools()`
- `router()` — MCP-only Express router
- `httpRouter()` — OAuth + MCP when auth is enabled

#### Knowledge base

- `addDocument(id, document)` / `updateDocument(id, updates)` / `removeDocument(id)`
- `getKnowledgeBaseStats()`

## MCP Protocol Support

This module implements:

- **initialize** — Initialize MCP session
- **notifications/initialized** — Confirm initialization
- **tools/list** — List available tools
- **tools/call** — Execute a tool with parameters

Responses follow JSON-RPC 2.0 with proper error handling.

## Learn more

| Topic | Document |
|-------|----------|
| OAuth SSO, sessions, DCR, agent auth | [docs/AUTH.md](docs/AUTH.md) |
| Host security (TLS, CORS, rate limits) | [SECURITY.md](SECURITY.md) |
| Local development, tests, releasing | [CONTRIBUTING.md](CONTRIBUTING.md) |

## License

MIT
