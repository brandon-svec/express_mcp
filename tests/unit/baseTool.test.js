import { assert } from 'chai';
import { BaseTool } from '../../src/classes/baseTool.js';

describe('BaseTool', () => {
  describe('constructor', () => {
    it('should create BaseTool with name and description', () => {
      const tool = new BaseTool('test-tool', 'Test tool description');
      
      assert.strictEqual(tool.name, 'test-tool');
      assert.strictEqual(tool.description, 'Test tool description');
      assert.isUndefined(tool.inputSchema);
    });

    it('should create BaseTool with provided parameters', () => {
      const schema = { type: 'object', properties: { param: { type: 'string' } } };
      const tool = new BaseTool('test-tool', 'Test description', schema);
      
      assert.strictEqual(tool.name, 'test-tool');
      assert.strictEqual(tool.description, 'Test description');
      assert.deepStrictEqual(tool.inputSchema, schema);
    });

    it('should throw error for missing name', () => {
      assert.throws(() => {
        new BaseTool('', 'Test description');
      }, 'Tool name is required and must be a string');
      
      assert.throws(() => {
        new BaseTool(null, 'Test description');
      }, 'Tool name is required and must be a string');
      
      assert.throws(() => {
        new BaseTool(undefined, 'Test description');
      }, 'Tool name is required and must be a string');
    });

    it('should throw error for invalid name type', () => {
      assert.throws(() => {
        new BaseTool(123, 'Test description');
      }, 'Tool name is required and must be a string');
      
      assert.throws(() => {
        new BaseTool([], 'Test description');
      }, 'Tool name is required and must be a string');
    });

    it('should throw error for missing description', () => {
      assert.throws(() => {
        new BaseTool('test-tool', '');
      }, 'Tool description is required and must be a string');
      
      assert.throws(() => {
        new BaseTool('test-tool', null);
      }, 'Tool description is required and must be a string');
      
      assert.throws(() => {
        new BaseTool('test-tool', undefined);
      }, 'Tool description is required and must be a string');
    });

    it('should throw error for invalid description type', () => {
      assert.throws(() => {
        new BaseTool('test-tool', 123);
      }, 'Tool description is required and must be a string');
      
      assert.throws(() => {
        new BaseTool('test-tool', {});
      }, 'Tool description is required and must be a string');
    });

    it('should throw error for invalid input schema', () => {
      assert.throws(() => {
        new BaseTool('test-tool', 'Test description', 'invalid');
      }, 'Input schema must be an object if provided');
      
      assert.throws(() => {
        new BaseTool('test-tool', 'Test description', null);
      }, 'Input schema must be an object if provided');
      
      assert.throws(() => {
        new BaseTool('test-tool', 'Test description', 123);
      }, 'Input schema must be an object if provided');
    });

    it('should throw error for invalid JSON schema', () => {
      // AJV will catch truly invalid schemas (circular references, etc.)
      const circularSchema = { type: 'object' };
      circularSchema.properties = { self: circularSchema }; // This creates circular reference
      
      // For a simpler test, use an invalid $ref
      assert.throws(() => {
        new BaseTool('test-tool', 'Test description', { $ref: '#/invalid/reference', additionalProperties: false });
      }, /Invalid JSON Schema/);
    });

    it('should accept schema without type (valid in JSON Schema)', () => {
      // JSON Schema allows schemas without explicit type
      const tool = new BaseTool('test-tool', 'Test description', { properties: {} });
      assert.deepStrictEqual(tool.inputSchema, { properties: {} });
    });

    it('should accept valid input schema', () => {
      const schema = { type: 'object', properties: { param: { type: 'string' } } };
      const tool = new BaseTool('test-tool', 'Test description', schema);
      
      assert.deepStrictEqual(tool.inputSchema, schema);
    });
  });

  describe('execute method', () => {
    it('should throw error when execute is not implemented', async () => {
      const tool = new BaseTool('test-tool', 'Test description');
      
      try {
        await tool.execute({}, {});
        assert.fail('Should have thrown an error');
      } catch (error) {
        assert.strictEqual(error.message, 'execute method must be implemented by subclass');
      }
    });
  });

  describe('validateInput method', () => {
    it('should pass validation with no schema', () => {
      const tool = new BaseTool('test-tool', 'Test description');
      
      // Should not throw
      tool.validateInput({ anything: 'goes' });
    });

    it('should pass validation with valid input', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' }
        },
        required: ['name']
      };
      const tool = new BaseTool('test-tool', 'Test description', schema);
      
      // Should not throw
      tool.validateInput({ name: 'John', age: 30 });
      tool.validateInput({ name: 'Jane' }); // age is optional
    });

    it('should fail validation with invalid input', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' }
        },
        required: ['name']
      };
      const tool = new BaseTool('test-tool', 'Test description', schema);
      
      // Missing required field
      assert.throws(() => {
        tool.validateInput({ age: 30 });
      }, /Input validation failed.*must have required property 'name'/);
      
      // Wrong type
      assert.throws(() => {
        tool.validateInput({ name: 123 });
      }, /Input validation failed.*must be string/);
    });

    it('should validate complex schemas', () => {
      const schema = {
        type: 'object',
        properties: {
          user: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              email: { type: 'string', format: 'email' }
            },
            required: ['name']
          },
          count: { type: 'integer', minimum: 1 }
        },
        required: ['user']
      };
      
      const tool = new BaseTool('test-tool', 'Test description', schema);
      
      // Valid complex input
      tool.validateInput({
        user: { name: 'John', email: 'john@example.com' },
        count: 5
      });
      
      // Invalid - missing required nested property
      assert.throws(() => {
        tool.validateInput({ user: { email: 'john@example.com' } });
      }, /Input validation failed.*must have required property 'name'/);
    });
  });

  describe('inputSchema', () => {
    it('should allow custom input schema', () => {
      const tool = new BaseTool('test-tool', 'Test description');
      const customSchema = {
        type: 'object',
        properties: {
          param1: { type: 'string' },
          param2: { type: 'number' }
        },
        required: ['param1']
      };
      
      tool.inputSchema = customSchema;
      assert.deepStrictEqual(tool.inputSchema, customSchema);
    });
  });

  describe('getDefinition', () => {
    it('should return tool definition for MCP', () => {
      const tool = new BaseTool('test-tool', 'Test description');
      tool.inputSchema = {
        type: 'object',
        properties: { param: { type: 'string' } }
      };
      
      const definition = tool.getDefinition();
      
      assert.deepStrictEqual(definition, {
        name: 'test-tool',
        description: 'Test description',
        inputSchema: {
          type: 'object',
          properties: { param: { type: 'string' } }
        }
      });
    });

    it('should return definition with undefined schema', () => {
      const tool = new BaseTool('test-tool', 'Test description');
      
      const definition = tool.getDefinition();
      
      assert.deepStrictEqual(definition, {
        name: 'test-tool',
        description: 'Test description',
        inputSchema: undefined
      });
    });
  });

  describe('subclass implementation', () => {
    class TestTool extends BaseTool {
      constructor() {
        super('test-tool', 'A test tool');
        this.inputSchema = {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'Message to return' }
          },
          required: ['message']
        };
      }

      async execute(args) {
        return `Hello, ${args.message}!`;
      }
    }

    it('should work when properly extended', async () => {
      const tool = new TestTool();
      
      assert.strictEqual(tool.name, 'test-tool');
      assert.strictEqual(tool.description, 'A test tool');
      
      const result = await tool.execute({ message: 'World' });
      assert.strictEqual(result, 'Hello, World!');
    });

    it('should have custom input schema', () => {
      const tool = new TestTool();
      
      assert.deepStrictEqual(tool.inputSchema, {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Message to return' }
        },
        required: ['message']
      });
    });
  });
});
