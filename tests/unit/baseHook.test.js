import { assert } from 'chai';
import {
  BaseHook,
  HookBlockedError,
  HOOK_EVENTS,
  BLOCKING_HOOK_EVENTS,
  HOOK_EXIT_CODES
} from '../../src/classes/baseHook.js';

class TestHook extends BaseHook {
  constructor(name, events, options = {}) {
    super(name, events, options);
    this.calls = [];
  }

  async execute(event, context) {
    this.calls.push({ event, context });
    return this.allow();
  }
}

describe('BaseHook', () => {
  describe('constants', () => {
    it('exports HOOK_EVENTS', () => {
      assert.deepStrictEqual([...HOOK_EVENTS], [
        'SessionStart',
        'UserPromptSubmit',
        'PreToolUse',
        'PermissionRequest',
        'PostToolUse',
        'Stop'
      ]);
    });

    it('exports BLOCKING_HOOK_EVENTS', () => {
      assert.isTrue(BLOCKING_HOOK_EVENTS.has('UserPromptSubmit'));
      assert.isTrue(BLOCKING_HOOK_EVENTS.has('PreToolUse'));
      assert.isTrue(BLOCKING_HOOK_EVENTS.has('PermissionRequest'));
      assert.isTrue(BLOCKING_HOOK_EVENTS.has('Stop'));
      assert.isFalse(BLOCKING_HOOK_EVENTS.has('SessionStart'));
      assert.isFalse(BLOCKING_HOOK_EVENTS.has('PostToolUse'));
    });

    it('exports HOOK_EXIT_CODES', () => {
      assert.strictEqual(HOOK_EXIT_CODES.SUCCESS, 0);
      assert.strictEqual(HOOK_EXIT_CODES.WARNING, 1);
      assert.strictEqual(HOOK_EXIT_CODES.BLOCKING_ERROR, 2);
    });
  });

  describe('constructor', () => {
    it('creates hook with name and single event', () => {
      const hook = new TestHook('my-hook', 'PreToolUse');
      assert.strictEqual(hook.name, 'my-hook');
      assert.deepStrictEqual([...hook.events], ['PreToolUse']);
      assert.isFalse(hook.failClosed);
    });

    it('accepts multiple events and options', () => {
      const hook = new TestHook('h', ['PreToolUse', 'PostToolUse'], {
        description: 'test',
        matcher: 'hello',
        failClosed: true
      });
      assert.deepStrictEqual([...hook.events], ['PreToolUse', 'PostToolUse']);
      assert.strictEqual(hook.description, 'test');
      assert.strictEqual(hook.matcher, 'hello');
      assert.isTrue(hook.failClosed);
    });

    it('throws for missing name', () => {
      assert.throws(() => new TestHook('', 'PreToolUse'), /Hook name is required/);
      assert.throws(() => new TestHook(null, 'PreToolUse'), /Hook name is required/);
    });

    it('throws for invalid event names', () => {
      assert.throws(
        () => new TestHook('h', 'NotAnEvent'),
        /Invalid hook event/
      );
    });

    it('throws for empty events', () => {
      assert.throws(() => new TestHook('h', []), /at least one event/);
    });

    it('accepts matcher as string, RegExp, or string[]', () => {
      assert.doesNotThrow(() => new TestHook('a', 'PreToolUse', { matcher: 'tool' }));
      assert.doesNotThrow(() => new TestHook('b', 'PreToolUse', { matcher: /^tool/ }));
      assert.doesNotThrow(() => new TestHook('c', 'PreToolUse', { matcher: ['a', 'b'] }));
    });

    it('throws for invalid matcher', () => {
      assert.throws(
        () => new TestHook('h', 'PreToolUse', { matcher: 123 }),
        /matcher must be/
      );
      assert.throws(
        () => new TestHook('h', 'PreToolUse', { matcher: [] }),
        /matcher must be/
      );
    });
  });

  describe('matches', () => {
    it('matches subscribed events without matcher', () => {
      const hook = new TestHook('h', 'SessionStart');
      assert.isTrue(hook.matches({ hook_event_name: 'SessionStart' }));
      assert.isFalse(hook.matches({ hook_event_name: 'PreToolUse' }));
    });

    it('ignores matcher when event has no tool_name', () => {
      const hook = new TestHook('h', 'UserPromptSubmit', { matcher: 'only-this' });
      assert.isTrue(hook.matches({
        hook_event_name: 'UserPromptSubmit',
        user_prompt: 'hi'
      }));
    });

    it('filters by string matcher', () => {
      const hook = new TestHook('h', 'PreToolUse', { matcher: 'hello' });
      assert.isTrue(hook.matches({ hook_event_name: 'PreToolUse', tool_name: 'hello' }));
      assert.isFalse(hook.matches({ hook_event_name: 'PreToolUse', tool_name: 'other' }));
    });

    it('filters by RegExp matcher', () => {
      const hook = new TestHook('h', 'PreToolUse', { matcher: /^del/ });
      assert.isTrue(hook.matches({ hook_event_name: 'PreToolUse', tool_name: 'delete' }));
      assert.isFalse(hook.matches({ hook_event_name: 'PreToolUse', tool_name: 'create' }));
    });

    it('filters by string[] matcher', () => {
      const hook = new TestHook('h', 'PreToolUse', { matcher: ['a', 'b'] });
      assert.isTrue(hook.matches({ hook_event_name: 'PreToolUse', tool_name: 'a' }));
      assert.isFalse(hook.matches({ hook_event_name: 'PreToolUse', tool_name: 'c' }));
    });
  });

  describe('helpers', () => {
    const hook = new TestHook('h', 'PreToolUse');

    it('allow', () => {
      assert.deepStrictEqual(hook.allow({ additionalContext: 'x' }), {
        exitCode: 0,
        decision: 'allow',
        additionalContext: 'x'
      });
    });

    it('modify', () => {
      assert.deepStrictEqual(hook.modify({ a: 1 }), {
        exitCode: 0,
        decision: 'modify',
        updatedInput: { a: 1 }
      });
    });

    it('deny', () => {
      assert.deepStrictEqual(hook.deny('nope'), {
        exitCode: 2,
        decision: 'deny',
        stderr: 'nope'
      });
    });

    it('warn', () => {
      assert.deepStrictEqual(hook.warn('careful'), {
        exitCode: 1,
        stderr: 'careful'
      });
    });
  });

  describe('execute', () => {
    it('base class throws if not overridden', async () => {
      const hook = new BaseHook('h', 'PreToolUse');
      try {
        await hook.execute({}, {});
        assert.fail('expected throw');
      } catch (error) {
        assert.match(error.message, /must be implemented/);
      }
    });
  });

  describe('HookBlockedError', () => {
    it('carries hook metadata', () => {
      const err = new HookBlockedError('blocked', {
        hookEvent: 'Stop',
        stderr: 'bad',
        additionalContext: 'ctx',
        userMessage: 'msg'
      });
      assert.strictEqual(err.name, 'HookBlockedError');
      assert.strictEqual(err.hookEvent, 'Stop');
      assert.strictEqual(err.exitCode, 2);
      assert.strictEqual(err.stderr, 'bad');
      assert.strictEqual(err.additionalContext, 'ctx');
      assert.strictEqual(err.userMessage, 'msg');
    });
  });
});
