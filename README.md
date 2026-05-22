# Express MCP Module

A Node.js module that provides Express Router and middleware for integrating MCP (Model Context Protocol) functionality into existing Express servers. This module allows AI assistants to interact with your API tools through the standardized MCP protocol.

## Features

- **Express Router Integration**: Easy integration into existing Express applications
- **Tool Registry**: Manage and register custom tools that implement the MCP protocol
- **Built-in Knowledge Base**: Full-text search and document management powered by FlexSearch
- **Tool Name Prefixing**: Automatic prefixing to prevent name collisions in multi-service MCP deployments
- **JSON-RPC 2.0**: Full MCP protocol support with proper error handling
- **Generic Framework**: Decoupled from specific APIs - bring your own tools and documentation
- **TypeScript Support**: ES Module with full type definitions

## Requirements

- **Node.js**: Version 20 or higher
- **Express**: Version ^4.18.0 (peer dependency)

## Installation

### From NPM Registry

```bash
npm install @express-mcp/express-mcp express
```

**Note**: Express is a peer dependency. Ensure you have Express ^4.18.0 installed in your project.

### Local Development

```bash
# Clone the repository
git clone git@git.soma.example.com:express-mcp/express-mcp
cd express-mcp

# Install dependencies
npm install

# Run tests
npm test

# Run example
npm run example
```

## Quick Start

```javascript
import express from 'express';
import { ExpressMcp, BaseTool } from '@express-mcp/express-mcp';

// Create Express app
const app = express();
app.use(express.json());

// Create ExpressMcp instance
const expressMcp = new ExpressMcp();

// Create a custom tool
class GreetingTool extends BaseTool {
  constructor() {
    super('greeting', 'A simple greeting tool');
    this.inputSchema = {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name to greet' }
      },
      required: ['name']
    };
  }

  async execute(params) {
    return `Hello, ${params.name}!`;
  }
}

// Register the tool
expressMcp.registerTool(new GreetingTool());

// Add MCP router to your Express app
app.use('/mcp', expressMcp.router());

// Start server
app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
  console.log('MCP endpoint: http://localhost:3000/mcp');
});
```

## Authentication (OAuth SSO)

Optional GitHub and/or Google login. Users receive a JWT; MCP clients send `Authorization: Bearer <token>` on each request.

### Multi-provider (GitHub + Google)

```javascript
import { ExpressMcp } from '@brandon-svec/express_mcp';

const expressMcp = new ExpressMcp({
  auth: {
    enabled: true,
    callbackUrl: 'http://localhost:3000/auth/callback',
    jwtSecret: process.env.JWT_SECRET,
    sessionSecret: process.env.SESSION_SECRET,
    allowedUsers: ['user@example.com', 'github-login'], // optional
    providers: {
      github: { clientId: '...', clientSecret: '...' },
      google: { clientId: '...', clientSecret: '...' }
    }
  }
});

app.use('/auth', expressMcp.authRouter());
app.use('/mcp', expressMcp.router());
```

Routes:

- `GET /auth/login` — provider picker (or auto-redirect if only one)
- `GET /auth/login/github` / `GET /auth/login/google`
- `GET /auth/callback` — shared callback URL (register on both OAuth apps)
- `GET /auth/me` — current user (Bearer token)

### Single provider (backward compatible)

```javascript
auth: {
  enabled: true,
  provider: 'google',
  clientId: '...',
  clientSecret: '...',
  callbackUrl: 'http://localhost:3000/auth/callback',
  jwtSecret: '...',
  sessionSecret: '...'
}
```

### Environment helpers (host apps)

```javascript
import { buildAuthOptionsFromEnv } from '@brandon-svec/express_mcp';

const auth = buildAuthOptionsFromEnv({ baseUrl: 'http://localhost:3000' });
if (auth) {
  const expressMcp = new ExpressMcp({ auth: { ...auth, enabled: true } });
}
```

Env vars for multi-provider: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, plus `JWT_SECRET`, `SESSION_SECRET`. Optional allowlist: `AUTH_ALLOWED_USERS=email1,login2`.

Tool handlers receive `context.user` (`sub`, `login`, `email`, `provider`). MCP logs include user identity on each request (not the token).

## API Reference

### ExpressMcp Class

The main class for managing MCP functionality:

```javascript
import { ExpressMcp } from '@express-mcp/express-mcp';

const expressMcp = new ExpressMcp();
```

#### Constructor Options

