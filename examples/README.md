# ExpressMcp Examples

This directory contains example applications showing how to integrate ExpressMcp into existing Express servers using the modern class-based API.

## Quick Start

```bash
# Run the example application
npm run example

# Development mode with auto-restart
npm run dev

# Start on custom port
npm run example 3001
```

## Example Application

### Simple Integration (`exampleApp.js`)

Demonstrates the cleanest way to add MCP functionality to an existing Express server using the ExpressMcp class.

**Features:**
- Instance-based tool management
- Clean ExpressMcp class integration
- Custom tool registration
- MCP protocol endpoint

**Usage:**
```javascript
import { ExpressMcp, BaseTool } from '@express-mcp/express-mcp';

// 1. Create custom tools
class MyTool extends BaseTool {
  constructor() {
    super('my-tool', 'Tool description');
  }
  async execute(args) {
    return 'Tool result';
  }
}

// 2. Create ExpressMcp instance and register tools
const expressMcp = new ExpressMcp();
expressMcp.registerTool(new MyTool());

// 3. Get router and mount it
app.use('/mcp', expressMcp.router());
```

**Endpoints:**
- `GET /` - Welcome page with MCP information
- `POST /mcp` - MCP protocol endpoint for AI assistants

## Testing the Example

1. **Start the example:**
   ```bash
   npm run example        # Starts on port 3000
   npm run example 3001   # Starts on port 3001
   ```

2. **Test the endpoints:**
   ```bash
   # Check home page
   curl http://localhost:3000/
   
   # List available tools (MCP protocol)
   curl -X POST http://localhost:3000/mcp \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
   
   # Execute a tool (MCP protocol)
   curl -X POST http://localhost:3000/mcp \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"hello","arguments":{"name":"World"}},"id":2}'
   ```

## ExpressMcp Class API

### Core Methods

```javascript
const expressMcp = new ExpressMcp();

// Tool Management
expressMcp.registerTool(toolInstance)      // Register a tool
expressMcp.unregisterTool(toolName)        // Remove a tool
expressMcp.getRegisteredTools()            // Get all tools
expressMcp.hasRegisteredTool(toolName)     // Check if tool exists
expressMcp.getRegisteredToolCount()        // Count registered tools
expressMcp.clearRegisteredTools()          // Remove all tools

// Router Creation
expressMcp.router()                        // Get Express router
```

### Creating Custom Tools

```javascript
import { BaseTool } from '@express-mcp/express-mcp';

class CustomTool extends BaseTool {
  constructor() {
    super('tool-name', 'Tool description');
    
    // Optional: Define input schema
    this.inputSchema = {
      type: 'object',
      properties: {
        param1: { type: 'string', description: 'Parameter description' },
        param2: { type: 'number', description: 'Number parameter' }
      },
      required: ['param1']
    };
  }
  
  async execute(args, context) {
    // Tool implementation
    const { param1, param2 } = args;
    return `Tool executed with ${param1} and ${param2}`;
  }
}
```

## Integration Patterns

### Pattern 1: Basic Integration
Use when you want simple MCP functionality with default settings.

```javascript
import { ExpressMcp, BaseTool } from '@express-mcp/express-mcp';

const expressMcp = new ExpressMcp();
expressMcp.registerTool(new MyTool());
app.use('/mcp', expressMcp.router());
```

### Pattern 2: Multiple Tool Registration
Register multiple tools to create a comprehensive MCP server.

```javascript
const expressMcp = new ExpressMcp();

// Register multiple tools
expressMcp.registerTool(new CalculatorTool());
expressMcp.registerTool(new WeatherTool());
expressMcp.registerTool(new DatabaseTool());

app.use('/mcp', expressMcp.router());

console.log(`Registered ${expressMcp.getRegisteredToolCount()} tools`);
```

### Pattern 3: Multiple MCP Instances
Create separate MCP instances for different purposes.

```javascript
// Admin tools instance
const adminMcp = new ExpressMcp();
adminMcp.registerTool(new AdminTool());
app.use('/admin/mcp', adminMcp.router());

// Public tools instance  
const publicMcp = new ExpressMcp();
publicMcp.registerTool(new PublicTool());
app.use('/public/mcp', publicMcp.router());
```

## File Structure

```
examples/
├── README.md           # This file
└── exampleApp.js       # Main example application
```

## Development

- Example uses `nodemon` for development with auto-restart
- Includes detailed console logging
- Demonstrates proper ExpressMcp class usage
- Shows how to integrate with existing Express applications
- Provides working MCP tool example

## MCP Protocol

The ExpressMcp class implements the Model Context Protocol (MCP) specification:

- **JSON-RPC 2.0** communication protocol
- **Tool discovery** via `tools/list` method
- **Tool execution** via `tools/call` method  
- **Initialization** via `initialize` method
- **Error handling** with proper JSON-RPC error responses

AI assistants can connect to the `/mcp` endpoint to discover and execute registered tools.