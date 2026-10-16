import { assert } from 'chai';
import { BaseHook } from '../../src/classes/baseHook.js';
import { HookRegistry } from '../../src/classes/hookRegistry.js';

class ScriptedHook extends BaseHook {
  /**
   * @param {string} name
   * @param {string|string[]} events
   * @param {Object} [options]
   * @param {(event: Object, context: Object) => Promise<*>|*} [options.handler]
   */
  constructor(name, events, options = {}) {
    super(name, events, options);
    this.handler = options.handler || (() => this.allow());
    this.calls = [];
  }

  async execute(event, context) {
    this.calls.push({ event: structuredClone(event), context });
    return this.handler(event, context);
  }
}

describe('HookRegistry', () => {
  let registry;

  beforeEach(() => {
    registry = new HookRegistry();
  });

  describe('registration', () => {
    it('registers and retrieves hooks', () => {
      const hook = new ScriptedHook('a', 'PreToolUse');
      registry.register(hook);
      assert.strictEqual(registry.getHookCount(), 1);
      assert.isTrue(registry.hasHook('a'));
      assert.strictEqual(registry.getHooks('PreToolUse')[0], hook);
    });

    it('throws on duplicate name', () => {
      registry.register(new ScriptedHook('a', 'PreToolUse'));
      assert.throws(
        () => registry.register(new ScriptedHook('a', 'PostToolUse')),
        /already registered/
      );
    });

    it('unregisters and clears', () => {
      registry.register(new ScriptedHook('a', 'PreToolUse'));
      assert.isTrue(registry.unregister('a'));
      assert.strictEqual(registry.getHookCount(), 0);
      registry.register(new ScriptedHook('b', 'PreToolUse'));
      registry.clear();
      assert.strictEqual(registry.getHookCount(), 0);
      assert.isEmpty(registry.getAllHooks());
    });

    it('throws for invalid hook', () => {
      assert.throws(() => registry.register({}), /execute method/);
      assert.throws(() => registry.register({ name: 'x', execute: () => {} }), /at least one event/);
    });
  });

  describe('buildEventPayload', () => {
    it('builds a normalized envelope', () => {
      const payload = registry.buildEventPayload('PreToolUse', {
        session_id: 's1',
        tool_name: 'hello',
        tool_input: { a: 1 },
        tool_annotations: { readOnlyHint: true },
        meta: { traceparent: 'tp', turn_index: 2 }
      });
      assert.strictEqual(payload.hook_event_name, 'PreToolUse');
      assert.strictEqual(payload.session_id, 's1');
      assert.strictEqual(payload.permission_mode, 'default');
      assert.strictEqual(payload.tool_name, 'hello');
      assert.deepStrictEqual(payload.tool_input, { a: 1 });
      assert.deepStrictEqual(payload.tool_annotations, { readOnlyHint: true });
      assert.strictEqual(payload.meta.traceparent, 'tp');
      assert.strictEqual(payload.meta.turn_index, 2);
      assert.isString(payload.timestamp);
    });
  });

  describe('runHooks', () => {
    it('runs hooks in registration order and chains updatedInput', async () => {
      const first = new ScriptedHook('first', 'PreToolUse', {
        handler: (event) => ({
          exitCode: 0,
          decision: 'modify',
          updatedInput: { ...event.tool_input, step: 1 },
          additionalContext: 'from-first'
        })
      });
      const second = new ScriptedHook('second', 'PreToolUse', {
        handler: (event) => ({
          exitCode: 0,
          decision: 'modify',
          updatedInput: { ...event.tool_input, step: 2 },
          additionalContext: 'from-second'
        })
      });
      registry.register(first);
      registry.register(second);

      const result = await registry.runHooks('PreToolUse', {
        tool_name: 't',
        tool_input: { n: 0 }
      });

      assert.isFalse(result.blocked);
      assert.strictEqual(result.decision, 'modify');
      assert.deepStrictEqual(result.updatedInput, { n: 0, step: 2 });
      assert.strictEqual(result.additionalContext, 'from-first\nfrom-second');
      assert.deepStrictEqual(second.calls[0].event.tool_input, { n: 0, step: 1 });
    });

    it('chains user_prompt for UserPromptSubmit', async () => {
      registry.register(new ScriptedHook('m1', 'UserPromptSubmit', {
        handler: () => ({
          exitCode: 0,
          decision: 'modify',
          updatedInput: 'rewritten'
        })
      }));
      const second = new ScriptedHook('m2', 'UserPromptSubmit', {
        handler: (event) => {
          assert.strictEqual(event.user_prompt, 'rewritten');
          return { exitCode: 0, decision: 'allow' };
        }
      });
      registry.register(second);

      const result = await registry.runHooks('UserPromptSubmit', {
        user_prompt: 'original'
      });
      assert.strictEqual(result.updatedInput, 'rewritten');
    });

    it('blocks on deny for blocking events', async () => {
      registry.register(new ScriptedHook('ok', 'PreToolUse', {
        handler: function handler() { return this.allow({ additionalContext: 'before' }); }
      }));
      registry.register(new ScriptedHook('deny', 'PreToolUse', {
        handler: function handler() { return this.deny('nope'); }
      }));
      registry.register(new ScriptedHook('after', 'PreToolUse', {
        handler: function handler() { return this.allow(); }
      }));

      const result = await registry.runHooks('PreToolUse', { tool_name: 't', tool_input: {} });
      assert.isTrue(result.blocked);
      assert.strictEqual(result.decision, 'deny');
      assert.strictEqual(result.stderr, 'nope');
      assert.strictEqual(result.additionalContext, 'before');
      assert.strictEqual(registry.getHooks('PreToolUse')[2].calls.length, 0);
    });

    it('does not halt non-blocking events on deny', async () => {
      registry.register(new ScriptedHook('warnish', 'PostToolUse', {
        handler: function handler() {
          return this.deny('ignored-as-block');
        }
      }));
      registry.register(new ScriptedHook('cont', 'PostToolUse', {
        handler: function handler() {
          return this.allow({ additionalContext: 'after' });
        }
      }));

      const result = await registry.runHooks('PostToolUse', {
        tool_name: 't',
        tool_result: 'ok'
      });
      assert.isFalse(result.blocked);
      assert.strictEqual(result.additionalContext, 'after');
    });

    it('fails open on unexpected throw by default', async () => {
      const warnings = [];
      registry = new HookRegistry({
        logger: { warn: (obj, msg) => warnings.push({ obj, msg }) }
      });
      registry.register(new ScriptedHook('boom', 'PreToolUse', {
        handler: async () => { throw new Error('unexpected'); }
      }));
      registry.register(new ScriptedHook('ok', 'PreToolUse', {
        handler: function handler() { return this.allow({ additionalContext: 'ok' }); }
      }));

      const result = await registry.runHooks('PreToolUse', { tool_name: 't', tool_input: {} });
      assert.isFalse(result.blocked);
      assert.strictEqual(result.additionalContext, 'ok');
      assert.lengthOf(warnings, 1);
    });

    it('failClosed blocks on unexpected throw for blocking events', async () => {
      registry = new HookRegistry({ logger: { warn: () => {} } });
      registry.register(new ScriptedHook('boom', 'PreToolUse', {
        failClosed: true,
        handler: async () => { throw new Error('hard fail'); }
      }));

      const result = await registry.runHooks('PreToolUse', { tool_name: 't', tool_input: {} });
      assert.isTrue(result.blocked);
      assert.strictEqual(result.stderr, 'hard fail');
    });

    it('treats string return as additionalContext', async () => {
      registry.register(new ScriptedHook('s', 'SessionStart', {
        handler: () => 'hello context'
      }));
      const result = await registry.runHooks('SessionStart', {});
      assert.strictEqual(result.additionalContext, 'hello context');
      assert.isFalse(result.blocked);
    });

    it('skips non-matching matcher', async () => {
      const hook = new ScriptedHook('m', 'PreToolUse', {
        matcher: 'only-me',
        handler: function handler() { return this.deny('should not run'); }
      });
      registry.register(hook);
      const result = await registry.runHooks('PreToolUse', {
        tool_name: 'other',
        tool_input: {}
      });
      assert.isFalse(result.blocked);
      assert.lengthOf(hook.calls, 0);
    });
  });
});