```javascript
const expressMcp = new ExpressMcp({
  // Basic configuration
  name: 'my-service',           // Instance name (used for tool prefixing and logger name)
  description: 'My API docs',   // Custom description for knowledge base tools
  enableKnowledgeBase: true,    // Enable/disable knowledge base tools (default: true)
  
  // Logging configuration
  loggerOptions: {
    enabled: true,              // Enable/disable logging (default: true)
    level: 'info',             // Log level (default: 'info')
    name: 'express-mcp'          // Logger name (overridden by instance name if provided)
  },
  
  // Custom logger (overrides loggerOptions)
  logger: customLoggerInstance  // Provide your own logger instance
});
```

**New Features:**

- **Tool Name Prefixing**: When you provide a `name` for your ExpressMcp instance, all knowledge base tools (`kb_search`, `kb_list`, `kb_get`) are automatically prefixed with that name (e.g., `my-service_kb_search`)
- **Dynamic Knowledge Base Tool Descriptions**: The `description` parameter customizes the knowledge base tool descriptions and is automatically combined with available document tags to create contextual, informative tool descriptions

**Logging Options:**
- **`loggerOptions.enabled`**: Enable or disable logging (default: `true`)
- **`loggerOptions.level`**: Set log level (`'trace'`, `'debug'`, `'info'`, `'warn'`, `'error'`, `'fatal'`)
- **`loggerOptions.name`**: Logger name (automatically set to instance `name` if provided)
- **`logger`**: Provide a custom logger instance (must have `info`, `warn`, `error`, `debug` methods)

**Examples:**

```javascript
// Default configuration (no prefixing)
const expressMcp = new ExpressMcp();
// KB tools: kb_search, kb_list, kb_get

// With instance name (enables tool prefixing)
const expressMcp = new ExpressMcp({
  name: 'my-api-service'
});
// KB tools: my-api-service_kb_search, my-api-service_kb_list, my-api-service_kb_get

// With custom description for knowledge base tools
const expressMcp = new ExpressMcp({
  name: 'docs-api',
  description: 'API documentation and guides'
});
// KB tools will be prefixed AND show: "Search documents in the knowledge base. Available tags: api, guide, tutorial. API documentation and guides"

// Complete configuration
const expressMcp = new ExpressMcp({
  name: 'api-service',
  description: 'Internal API documentation',
  enableKnowledgeBase: true,
  loggerOptions: {
    enabled: true,
    level: 'debug'
  }
});

// Disable logging
const expressMcp = new ExpressMcp({
  loggerOptions: { enabled: false }
});

// Use custom logger
import winston from 'winston';
const customLogger = winston.createLogger({...});

const expressMcp = new ExpressMcp({
  name: 'support-kb',
  logger: customLogger,
  description: 'Corporate knowledge base'
});
```

#### Tool Name Prefixing

When you provide a `name` to your ExpressMcp instance, the knowledge base tools are automatically prefixed with that name to avoid conflicts when multiple MCP services are used together.

