import { assert } from 'chai';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ToolRegistry } from '../../src/classes/toolRegistry.js';
import { BaseTool } from '../../src/classes/baseTool.js';
import { CommandTool } from '../../src/classes/commandTool.js';
import { BaseHook } from '../../src/classes/baseHook.js';
import { HookRegistry } from '../../src/classes/hookRegistry.js';
import { ToolExecution } from '../../src/classes/toolExecution.js';

describe('ToolRegistry', () => {
  let registry;
  let testTool;

  class TestTool extends BaseTool {
    constructor(name = 'test-tool', description = 'A test tool') {
      super(name, description);
    }

    async execute(args) {
      return `Test executed with: ${JSON.stringify(args)}`;
    }
  }

  beforeEach(() => {
    registry = new ToolRegistry();
    testTool = new TestTool();
  });

  describe('constructor', () => {
    it('should create empty registry', () => {
      assert.strictEqual(registry.getToolCount(), 0);
      assert.isArray(registry.getTools());
      assert.isEmpty(registry.getTools());
    });
  });

  describe('register', () => {
    it('should register a valid tool', () => {
      registry.register(testTool);
      
      assert.strictEqual(registry.getToolCount(), 1);
      assert.isTrue(registry.hasTool('test-tool'));
    });

    it('should throw error for tool without execute method', () => {
      const invalidTool = { name: 'invalid' };
      
      assert.throws(() => registry.register(invalidTool), 'Tool must have an execute method');
    });

    it('should throw error for tool without name', () => {
      const invalidTool = { execute: () => {} };
      
      assert.throws(() => registry.register(invalidTool), 'Tool must have a name');
    });

    it('should allow registering multiple tools', () => {
      const tool1 = new TestTool('tool1', 'First tool');
      const tool2 = new TestTool('tool2', 'Second tool');
      
      registry.register(tool1);
      registry.register(tool2);
      
      assert.strictEqual(registry.getToolCount(), 2);
      assert.isTrue(registry.hasTool('tool1'));
      assert.isTrue(registry.hasTool('tool2'));
    });

    it('should throw error when registering tool with same name', () => {
      const tool1 = new TestTool('same-name', 'First tool');
      const tool2 = new TestTool('same-name', 'Second tool');
      
      registry.register(tool1);
      
      // Should throw error when trying to register a tool with the same name
      assert.throws(() => {
        registry.register(tool2);
      }, /Tool 'same-name' is already registered. Cannot register duplicate tool names./);
      
      // Original tool should still be there
      assert.strictEqual(registry.getToolCount(), 1);
      const tools = registry.getTools();
      assert.strictEqual(tools[0].description, 'First tool');
    });
  });

  describe('unregister', () => {
    beforeEach(() => {
      registry.register(testTool);
    });

    it('should unregister existing tool', () => {
      registry.unregister('test-tool');
      
      assert.strictEqual(registry.getToolCount(), 0);
      assert.isFalse(registry.hasTool('test-tool'));
    });

    it('should handle unregistering non-existent tool', () => {
      registry.unregister('non-existent');
      
      assert.strictEqual(registry.getToolCount(), 1);
      assert.isTrue(registry.hasTool('test-tool'));
    });
  });

  describe('getTools', () => {
    it('should return empty array for empty registry', () => {
      const tools = registry.getTools();
      
      assert.isArray(tools);
      assert.isEmpty(tools);
    });

    it('should return all registered tools', () => {
      const tool1 = new TestTool('tool1', 'First tool');
      const tool2 = new TestTool('tool2', 'Second tool');
      
      registry.register(tool1);
      registry.register(tool2);
      
      const tools = registry.getTools();
      assert.lengthOf(tools, 2);
      assert.include(tools, tool1);
      assert.include(tools, tool2);
    });
  });

  describe('getToolDefinitions', () => {
    it('should return empty array for empty registry', () => {
      const definitions = registry.getToolDefinitions();
      
      assert.isArray(definitions);
      assert.isEmpty(definitions);
    });

    it('should return tool definitions in MCP format', () => {
      registry.register(testTool);
      
      const definitions = registry.getToolDefinitions();
      assert.lengthOf(definitions, 1);
      
      const definition = definitions[0];
      assert.strictEqual(definition.name, 'test-tool');
      assert.strictEqual(definition.description, 'A test tool');
      assert.property(definition, 'inputSchema');
    });

    it('should include custom input schema', () => {
      testTool.inputSchema = {
        type: 'object',
        properties: {
          param: { type: 'string' }
        },
        required: ['param']
      };
      registry.register(testTool);
      
      const definitions = registry.getToolDefinitions();
      const definition = definitions[0];
      
      assert.deepStrictEqual(definition.inputSchema, {
        type: 'object',
        properties: {
          param: { type: 'string' }
        },
        required: ['param']
      });
    });
  });

  describe('executeTool', () => {
    beforeEach(() => {
      registry.register(testTool);
    });

    it('should execute existing tool successfully', async () => {
      const execution = new ToolExecution('test-tool', 'test-id', { message: 'hello' });
      const context = { execution };
      
      const result = await registry.executeTool('test-tool', { message: 'hello' }, context);
      
      assert.strictEqual(result, execution);
      assert.strictEqual(result.status, 'success');
      assert.strictEqual(result.result, 'Test executed with: {"message":"hello"}');
      assert.strictEqual(result.toolName, 'test-tool');
    });

    it('should return error for non-existent tool', async () => {
      const execution = new ToolExecution('non-existent', 'test-id', {});
      const context = { execution };
      
      const result = await registry.executeTool('non-existent', {}, context);
      
      assert.strictEqual(result, execution);
      assert.strictEqual(result.status, 'error');
      const errorData = result.getErrorData();
      assert.strictEqual(errorData.error, "Tool 'non-existent' not found");
      assert.strictEqual(errorData.errorCode, -32601);
    });

    it('should handle tool execution errors', async () => {
      class ErrorTool extends BaseTool {
        constructor() {
          super('error-tool', 'Tool that throws error');
        }

        async execute() {
          throw new Error('Tool execution failed');
        }
      }

      registry.register(new ErrorTool());
      const execution = new ToolExecution('error-tool', 'test-id', {});
      const context = { execution };
      
      const result = await registry.executeTool('error-tool', {}, context);
      
      assert.strictEqual(result, execution);
      assert.strictEqual(result.status, 'error');
      const errorData = result.getErrorData();
      assert.strictEqual(errorData.error, 'Tool execution failed');
      assert.strictEqual(errorData.errorCode, -32603);
      assert.notProperty(errorData, 'errorData');
    });

    it('should handle string results', async () => {
      class StringTool extends BaseTool {
        constructor() {
          super('string-tool', 'Returns string');
        }

        async execute() {
          return 'Simple string result';
        }
      }

      registry.register(new StringTool());
      const execution = new ToolExecution('string-tool', 'test-id', {});
      const context = { execution };
      
      const result = await registry.executeTool('string-tool', {}, context);
      
      assert.strictEqual(result.status, 'success');
      assert.strictEqual(result.result, 'Simple string result');
    });

    it('should handle object results', async () => {
      class ObjectTool extends BaseTool {
        constructor() {
          super('object-tool', 'Returns object');
        }

        async execute() {
          return { status: 'success', data: [1, 2, 3] };
        }
      }

      registry.register(new ObjectTool());
      const execution = new ToolExecution('object-tool', 'test-id', {});
      const context = { execution };
      
      const result = await registry.executeTool('object-tool', {}, context);
      
      assert.strictEqual(result.status, 'success');
      assert.deepStrictEqual(result.result, { status: 'success', data: [1, 2, 3] });
    });
  });

  describe('hasTool', () => {
    it('should return false for empty registry', () => {
      assert.isFalse(registry.hasTool('any-tool'));
    });

    it('should return true for registered tool', () => {
      registry.register(testTool);
      
      assert.isTrue(registry.hasTool('test-tool'));
    });

    it('should return false for unregistered tool', () => {
      registry.register(testTool);
      
      assert.isFalse(registry.hasTool('other-tool'));
    });
  });

  describe('getToolCount', () => {
    it('should return 0 for empty registry', () => {
      assert.strictEqual(registry.getToolCount(), 0);
    });

    it('should return correct count after registrations', () => {
      assert.strictEqual(registry.getToolCount(), 0);
      
      registry.register(new TestTool('tool1'));
      assert.strictEqual(registry.getToolCount(), 1);
      
      registry.register(new TestTool('tool2'));
      assert.strictEqual(registry.getToolCount(), 2);
      
      registry.unregister('tool1');
      assert.strictEqual(registry.getToolCount(), 1);
    });
  });

  describe('clear', () => {
    it('should remove all tools', () => {
      registry.register(new TestTool('tool1'));
      registry.register(new TestTool('tool2'));
      
      assert.strictEqual(registry.getToolCount(), 2);
      
      registry.clear();
      
      assert.strictEqual(registry.getToolCount(), 0);
      assert.isEmpty(registry.getTools());
    });

    it('should handle clearing empty registry', () => {
      registry.clear();
      
      assert.strictEqual(registry.getToolCount(), 0);
    });
  });

  describe('input validation during execution', () => {
    class ValidatedTool extends BaseTool {
      constructor(name = 'validated-tool') {
        const schema = {
          type: 'object',
          properties: {
            message: { type: 'string' },
            count: { type: 'number', minimum: 1 }
          },
          required: ['message']
        };
        super(name, 'A test tool with validation', schema);
      }
      
      async execute(args) {
        return `Tool executed with message: ${args.message}, count: ${args.count || 'default'}`;
      }
    }

    it('should validate input before executing tool', async () => {
      const tool = new ValidatedTool();
      registry.register(tool);
      
      // Valid input should work
      const execution1 = new ToolExecution('validated-tool', 'req1', { message: 'hello', count: 5 });
      const result1 = await registry.executeTool('validated-tool', { message: 'hello', count: 5 }, { execution: execution1 });
      assert.strictEqual(result1.status, 'success');
      assert.include(result1.result, 'Tool executed with message: hello, count: 5');
      
      // Missing required field should fail
      const execution2 = new ToolExecution('validated-tool', 'req2', { count: 5 });
      const result2 = await registry.executeTool('validated-tool', { count: 5 }, { execution: execution2 });
      assert.strictEqual(result2.status, 'error');
      const errorData2 = result2.getErrorData();
      assert.strictEqual(errorData2.errorCode, -32602);
      assert.include(errorData2.error, 'Validation failed');
      assert.include(errorData2.error, 'must have required property');
      assert.property(errorData2, 'errorData');
      assert.property(errorData2.errorData, 'validationErrors');
      assert.isArray(errorData2.errorData.validationErrors);
      
      // Invalid type should fail
      const execution3 = new ToolExecution('validated-tool', 'req3', { message: 123 });
      const result3 = await registry.executeTool('validated-tool', { message: 123 }, { execution: execution3 });
      assert.strictEqual(result3.status, 'error');
      const errorData3 = result3.getErrorData();
      assert.strictEqual(errorData3.errorCode, -32602);
      assert.include(errorData3.error, 'Validation failed');
      assert.include(errorData3.error, 'must be string');
      assert.property(errorData3, 'errorData');
      assert.property(errorData3.errorData, 'validationErrors');
    });

    it('should not validate when tool has no schema', async () => {
      const tool = new TestTool('no-schema-tool');
      registry.register(tool);
      
      // Any input should work when no schema is defined
      const execution = new ToolExecution('no-schema-tool', 'req', { anything: 'goes', here: 123 });
      const result = await registry.executeTool('no-schema-tool', { anything: 'goes', here: 123 }, { execution });
      assert.strictEqual(result.status, 'success');
      assert.property(result, 'result');
    });

    it('should provide detailed validation error structure for nested objects', async () => {
      class NestedValidationTool extends BaseTool {
        constructor() {
          const schema = {
            type: 'object',
            properties: {
              user: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  age: { type: 'number', minimum: 0 },
                  email: { type: 'string', format: 'email' }
                },
                required: ['name', 'email']
              },
              preferences: {
                type: 'object',
                properties: {
                  theme: { type: 'string', enum: ['light', 'dark'] }
                }
              }
            },
            required: ['user']
          };
          super('nested-tool', 'A tool with nested validation', schema);
        }
        async execute(args) {
          return `User: ${args.user.name}`;
        }
      }

      const tool = new NestedValidationTool();
      registry.register(tool);

      // Test with multiple validation errors
      const execution = new ToolExecution('nested-tool', 'nested-test', {
        user: {
          name: 123, // Wrong type
          age: -5,   // Below minimum
          // missing email (required)
        },
        preferences: {
          theme: 'invalid' // Not in enum
        }
      });
      
      const result = await registry.executeTool('nested-tool', {
        user: {
          name: 123, // Wrong type
          age: -5,   // Below minimum
          // missing email (required)
        },
        preferences: {
          theme: 'invalid' // Not in enum
        }
      }, { execution });

      assert.strictEqual(result.status, 'error');
      const errorData = result.getErrorData();
      assert.strictEqual(errorData.errorCode, -32602);
      assert.include(errorData.error, 'Validation failed');
      
      // Check detailed error structure
      assert.property(errorData, 'errorData');
      assert.property(errorData.errorData, 'validationErrors');
      assert.notProperty(errorData.errorData, 'rejectedValue');
      assert.isArray(errorData.errorData.validationErrors);
      
      // We expect exactly 4 validation errors for our test data
      const errors = errorData.errorData.validationErrors;
      assert.strictEqual(errors.length, 4);
      
      // Each error should have the expected structure
      errors.forEach(err => {
        assert.property(err, 'path');
        assert.property(err, 'property');
        assert.property(err, 'message');
      });
      
      // Verify specific errors are present
      const errorMessages = errors.map(err => err.message);
      assert.include(errorMessages, "must have required property 'email'");
      assert.include(errorMessages, "must be string");
      assert.include(errorMessages, "must be >= 0");
      assert.include(errorMessages, "must be equal to one of the allowed values");
      
      // Verify nested property paths are correctly formatted
      const properties = errors.map(err => err.property);
      assert.include(properties, "user");
      assert.include(properties, "user.name");
      assert.include(properties, "user.age");
      assert.include(properties, "preferences.theme");
      
      // Verify allowedValues is included for enum errors
      const enumError = errors.find(err => err.message.includes('allowed values'));
      assert.property(enumError, 'allowedValues');
      assert.deepStrictEqual(enumError.allowedValues, ['light', 'dark']);
    });
  });

  describe('prefix functionality', () => {
    it('should register tool without prefix when none provided', () => {
      const tool = new TestTool('test-tool');
      registry.register(tool);

      assert.isTrue(registry.hasTool('test-tool'));
      assert.strictEqual(tool.name, 'test-tool');
      
      const tools = registry.getTools();
      assert.strictEqual(tools[0].name, 'test-tool');
    });

    it('should register tool with prefix when provided', () => {
      const tool = new TestTool('test-tool');
      registry.register(tool, 'my-service');

      // Should be accessible by both original and prefixed names
      assert.isTrue(registry.hasTool('test-tool'));
      assert.isTrue(registry.hasTool('my-service_test-tool'));
      
      // Tool instance name should be updated to prefixed version
      assert.strictEqual(tool.name, 'my-service_test-tool');
      
      const tools = registry.getTools();
      assert.strictEqual(tools[0].name, 'my-service_test-tool');
    });

    it('should not apply prefix when prefix is empty string', () => {
      const tool = new TestTool('test-tool');
      registry.register(tool, '');

      assert.isTrue(registry.hasTool('test-tool'));
      assert.isFalse(registry.hasTool('_test-tool'));
      assert.strictEqual(tool.name, 'test-tool');
    });

    it('should not apply prefix when prefix is null', () => {
      const tool = new TestTool('test-tool');
      registry.register(tool, null);

      assert.isTrue(registry.hasTool('test-tool'));
      assert.strictEqual(tool.name, 'test-tool');
    });

    it('should unregister tool using original name after prefixing', () => {
      const tool = new TestTool('test-tool');
      registry.register(tool, 'my-service');

      assert.isTrue(registry.hasTool('test-tool'));
      assert.isTrue(registry.hasTool('my-service_test-tool'));

      registry.unregister('test-tool');

      assert.isFalse(registry.hasTool('test-tool'));
      assert.isFalse(registry.hasTool('my-service_test-tool'));
      assert.strictEqual(registry.getToolCount(), 0);
    });

    it('should unregister tool using prefixed name', () => {
      const tool = new TestTool('test-tool');
      registry.register(tool, 'my-service');

      registry.unregister('my-service_test-tool');

      assert.isFalse(registry.hasTool('test-tool'));
      assert.isFalse(registry.hasTool('my-service_test-tool'));
      assert.strictEqual(registry.getToolCount(), 0);
    });

    it('should execute tool using original name after prefixing', async () => {
      const tool = new TestTool('test-tool');
      registry.register(tool, 'my-service');

      const execution = new ToolExecution('test-tool', 'test-id', { message: 'hello' });
      const context = { execution };
      
      const result = await registry.executeTool('test-tool', { message: 'hello' }, context);
      
      assert.strictEqual(result.status, 'success');
      assert.strictEqual(result.result, 'Test executed with: {"message":"hello"}');
    });

    it('should execute tool using prefixed name', async () => {
      const tool = new TestTool('test-tool');
      registry.register(tool, 'my-service');

      const execution = new ToolExecution('my-service_test-tool', 'test-id', { message: 'hello' });
      const context = { execution };
      
      const result = await registry.executeTool('my-service_test-tool', { message: 'hello' }, context);
      
      assert.strictEqual(result.status, 'success');
      assert.strictEqual(result.result, 'Test executed with: {"message":"hello"}');
    });

    it('should clear all tools and mappings', () => {
      const tool1 = new TestTool('tool1');
      const tool2 = new TestTool('tool2');
      
      registry.register(tool1, 'prefix1');
      registry.register(tool2, 'prefix2');

      assert.strictEqual(registry.getToolCount(), 2);
      assert.isTrue(registry.hasTool('tool1'));
      assert.isTrue(registry.hasTool('tool2'));

      registry.clear();

      assert.strictEqual(registry.getToolCount(), 0);
      assert.isFalse(registry.hasTool('tool1'));
      assert.isFalse(registry.hasTool('tool2'));
      assert.isFalse(registry.hasTool('prefix1_tool1'));
      assert.isFalse(registry.hasTool('prefix2_tool2'));
    });

    it('should throw error when re-registering duplicate tool name', () => {
      const tool1 = new TestTool('duplicate');
      const tool2 = new TestTool('duplicate');

      registry.register(tool1);

      assert.throws(() => {
        registry.register(tool2);
      }, /Tool 'duplicate' is already registered. Cannot register duplicate tool names./);

      assert.strictEqual(registry.getToolCount(), 1);
    });

    it('should throw error when different tools would create conflicting final names', () => {
      const tool1 = new TestTool('tool');
      const tool2 = new TestTool('service_tool');

      registry.register(tool1, 'service');
      
      assert.throws(() => {
        registry.register(tool2);
      }, /Tool name conflict: 'service_tool' would create final name 'service_tool' which conflicts with existing tool 'tool'./);

      assert.strictEqual(registry.getToolCount(), 1);
      assert.isTrue(registry.hasTool('tool'));
      assert.isTrue(registry.hasTool('service_tool'));
    });

    it('should handle multiple tools with different prefixes', () => {
      const tool1 = new TestTool('search');
      const tool2 = new TestTool('find'); // Different original name
      const tool3 = new TestTool('list');

      registry.register(tool1, 'service1');
      registry.register(tool2, 'service2');
      registry.register(tool3, 'service1');

      assert.strictEqual(registry.getToolCount(), 3);
      
      // Check that tools are accessible by both original and prefixed names
      assert.isTrue(registry.hasTool('search'));
      assert.isTrue(registry.hasTool('find'));
      assert.isTrue(registry.hasTool('list'));
      assert.isTrue(registry.hasTool('service1_search'));
      assert.isTrue(registry.hasTool('service2_find'));
      assert.isTrue(registry.hasTool('service1_list'));
    });
  });

  describe('hooks integration', () => {
    class SchemaTool extends BaseTool {
      constructor() {
        super('schema-tool', 'Needs message', {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message']
        }, { title: 'Schema', readOnlyHint: true });
        this.executeCalls = [];
      }

      async execute(args) {
        this.executeCalls.push(args);
        return `ok:${args.message}`;
      }
    }

    class SpyHook extends BaseHook {
      constructor(name, events, handler, options = {}) {
        super(name, events, options);
        this.handler = handler;
        this.calls = [];
      }

      async execute(event, context) {
        this.calls.push({ event, context });
        return this.handler.call(this, event, context);
      }
    }

    it('exposes annotations on tool definitions and forwards tool_annotations', async () => {
      const hookRegistry = new HookRegistry();
      const pre = new SpyHook('pre', 'PreToolUse', function () {
        return this.allow();
      });
      hookRegistry.register(pre);
      registry = new ToolRegistry({ hookRegistry });
      const tool = new SchemaTool();
      registry.register(tool);

      const defs = registry.getToolDefinitions();
      assert.deepStrictEqual(defs[0].annotations, { title: 'Schema', readOnlyHint: true });

      const execution = new ToolExecution('schema-tool', 'id', { message: 'hi' });
      await registry.executeTool('schema-tool', { message: 'hi' }, { execution });
      assert.deepStrictEqual(pre.calls[0].event.tool_annotations, {
        title: 'Schema',
        readOnlyHint: true
      });
    });

    it('validates before PreToolUse so invalid args never invoke the hook', async () => {
      const hookRegistry = new HookRegistry();
      const pre = new SpyHook('pre', 'PreToolUse', function () {
        return this.allow();
      });
      hookRegistry.register(pre);
      registry = new ToolRegistry({ hookRegistry });
      registry.register(new SchemaTool());

      const execution = new ToolExecution('schema-tool', 'id', {});
      const result = await registry.executeTool('schema-tool', {}, { execution });
      assert.strictEqual(result.status, 'error');
      assert.strictEqual(result.getErrorData().errorCode, -32602);
      assert.lengthOf(pre.calls, 0);
    });

    it('re-validates updatedInput from PreToolUse modify', async () => {
      const hookRegistry = new HookRegistry();
      hookRegistry.register(new SpyHook('pre', 'PreToolUse', function () {
        return this.modify({ notMessage: true });
      }));
      registry = new ToolRegistry({ hookRegistry });
      const tool = new SchemaTool();
      registry.register(tool);

      const execution = new ToolExecution('schema-tool', 'id', { message: 'ok' });
      const result = await registry.executeTool('schema-tool', { message: 'ok' }, { execution });
      assert.strictEqual(result.status, 'error');
      assert.strictEqual(result.getErrorData().errorCode, -32602);
      assert.lengthOf(tool.executeCalls, 0);
    });

    it('PreToolUse deny blocks execute and sets hookBlocked', async () => {
      const hookRegistry = new HookRegistry();
      hookRegistry.register(new SpyHook('pre', 'PreToolUse', function () {
        return this.deny('blocked by policy', { additionalContext: 'more' });
      }));
      registry = new ToolRegistry({ hookRegistry });
      const tool = new SchemaTool();
      registry.register(tool);

      const execution = new ToolExecution('schema-tool', 'id', { message: 'x' });
      const result = await registry.executeTool('schema-tool', { message: 'x' }, { execution });
      assert.strictEqual(result.status, 'error');
      assert.lengthOf(tool.executeCalls, 0);
      const errorData = result.getErrorData();
      assert.strictEqual(errorData.error, 'blocked by policy');
      assert.isTrue(errorData.errorData.hookBlocked);
      assert.strictEqual(errorData.errorData.hookEvent, 'PreToolUse');
    });

    it('PostToolUse receives tool_result and duration_ms and appends additionalContext', async () => {
      const hookRegistry = new HookRegistry();
      const post = new SpyHook('post', 'PostToolUse', function () {
        return this.allow({ additionalContext: 'post-note' });
      });
      hookRegistry.register(post);
      registry = new ToolRegistry({ hookRegistry });
      registry.register(new SchemaTool());

      const execution = new ToolExecution('schema-tool', 'id', { message: 'x' });
      const result = await registry.executeTool('schema-tool', { message: 'x' }, { execution });
      assert.strictEqual(result.status, 'success');
      assert.strictEqual(result.hookAdditionalContext, 'post-note');
      assert.strictEqual(post.calls[0].event.tool_result, 'ok:x');
      assert.isNumber(post.calls[0].event.duration_ms);
    });

    it('registerOnMcpServer uses RequestHandlerExtra and returns isError on hook deny', async () => {
      const hookRegistry = new HookRegistry();
      hookRegistry.register(new SpyHook('pre', 'PreToolUse', function () {
        return this.deny('nope', { additionalContext: 'detail' });
      }));
      registry = new ToolRegistry({ hookRegistry });
      registry.register(new SchemaTool());

      const handlers = new Map();
      const mcpServer = {
        server: {
          registerCapabilities () {},
          setRequestHandler (schema, handler) {
            handlers.set(schema, handler);
          }
        }
      };

      registry.registerOnMcpServer(mcpServer, { user: { login: 'u' }, permissionMode: 'default' });
      assert.isTrue(handlers.has(ListToolsRequestSchema));
      assert.isTrue(handlers.has(CallToolRequestSchema));

      const callHandler = handlers.get(CallToolRequestSchema);
      const result = await callHandler(
        { params: { name: 'schema-tool', arguments: { message: 'hi' } } },
        {
          requestId: 'req-1',
          sessionId: 'sess-1',
          _meta: { traceparent: 'meta-tp' },
          requestInfo: { headers: { traceparent: 'header-tp' } }
        }
      );

      assert.isTrue(result.isError);
      assert.strictEqual(result.content[0].text, 'nope');
      assert.strictEqual(result.content[1].text, 'detail');
    });

    it('forwards sessionId and traceparent from extra into executeTool context', async () => {
      const hookRegistry = new HookRegistry();
      const pre = new SpyHook('pre', 'PreToolUse', function (event, context) {
        assert.strictEqual(event.session_id, 'sess-extra');
        assert.strictEqual(event.meta.traceparent, 'from-meta');
        assert.ok(context.extra);
        assert.ok(context.mcpServer);
        return this.allow();
      });
      hookRegistry.register(pre);
      registry = new ToolRegistry({ hookRegistry });
      registry.register(new SchemaTool());

      const handlers = new Map();
      const mcpServer = {
        server: {
          registerCapabilities () {},
          setRequestHandler (schema, handler) {
            handlers.set(schema, handler);
          }
        }
      };
      registry.registerOnMcpServer(mcpServer, {});

      const callHandler = handlers.get(CallToolRequestSchema);
      const result = await callHandler(
        { params: { name: 'schema-tool', arguments: { message: 'hi' } } },
        {
          requestId: 'r1',
          sessionId: 'sess-extra',
          _meta: { traceparent: 'from-meta' }
        }
      );
      assert.isUndefined(result.isError);
      assert.match(result.content[0].text, /ok:hi/);
    });

    it('appends hookAdditionalContext on successful MCP tools/call', async () => {
      const hookRegistry = new HookRegistry();
      hookRegistry.register(new SpyHook('post', 'PostToolUse', function () {
        return this.allow({ additionalContext: 'extra-note' });
      }));
      registry = new ToolRegistry({ hookRegistry });
      registry.register(new SchemaTool());

      const handlers = new Map();
      const mcpServer = {
        server: {
          registerCapabilities () {},
          setRequestHandler (schema, handler) {
            handlers.set(schema, handler);
          }
        }
      };
      registry.registerOnMcpServer(mcpServer, {});
      const result = await handlers.get(CallToolRequestSchema)(
        { params: { name: 'schema-tool', arguments: { message: 'z' } } },
        {}
      );
      assert.lengthOf(result.content, 2);
      assert.strictEqual(result.content[1].text, 'extra-note');
    });

    it('runs PermissionRequest for destructiveHint tools and can deny', async () => {
      class DestructiveTool extends BaseTool {
        constructor () {
          super('wipe', 'Wipe data', {
            type: 'object',
            properties: { confirm: { type: 'boolean' } },
            required: ['confirm']
          }, { destructiveHint: true });
          this.executeCalls = 0;
        }

        async execute () {
          this.executeCalls += 1;
          return 'wiped';
        }
      }

      const hookRegistry = new HookRegistry();
      const perm = new SpyHook('perm', 'PermissionRequest', function () {
        return this.deny('need approval');
      });
      hookRegistry.register(perm);
      registry = new ToolRegistry({ hookRegistry });
      const tool = new DestructiveTool();
      registry.register(tool);

      const execution = new ToolExecution('wipe', 'id', { confirm: true });
      const result = await registry.executeTool('wipe', { confirm: true }, {
        execution,
        permissionMode: 'default'
      });
      assert.strictEqual(result.status, 'error');
      assert.strictEqual(tool.executeCalls, 0);
      assert.lengthOf(perm.calls, 1);
      assert.isTrue(perm.calls[0].event.tool_annotations.destructiveHint);
    });
  });

  describe('findCommandMatch', () => {
    class StatusTool extends CommandTool {
      constructor () {
        super('status', 'Status', {
          type: 'object',
          properties: {},
          additionalProperties: false,
        }, { triggers: ['status'] });
      }

      async execute () {
        return { ok: true };
      }
    }

    it('returns match for registered CommandTool', () => {
      registry.register(new StatusTool());
      const match = registry.findCommandMatch('status');
      assert.isNotNull(match);
      assert.strictEqual(match.tool.name, 'status');
    });

    it('returns null when no trigger matches or tool is BaseTool', () => {
      registry.register(testTool);
      assert.isNull(registry.findCommandMatch('status'));
      registry.register(new StatusTool());
      assert.isNull(registry.findCommandMatch('ping'));
    });

    it('stops matching after unregister', () => {
      registry.register(new StatusTool());
      assert.isNotNull(registry.findCommandMatch('status'));
      registry.unregister('status');
      assert.isNull(registry.findCommandMatch('status'));
    });

    it('getTool resolves original and prefixed names', () => {
      const tool = new StatusTool();
      registry.register(tool, 'svc');
      assert.strictEqual(registry.getTool('status').name, 'svc_status');
      assert.strictEqual(registry.getTool('svc_status').name, 'svc_status');
      assert.isNull(registry.getTool('missing'));
    });
  });
});
