import { assert } from 'chai';
import { ExpressMcp } from '../../src/classes/expressMcp.js';
import { BaseTool } from '../../src/classes/baseTool.js';
import { getTestExpressMcpOptions } from '../config.js';

describe('ExpressMcp', () => {
  let expressMcp;
  let testTool;

  class TestTool extends BaseTool {
    constructor(name = 'test-tool', description = 'A test tool') {
      super(name, description);
    }

    async execute(args) {
      return `Test executed: ${JSON.stringify(args)}`;
    }
  }

  beforeEach(() => {
    expressMcp = new ExpressMcp(getTestExpressMcpOptions({ enableKnowledgeBase: false }));
    testTool = new TestTool();
  });

  describe('constructor', () => {
    it('should create ExpressMcp instance with empty tool registry when KB tools disabled', () => {
      assert.instanceOf(expressMcp, ExpressMcp);
      assert.strictEqual(expressMcp.getRegisteredToolCount(), 0);
    });

    it('should have tool registry property', () => {
      assert.exists(expressMcp.toolRegistry);
      assert.strictEqual(typeof expressMcp.toolRegistry.register, 'function');
    });

    it('should always have knowledge base instance', () => {
      assert.exists(expressMcp.getKnowledgeBase());
      assert.strictEqual(typeof expressMcp.getKnowledgeBase().addDocument, 'function');
    });

    it('should create ExpressMcp instance with knowledge base tools by default', () => {
      const defaultExpressMcp = new ExpressMcp(getTestExpressMcpOptions());
      assert.instanceOf(defaultExpressMcp, ExpressMcp);
      
      // Check for specific knowledge base tools
      assert.strictEqual(defaultExpressMcp.hasRegisteredTool('kb_search'), true);
      assert.strictEqual(defaultExpressMcp.hasRegisteredTool('kb_list'), true);
      assert.strictEqual(defaultExpressMcp.hasRegisteredTool('kb_get'), true);
      
      // Ensure register and manage tools are not exposed
      assert.strictEqual(defaultExpressMcp.hasRegisteredTool('kb_register'), false);
      assert.strictEqual(defaultExpressMcp.hasRegisteredTool('kb_manage'), false);
      
      assert.exists(defaultExpressMcp.getKnowledgeBase());
    });

    it('should have document management methods', () => {
      const defaultExpressMcp = new ExpressMcp(getTestExpressMcpOptions());
      assert.strictEqual(typeof defaultExpressMcp.addDocument, 'function');
      assert.strictEqual(typeof defaultExpressMcp.updateDocument, 'function');
      assert.strictEqual(typeof defaultExpressMcp.removeDocument, 'function');
      assert.strictEqual(typeof defaultExpressMcp.getKnowledgeBaseStats, 'function');
    });
  });

  describe('registerTool', () => {
    it('should register a tool', () => {
      expressMcp.registerTool(testTool);
      
      assert.strictEqual(expressMcp.getRegisteredToolCount(), 1);
      assert.isTrue(expressMcp.hasRegisteredTool('test-tool'));
    });

    it('should register multiple tools', () => {
      const tool1 = new TestTool('tool1', 'First tool');
      const tool2 = new TestTool('tool2', 'Second tool');
      
      expressMcp.registerTool(tool1);
      expressMcp.registerTool(tool2);
      
      assert.strictEqual(expressMcp.getRegisteredToolCount(), 2);
      assert.isTrue(expressMcp.hasRegisteredTool('tool1'));
      assert.isTrue(expressMcp.hasRegisteredTool('tool2'));
    });

    it('should throw error for invalid tool', () => {
      assert.throws(() => expressMcp.registerTool({}), 'Tool must have an execute method');
    });
  });

  describe('unregisterTool', () => {
    beforeEach(() => {
      expressMcp.registerTool(testTool);
    });

    it('should unregister existing tool', () => {
      expressMcp.unregisterTool('test-tool');
      
      assert.strictEqual(expressMcp.getRegisteredToolCount(), 0);
      assert.isFalse(expressMcp.hasRegisteredTool('test-tool'));
    });

    it('should handle unregistering non-existent tool', () => {
      expressMcp.unregisterTool('non-existent');
      
      assert.strictEqual(expressMcp.getRegisteredToolCount(), 1);
    });
  });

  describe('getRegisteredTools', () => {
    it('should return empty array when no tools registered', () => {
      const tools = expressMcp.getRegisteredTools();
      
      assert.isArray(tools);
      assert.isEmpty(tools);
    });

    it('should return all registered tools', () => {
      const tool1 = new TestTool('tool1');
      const tool2 = new TestTool('tool2');
      
      expressMcp.registerTool(tool1);
      expressMcp.registerTool(tool2);
      
      const tools = expressMcp.getRegisteredTools();
      assert.lengthOf(tools, 2);
      assert.include(tools, tool1);
      assert.include(tools, tool2);
    });
  });

  describe('hasRegisteredTool', () => {
    it('should return false for non-existent tool', () => {
      assert.isFalse(expressMcp.hasRegisteredTool('non-existent'));
    });

    it('should return true for registered tool', () => {
      expressMcp.registerTool(testTool);
      
      assert.isTrue(expressMcp.hasRegisteredTool('test-tool'));
    });
  });

  describe('getRegisteredToolCount', () => {
    it('should return 0 initially', () => {
      assert.strictEqual(expressMcp.getRegisteredToolCount(), 0);
    });

    it('should return correct count after registrations', () => {
      expressMcp.registerTool(new TestTool('tool1'));
      assert.strictEqual(expressMcp.getRegisteredToolCount(), 1);
      
      expressMcp.registerTool(new TestTool('tool2'));
      assert.strictEqual(expressMcp.getRegisteredToolCount(), 2);
    });
  });

  describe('clearRegisteredTools', () => {
    it('should clear all tools', () => {
      expressMcp.registerTool(new TestTool('tool1'));
      expressMcp.registerTool(new TestTool('tool2'));
      
      assert.strictEqual(expressMcp.getRegisteredToolCount(), 2);
      
      expressMcp.clearRegisteredTools();
      
      assert.strictEqual(expressMcp.getRegisteredToolCount(), 0);
    });
  });

  describe('router', () => {
    it('should return Express router', () => {
      const router = expressMcp.router();
      
      assert.exists(router);
      assert.strictEqual(typeof router, 'function');
      assert.strictEqual(router.name, 'router');
    });

    it('should return different router instances', () => {
      const router1 = expressMcp.router();
      const router2 = expressMcp.router();
      
      assert.notStrictEqual(router1, router2);
    });

    it('should create router with registered tools', () => {
      expressMcp.registerTool(testTool);
      
      const router = expressMcp.router();
      
      assert.exists(router);
      // Router should have the tool available when called
    });
  });

  describe('integration', () => {
    it('should maintain tool state across router creations', () => {
      expressMcp.registerTool(testTool);
      
      expressMcp.router();
      expressMcp.router();
      
      assert.strictEqual(expressMcp.getRegisteredToolCount(), 1);
      assert.isTrue(expressMcp.hasRegisteredTool('test-tool'));
    });

    it('should allow multiple ExpressMcp instances with separate tool registries', () => {
      const expressMcp1 = new ExpressMcp(getTestExpressMcpOptions({ enableKnowledgeBase: false }));
      const expressMcp2 = new ExpressMcp(getTestExpressMcpOptions({ enableKnowledgeBase: false }));
      
      expressMcp1.registerTool(new TestTool('tool1'));
      expressMcp2.registerTool(new TestTool('tool2'));
      
      assert.strictEqual(expressMcp1.getRegisteredToolCount(), 1);
      assert.strictEqual(expressMcp2.getRegisteredToolCount(), 1);
      
      assert.isTrue(expressMcp1.hasRegisteredTool('tool1'));
      assert.isFalse(expressMcp1.hasRegisteredTool('tool2'));
      
      assert.isFalse(expressMcp2.hasRegisteredTool('tool1'));
      assert.isTrue(expressMcp2.hasRegisteredTool('tool2'));
    });
  });

  describe('prefix functionality', () => {
    describe('constructor with prefix (name option)', () => {
      it('should create ExpressMcp with name and prefix KB tools', () => {
        const expressMcp = new ExpressMcp(getTestExpressMcpOptions({
          name: 'my-service',
          enableKnowledgeBase: true
        }));

        // KB tools should be prefixed
        const toolNames = expressMcp.getRegisteredTools().map(tool => tool.name);
        assert.include(toolNames, 'my-service_kb_search');
        assert.include(toolNames, 'my-service_kb_list');
        assert.include(toolNames, 'my-service_kb_get');
        
        // Original names should not exist as final names
        assert.notInclude(toolNames, 'kb_search');
        assert.notInclude(toolNames, 'kb_list');
        assert.notInclude(toolNames, 'kb_get');
      });

      it('should create ExpressMcp without name and not prefix KB tools', () => {
        const expressMcp = new ExpressMcp(getTestExpressMcpOptions({
          enableKnowledgeBase: true
        }));

        // KB tools should not be prefixed
        const toolNames = expressMcp.getRegisteredTools().map(tool => tool.name);
        assert.include(toolNames, 'kb_search');
        assert.include(toolNames, 'kb_list');
        assert.include(toolNames, 'kb_get');
        
        // Prefixed names should not exist
        assert.notInclude(toolNames, 'undefined_kb_search');
        assert.notInclude(toolNames, 'null_kb_search');
      });

      it('should handle complex service names', () => {
        const expressMcp = new ExpressMcp(getTestExpressMcpOptions({
          name: 'trust-admin-api-local-public',
          enableKnowledgeBase: true
        }));

        const toolNames = expressMcp.getRegisteredTools().map(tool => tool.name);
        assert.include(toolNames, 'trust-admin-api-local-public_kb_search');
        assert.include(toolNames, 'trust-admin-api-local-public_kb_list');
        assert.include(toolNames, 'trust-admin-api-local-public_kb_get');
      });

      it('should handle empty string name', () => {
        const expressMcp = new ExpressMcp(getTestExpressMcpOptions({
          name: '',
          enableKnowledgeBase: true
        }));

        // KB tools should not be prefixed with empty string
        const toolNames = expressMcp.getRegisteredTools().map(tool => tool.name);
        assert.include(toolNames, 'kb_search');
        assert.include(toolNames, 'kb_list');
        assert.include(toolNames, 'kb_get');
      });
    });

    describe('KB tools with disabled knowledge base', () => {
      it('should not register any KB tools when disabled, regardless of prefix', () => {
        const expressMcp = new ExpressMcp(getTestExpressMcpOptions({
          name: 'my-service',
          enableKnowledgeBase: false
        }));

        const toolNames = expressMcp.getRegisteredTools().map(tool => tool.name);
        assert.notInclude(toolNames, 'kb_search');
        assert.notInclude(toolNames, 'kb_list');
        assert.notInclude(toolNames, 'kb_get');
        assert.notInclude(toolNames, 'my-service_kb_search');
        assert.notInclude(toolNames, 'my-service_kb_list');
        assert.notInclude(toolNames, 'my-service_kb_get');
        
        assert.strictEqual(expressMcp.getRegisteredToolCount(), 0);
      });
    });

    describe('custom tool registration with prefix', () => {
      let expressMcp;

      beforeEach(() => {
        expressMcp = new ExpressMcp(getTestExpressMcpOptions({
          name: 'my-service',
          enableKnowledgeBase: true
        }));
      });

      it('should register custom tools without prefix by default', () => {
        const customTool = new TestTool('custom-tool');
        expressMcp.registerTool(customTool);

        assert.isTrue(expressMcp.hasRegisteredTool('custom-tool'));
        assert.isFalse(expressMcp.toolRegistry.hasTool('my-service_custom-tool'));
        
        const toolNames = expressMcp.getRegisteredTools().map(tool => tool.name);
        assert.include(toolNames, 'custom-tool');
        assert.notInclude(toolNames, 'my-service_custom-tool');
      });

      it('should allow manual prefix control via direct registry access', () => {
        const customTool = new TestTool('custom-tool');
        
        // Register with prefix using direct registry access
        expressMcp.toolRegistry.register(customTool, 'my-service');

        assert.isTrue(expressMcp.hasRegisteredTool('custom-tool')); // Should work with original name
        assert.isTrue(expressMcp.toolRegistry.hasTool('my-service_custom-tool')); // Should work with final name
        
        const toolNames = expressMcp.getRegisteredTools().map(tool => tool.name);
        assert.include(toolNames, 'my-service_custom-tool');
      });

      it('should unregister custom tools using original names', () => {
        const customTool = new TestTool('custom-tool');
        expressMcp.toolRegistry.register(customTool, 'my-service'); // With prefix
        
        assert.isTrue(expressMcp.hasRegisteredTool('custom-tool'));
        
        // Unregister using original name
        expressMcp.unregisterTool('custom-tool');
        
        assert.isFalse(expressMcp.hasRegisteredTool('custom-tool'));
        assert.isFalse(expressMcp.toolRegistry.hasTool('my-service_custom-tool'));
      });
    });

    describe('hasRegisteredTool with prefix', () => {
      let expressMcp;

      beforeEach(() => {
        expressMcp = new ExpressMcp(getTestExpressMcpOptions({
          name: 'my-service',
          enableKnowledgeBase: true
        }));
      });

      it('should find KB tools using original names', () => {
        assert.isTrue(expressMcp.hasRegisteredTool('kb_search'));
        assert.isTrue(expressMcp.hasRegisteredTool('kb_list'));
        assert.isTrue(expressMcp.hasRegisteredTool('kb_get'));
      });

      it('should find KB tools using prefixed names via direct registry access', () => {
        assert.isTrue(expressMcp.toolRegistry.hasTool('my-service_kb_search'));
        assert.isTrue(expressMcp.toolRegistry.hasTool('my-service_kb_list'));
        assert.isTrue(expressMcp.toolRegistry.hasTool('my-service_kb_get'));
      });

      it('should not find KB tools with incorrect prefix', () => {
        assert.isFalse(expressMcp.hasRegisteredTool('wrong-service_kb_search'));
        assert.isFalse(expressMcp.toolRegistry.hasTool('wrong-service_kb_search'));
      });
    });

    describe('unregisterTool with prefix', () => {
      let expressMcp;

      beforeEach(() => {
        expressMcp = new ExpressMcp(getTestExpressMcpOptions({
          name: 'my-service',
          enableKnowledgeBase: true
        }));
      });

      it('should unregister KB tools using original names', () => {
        assert.isTrue(expressMcp.hasRegisteredTool('kb_search'));
        
        expressMcp.unregisterTool('kb_search');
        
        assert.isFalse(expressMcp.hasRegisteredTool('kb_search'));
        assert.isFalse(expressMcp.toolRegistry.hasTool('my-service_kb_search'));
        
        // Other KB tools should still exist
        assert.isTrue(expressMcp.hasRegisteredTool('kb_list'));
        assert.isTrue(expressMcp.hasRegisteredTool('kb_get'));
      });

      it('should unregister KB tools using prefixed names via direct registry access', () => {
        assert.isTrue(expressMcp.toolRegistry.hasTool('my-service_kb_search'));
        
        expressMcp.toolRegistry.unregister('my-service_kb_search');
        
        assert.isFalse(expressMcp.hasRegisteredTool('kb_search'));
        assert.isFalse(expressMcp.toolRegistry.hasTool('my-service_kb_search'));
      });
    });

    describe('clearRegisteredTools with prefix', () => {
      let expressMcp;

      beforeEach(() => {
        expressMcp = new ExpressMcp(getTestExpressMcpOptions({
          name: 'my-service',
          enableKnowledgeBase: true
        }));
      });

      it('should clear all tools including prefixed KB tools', () => {
        const customTool = new TestTool('custom-tool');
        expressMcp.registerTool(customTool);
        expressMcp.toolRegistry.register(new TestTool('prefixed-tool'), 'my-service');
        
        const initialCount = expressMcp.getRegisteredToolCount();
        assert.isAbove(initialCount, 3); // At least 3 KB tools + 2 custom tools
        
        expressMcp.clearRegisteredTools();
        
        assert.strictEqual(expressMcp.getRegisteredToolCount(), 0);
        assert.isFalse(expressMcp.hasRegisteredTool('kb_search'));
        assert.isFalse(expressMcp.hasRegisteredTool('custom-tool'));
        assert.isFalse(expressMcp.toolRegistry.hasTool('my-service_kb_search'));
        assert.isFalse(expressMcp.toolRegistry.hasTool('my-service_prefixed-tool'));
      });
    });

    describe('integration scenarios', () => {
      it('should handle multiple ExpressMcp instances with different prefixes', () => {
        const service1 = new ExpressMcp(getTestExpressMcpOptions({
          name: 'service-1',
          enableKnowledgeBase: true
        }));
        
        const service2 = new ExpressMcp(getTestExpressMcpOptions({
          name: 'service-2',
          enableKnowledgeBase: true
        }));
        
        // Each should have its own prefixed KB tools
        assert.isTrue(service1.toolRegistry.hasTool('service-1_kb_search'));
        assert.isTrue(service2.toolRegistry.hasTool('service-2_kb_search'));
        
        // Should not interfere with each other
        assert.isFalse(service1.toolRegistry.hasTool('service-2_kb_search'));
        assert.isFalse(service2.toolRegistry.hasTool('service-1_kb_search'));
        
        // Both should be able to find their tools using original names
        assert.isTrue(service1.hasRegisteredTool('kb_search'));
        assert.isTrue(service2.hasRegisteredTool('kb_search'));
      });

      it('should maintain tool state consistency across operations', () => {
        const expressMcp = new ExpressMcp(getTestExpressMcpOptions({
          name: 'test-service',
          enableKnowledgeBase: true
        }));
        
        // Add custom tools with different prefix settings
        expressMcp.registerTool(new TestTool('normal-tool'));
        expressMcp.toolRegistry.register(new TestTool('prefixed-tool'), 'test-service');
        
        const initialCount = expressMcp.getRegisteredToolCount();
        
        // Remove one KB tool and one custom tool
        expressMcp.unregisterTool('kb_search');
        expressMcp.unregisterTool('normal-tool');
        
        assert.strictEqual(expressMcp.getRegisteredToolCount(), initialCount - 2);
        
        // Verify specific tools
        assert.isFalse(expressMcp.hasRegisteredTool('kb_search'));
        assert.isFalse(expressMcp.hasRegisteredTool('normal-tool'));
        assert.isTrue(expressMcp.hasRegisteredTool('kb_list')); // Should still exist
        assert.isTrue(expressMcp.hasRegisteredTool('prefixed-tool')); // Should still exist (via original name)
        assert.isTrue(expressMcp.toolRegistry.hasTool('test-service_prefixed-tool')); // Should still exist (via final name)
      });

      it('should work correctly with router creation', () => {
        const expressMcp = new ExpressMcp(getTestExpressMcpOptions({
          name: 'api-service',
          enableKnowledgeBase: true
        }));
        
        const router = expressMcp.router();
        assert.isDefined(router);
        
        // Router should be created with all tools including prefixed ones
        const toolCount = expressMcp.getRegisteredToolCount();
        assert.isAbove(toolCount, 0);
        
        // Should still be able to manage tools after router creation
        expressMcp.registerTool(new TestTool('new-tool'));
        assert.isTrue(expressMcp.hasRegisteredTool('new-tool'));
      });
    });

    describe('edge cases', () => {
      it('should handle service name that looks like a tool name', () => {
        const expressMcp = new ExpressMcp(getTestExpressMcpOptions({
          name: 'kb_search', // Same as a tool name
          enableKnowledgeBase: true
        }));
        
        // Should create kb_search_kb_search, kb_search_kb_list, etc.
        assert.isTrue(expressMcp.toolRegistry.hasTool('kb_search_kb_search'));
        assert.isTrue(expressMcp.toolRegistry.hasTool('kb_search_kb_list'));
        assert.isTrue(expressMcp.toolRegistry.hasTool('kb_search_kb_get'));
        
        // Original names should still work for lookup
        assert.isTrue(expressMcp.hasRegisteredTool('kb_search'));
        assert.isTrue(expressMcp.hasRegisteredTool('kb_list'));
        assert.isTrue(expressMcp.hasRegisteredTool('kb_get'));
      });

      it('should handle service name with special characters', () => {
        const expressMcp = new ExpressMcp(getTestExpressMcpOptions({
          name: 'my-service@v1.0',
          enableKnowledgeBase: true
        }));
        
        assert.isTrue(expressMcp.toolRegistry.hasTool('my-service@v1.0_kb_search'));
        assert.isTrue(expressMcp.hasRegisteredTool('kb_search'));
      });

      it('should handle very long service names', () => {
        const longName = 'a'.repeat(100); // 100 character service name
        const expressMcp = new ExpressMcp(getTestExpressMcpOptions({
          name: longName,
          enableKnowledgeBase: true
        }));
        
        assert.isTrue(expressMcp.toolRegistry.hasTool(`${longName}_kb_search`));
        assert.isTrue(expressMcp.hasRegisteredTool('kb_search'));
      });
    });
  });
});