> **⚠️ When to Use Prefixes**: This feature is essential when running multiple MCP servers that may have tools with the same names (like `search`, `list`, `query`, etc.). Without prefixing, [Cursor's MCP client cannot properly route tool calls](https://forum.cursor.com/t/mcp-tools-name-collision-causing-cross-service-tool-call-failures/70946/4) to the correct server, causing cross-service tool call failures. Always use a unique `name` for each ExpressMcp instance in multi-service deployments.

**How it works:**
- **Without name**: Tools are `kb_search`, `kb_list`, `kb_get`
- **With name**: Tools become `{name}_kb_search`, `{name}_kb_list`, `{name}_kb_get`
- **Tool lookup**: You can still find tools using their original names through ExpressMcp methods
- **Custom tools**: Custom tools registered via `registerTool()` are NOT prefixed by default

**Examples:**
```javascript
// Service A
const serviceA = new ExpressMcp({ name: 'docs' });
// Creates: docs_kb_search, docs_kb_list, docs_kb_get

// Service B  
const serviceB = new ExpressMcp({ name: 'support' });
// Creates: support_kb_search, support_kb_list, support_kb_get

// Both can coexist without naming conflicts!
// Without prefixes, both would have 'kb_search' causing routing failures in Cursor

// You can still use original names for management:
serviceA.hasRegisteredTool('kb_search'); // true
serviceA.unregisterTool('kb_search');    // works with original name
```

**Multi-Service Deployment Best Practices:**

```javascript
// ❌ DON'T: This causes tool name collisions in Cursor
const apiDocs = new ExpressMcp(); // kb_search, kb_list, kb_get
const userGuides = new ExpressMcp(); // kb_search, kb_list, kb_get (CONFLICT!)

// ✅ DO: Use unique names to avoid collisions
const apiDocs = new ExpressMcp({ name: 'api-docs' }); // api-docs_kb_search, api-docs_kb_list, api-docs_kb_get
const userGuides = new ExpressMcp({ name: 'user-guides' }); // user-guides_kb_search, user-guides_kb_list, user-guides_kb_get
```

**Advanced prefix control:**
```javascript
// For custom tools, you can control prefixing via direct registry access
const expressMcp = new ExpressMcp({ name: 'my-service' });

// Custom tool without prefix (default)
expressMcp.registerTool(new MyTool());

// Custom tool with prefix (direct registry access)
expressMcp.toolRegistry.register(new MyTool(), 'my-service');
```

#### Tool Management Methods

- `registerTool(tool)` - Register a tool instance (custom tools are not prefixed)
- `unregisterTool(name)` - Unregister a tool by name (use original name)
- `hasRegisteredTool(name)` - Check if a tool is registered (use original name)
- `getRegisteredTool(name)` - Get a registered tool by name (use original name)
- `getRegisteredToolCount()` - Get count of registered tools
- `clearRegisteredTools()` - Clear all registered tools
- `router()` - Get Express Router instance for MCP endpoints

#### Knowledge Base Methods

- `addDocument(id, document)` - Add a document to the knowledge base
- `updateDocument(id, updates)` - Update an existing document
- `removeDocument(id)` - Remove a document from the knowledge base
- `getKnowledgeBaseStats()` - Get knowledge base statistics

### BaseTool Class

Abstract base class for creating MCP tools:

```javascript
import { BaseTool } from '@express-mcp/express-mcp';

class MyTool extends BaseTool {
  constructor() {
    super('my-tool', 'Description of my tool');
    this.inputSchema = {
      type: 'object',
      properties: {
        param: { type: 'string' }
      }
    };
  }

  async execute(params) {
    // Tool implementation
    return 'Tool result';
  }
}
```

## Knowledge Base

Express MCP includes a built-in knowledge base system powered by FlexSearch that allows you to store, index, and search documents. The knowledge base comes with three pre-built MCP tools: `kb_search`, `kb_list`, and `kb_get`.

### Quick Start with Knowledge Base

```javascript
import { ExpressMcp } from '@express-mcp/express-mcp';

// Create ExpressMcp instance with custom description
const expressMcp = new ExpressMcp({
  name: 'my-api-server',
  description: 'Internal API documentation and guides'
});

// Add documents to the knowledge base
await expressMcp.addDocument('getting-started', {
  title: 'Getting Started Guide',
  content: 'This guide will help you get started with our API...',
  tags: ['guide', 'tutorial', 'beginner'],
  metadata: {
    category: 'documentation',
    author: 'API Team'
  }
});

await expressMcp.addDocument('api-reference', {
  title: 'API Reference',
  content: 'Complete API documentation for all endpoints...',
  tags: ['reference', 'api', 'endpoints'],
  metadata: {
    category: 'documentation',
    version: '2.0'
  }
});

// Knowledge base tools now show dynamic descriptions with available tags
// Example: "Search documents in the knowledge base. Available tags: guide, tutorial, beginner, reference, api, endpoints. Internal API documentation and guides"
```

### Configuration Options

```javascript
// Enable knowledge base with custom description (default: true)
const expressMcp = new ExpressMcp({
  enableKnowledgeBase: true,
  description: 'Corporate knowledge management system'
});

// Disable knowledge base tools
const expressMcp = new ExpressMcp({
  enableKnowledgeBase: false
});

// Knowledge base with dynamic descriptions
const expressMcp = new ExpressMcp({
  name: 'support-kb',
  description: 'Customer support documentation',
  enableKnowledgeBase: true
});
// After adding documents with tags, tools will display:
// "Search documents in the knowledge base. Available tags: [dynamic list]. Customer support documentation"
```

### Knowledge Base API

#### Document Management

```javascript
// Add a document
const result = await expressMcp.addDocument('doc-id', {
  title: 'Document Title',
  content: 'Document content goes here...',
  tags: ['tag1', 'tag2'],           // Optional
  metadata: { key: 'value' }        // Optional
});

// Update a document
await expressMcp.updateDocument('doc-id', {
  title: 'Updated Title',
  content: 'Updated content...'
});

// Remove a document
await expressMcp.removeDocument('doc-id');

// Get statistics
const stats = await expressMcp.getKnowledgeBaseStats();
console.log(stats);
// {
//   totalDocuments: 5,
//   totalWords: 1234,
//   uniqueTags: 8,
//   tags: ['guide', 'api', 'tutorial', ...]
// }
```

### Dynamic Tool Descriptions

**New Feature:** Knowledge base tools now automatically update their descriptions based on the documents you add. This provides context-aware descriptions that help AI assistants understand what's available in your knowledge base.

**How it works:**
1. Tool descriptions start with a base description (e.g., "Search documents in the knowledge base")
2. As you add documents with tags, the available tags are automatically included in the description
3. Your custom description (if provided) is appended to give additional context
4. Descriptions update in real-time as documents are added, updated, or removed

**Example progression:**
```javascript
// Initially: "Search documents in the knowledge base"

// After adding documents with tags:
// "Search documents in the knowledge base. Available tags: api, guide, tutorial, troubleshooting. API documentation server"

// With many tags (automatically truncated):
// "Search documents in the knowledge base. Available tags: api, auth, guide, tutorial, security, admin, config, deploy, monitor, debug and 5 more. API documentation server"
```

This helps AI assistants understand what kind of content is available and how to use the knowledge base effectively.

### Built-in MCP Tools

When knowledge base is enabled, three tools are automatically registered with dynamic descriptions. If you provide a `name` for your ExpressMcp instance, these tools will be prefixed (e.g., `my-service_kb_search`).

#### 1. `kb_search` (or `{name}_kb_search`) - Search Documents

Search through documents using full-text search with FlexSearch.

**Parameters:**
- `query` (string, required): Search terms
- `limit` (number, optional): Maximum results (default: 10)
- `includeContent` (boolean, optional): Include full content (default: false)

**Example MCP call:**
```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "kb_search",
    "arguments": {
      "query": "getting started API",
      "limit": 5,
      "includeContent": true
    }
  },
  "id": 1
}
```

**With prefixed name (if ExpressMcp was created with `name: 'docs'`):**
```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "docs_kb_search",
    "arguments": {
      "query": "getting started API",
      "limit": 5,
      "includeContent": true
    }
  },
  "id": 1
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "result": {
    "content": [{
      "type": "text",
      "text": "{\n  \"query\": \"getting started API\",\n  \"resultsCount\": 2,\n  \"results\": [\n    {\n      \"id\": \"getting-started\",\n      \"title\": \"Getting Started Guide\",\n      \"relevanceScore\": 2.5,\n      \"excerpt\": \"This guide will help you get started with our API...\",\n      \"tags\": [\"guide\", \"tutorial\", \"beginner\"],\n      \"content\": \"This guide will help you get started with our API...\"\n    }\n  ],\n  \"stats\": {\n    \"totalDocuments\": 5,\n    \"totalWords\": 1234\n  }\n}"
    }]
  },
  "id": 1
}
```

#### 2. `kb_list` (or `{name}_kb_list`) - List Documents

List all documents or filter by tag.

**Parameters:**
- `tag` (string, optional): Filter by tag
- `limit` (number, optional): Maximum results (default: 10)

**Example:**
```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "kb_list",
    "arguments": {
      "tag": "guide",
      "limit": 5
    }
  },
  "id": 1
}
```

#### 3. `kb_get` (or `{name}_kb_get`) - Get Specific Document

Retrieve a document by its ID.

**Parameters:**
- `id` (string, required): Document ID

**Example:**
```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "kb_get",
    "arguments": {
      "id": "getting-started"
    }
  },
  "id": 1
}
```

### Document Schema

Documents stored in the knowledge base follow this schema:

```typescript
interface Document {
  id: string;                    // Unique identifier
  title: string;                 // Document title (required)
  content: string;               // Document content (required)
  tags?: string[];               // Optional tags for categorization
  metadata?: Record<string, any>; // Optional metadata
  createdAt: Date;               // Automatically set
  updatedAt: Date;               // Automatically updated
}
```

### Search Features

The knowledge base uses FlexSearch for powerful search capabilities:

- **Full-text search**: Search through titles and content
- **Tag-based filtering**: Filter documents by tags
- **Relevance scoring**: Results ranked by relevance
- **Excerpt generation**: Automatic excerpt generation with search term highlighting
- **Fuzzy matching**: Find results even with typos
- **Multi-word queries**: Search with multiple terms
- **Case-insensitive**: Search works regardless of case

### Performance

- **Fast indexing**: Documents are indexed using FlexSearch for quick search
- **Memory efficient**: Optimized for handling large document sets
- **Real-time updates**: Index updates immediately when documents change
- **Excerpt optimization**: Large documents are processed efficiently for excerpt generation

### Example: Loading Documentation

```javascript
import fs from 'fs/promises';
import path from 'path';
import { ExpressMcp } from '@express-mcp/express-mcp';

const expressMcp = new ExpressMcp();

// Load markdown files from a documentation directory
async function loadDocumentation(docsPath) {
  const files = await fs.readdir(docsPath);
  
  for (const file of files) {
    if (file.endsWith('.md')) {
      const content = await fs.readFile(path.join(docsPath, file), 'utf-8');
      const id = path.basename(file, '.md');
      
      // Extract title from first heading
      const titleMatch = content.match(/^#\s+(.+)$/m);
      const title = titleMatch ? titleMatch[1] : id;
      
      // Extract tags from filename or content
      const tags = file.includes('-') ? file.split('-').slice(0, -1) : [];
      
      await expressMcp.addDocument(id, {
        title,
        content,
        tags,
        metadata: {
          filename: file,
          loadedAt: new Date().toISOString()
        }
      });
    }
  }
  
  const stats = await expressMcp.getKnowledgeBaseStats();
  console.log(`Loaded ${stats.totalDocuments} documents`);
}

// Usage
await loadDocumentation('./docs');
```

## MCP Protocol Support

This module implements the Model Context Protocol (MCP) specification:

- **initialize**: Initialize MCP session
- **notifications/initialized**: Confirm initialization
- **tools/list**: List available tools
- **tools/call**: Execute tool with parameters

All responses follow JSON-RPC 2.0 format with proper error handling.

## Development

### Scripts

```bash
# Development
npm run dev                    # Start example with auto-restart
npm run example               # Run example application
npm start                     # Start example application

# Testing
npm test                      # Run all tests
npm run test:unit            # Run unit tests only
npm run coverage             # Run tests with coverage
npm run test:coverage        # Run tests with LCOV coverage

# Code Quality
npm run lint                  # Run ESLint
npm run lint:fix             # Fix auto-fixable issues

# Build
npm run build                # Clean build artifacts
npm run clean                # Remove build artifacts and coverage
```

### Project Structure

```
src/
├── index.js                 # Main module exports
├── classes/
│   ├── index.js            # Class exports
│   ├── expressMcp.js         # Main ExpressMcp class
│   ├── toolRegistry.js     # Tool registry management
│   ├── baseTool.js         # Base tool interface
│   └── knowledgeBase.js    # Knowledge base implementation
├── tools/
│   └── knowledgeBase.js    # Knowledge base MCP tools
tests/
├── unit/                   # Unit tests
│   ├── expressMcp.test.js
│   ├── toolRegistry.test.js
│   ├── baseTool.test.js
│   ├── knowledgeBase.test.js
│   ├── expressMcpKnowledgeBase.test.js
│   ├── flexsearchIntegration.test.js
│   ├── flexsearchMcpIntegration.test.js
│   └── mcpProtocol.test.js
└── testUtils.js           # Test utilities
examples/
└── example.js             # Example application with knowledge base
```

## Publishing New Versions

### Locally (for testing)

This is useful when you want to test the integration of **express-mcp** in other services locally before publishing a new version.

1. Run `npm pack` in this module to generate `express-mcp-x.x.x.tgz`
2. Install in your target service: `npm install path/to/express-mcp-x.x.x.tgz`

### Remotely (production)

Releases to ExampleCorp NPM package registry are enabled on `main` branch through CI.

To create a new release:

1. **Create version**: Run `npm version major/minor/patch`
   - This creates a tag for the version type you want
   - Bumps the version in `package.json`
   - Creates a version commit and tag

2. **Push changes**: Run `git push && git push --tags`
   - This pushes both the commit and the new tag to Github

3. **Create PR**: Create your pull request and get approvals

**Important Notes:**
- New versions should **only** be generated using the `npm version` command
- Make sure to push tags to branch before creating a pull request
- CI build and publish actions run automatically on `main` branch
- You don't need to create a tag for minor changes like README updates

### Version Guidelines

- **patch**: Bug fixes, documentation updates
- **minor**: New features, backward-compatible changes
- **major**: Breaking changes, API modifications

## Requirements

- Node.js 20
- npm 10.x
- Express.js 4.18+

## License

UNLICENSED