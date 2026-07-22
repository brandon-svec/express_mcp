import Ajv from 'ajv';
import addFormats from 'ajv-formats';

/**
 * Base class for MCP tools
 */
export class BaseTool {
  constructor(name, description, inputSchema) {
    // Validate required parameters
    if (!name || typeof name !== 'string') {
      throw new Error('Tool name is required and must be a string');
    }
    
    if (!description || typeof description !== 'string') {
      throw new Error('Tool description is required and must be a string');
    }
    
    // Validate input schema if provided using AJV
    if (inputSchema !== undefined) {
      if (typeof inputSchema !== 'object' || inputSchema === null) {
        throw new Error('Input schema must be an object if provided');
      }
      
      // Use AJV to validate the schema and create validator in one step
      // Enable allErrors to get all validation errors, not just the first one
      const ajv = new Ajv({ strict: false, allErrors: true });
      addFormats(ajv); // Add format validation support (email, date, etc.)
      try {
        this._validator = ajv.compile(inputSchema);
      } catch (error) {
        throw new Error(`Invalid JSON Schema: ${error.message}`);
      }
    }
    
    this.name = name;
    this.description = description;
    this.inputSchema = inputSchema;
  }

  /**
   * Get the tool definition for MCP tools/list
   */
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
              inputSchema: this.inputSchema
    };
  }

  /**
   * Validate input arguments against the tool's schema
   * @param {Object} args - Arguments to validate
   * @throws {Error} If validation fails
   */
  validateInput(args) {
    // No schema defined, skip validation
    if (!this.inputSchema || !this._validator) {
      return;
    }
    
    const isValid = this._validator(args);
    if (!isValid) {
      const errors = this._validator.errors
        .map(err => `${err.instancePath || 'root'} ${err.message}`)
        .join('; ');
      throw new Error(`Input validation failed: ${errors}`);
    }
  }

  /**
   * Execute the tool with given arguments
   * @param {Object} _args - Tool arguments
   * @param {Object} _context - Execution context
   * @param {import('./toolExecution.js').ToolExecution} _context.execution - Tool execution tracker
   * @param {Object|null} [_context.user] - Authenticated user from JWT (sub, login, name, email, provider)
   * @returns {Promise<Object>} - Tool result
   */
  async execute(_args, _context) {
    throw new Error('execute method must be implemented by subclass');
  }
}
