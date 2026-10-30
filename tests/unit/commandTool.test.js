import { assert } from 'chai';
import { CommandTool } from '../../src/classes/commandTool.js';

class StatusCommandTool extends CommandTool {
  constructor (options = {}) {
    super('status', 'Status report', {
      type: 'object',
      properties: {},
      additionalProperties: false,
    }, options);
  }

  async execute () {
    return { equity: 1000 };
  }
}

describe('CommandTool', () => {
  describe('constructor', () => {
    it('defaults mode to direct and triggers to empty', () => {
      const tool = new StatusCommandTool();
      assert.strictEqual(tool.mode, 'direct');
      assert.deepStrictEqual(tool.triggers, []);
      assert.isNull(tool.match('status'));
    });

    it('rejects non-array triggers', () => {
      assert.throws(
        () => new StatusCommandTool({ triggers: 'status' }),
        /CommandTool triggers must be an array/,
      );
    });

    it('rejects invalid mode', () => {
      assert.throws(
        () => new StatusCommandTool({ mode: 'fast' }),
        /Invalid CommandTool mode/,
      );
    });

    it('rejects invalid toolNames', () => {
      assert.throws(
        () => new StatusCommandTool({ toolNames: 'echo' }),
        /toolNames must be an array of strings/,
      );
    });

    it('accepts toolNames array', () => {
      const tool = new StatusCommandTool({ toolNames: ['status', 'echo'] });
      assert.deepStrictEqual(tool.toolNames, ['status', 'echo']);
    });
  });

  describe('match', () => {
    it('matches exact string triggers case-insensitively and trims', () => {
      const tool = new StatusCommandTool({ triggers: ['status'] });
      const match = tool.match('  STATUS  ');
      assert.isNotNull(match);
      assert.strictEqual(match.mode, 'direct');
      assert.strictEqual(match.tool, tool);
      assert.strictEqual(match.historyUserText, 'STATUS');
      assert.deepStrictEqual(match.args, {});
    });

    it('matches RegExp with capture groups', () => {
      const tool = new StatusCommandTool({
        triggers: [/^audit\s+(\w+)$/i],
        mode: 'prompt',
        defaultArgs: (match) => ({ symbol: match[1] }),
        prompt: (match) => `Audit ${match[1]} carefully`,
        historyUserText: (match, text) => text,
      });
      const match = tool.match('audit balq');
      assert.isNotNull(match);
      assert.deepStrictEqual(match.args, { symbol: 'balq' });
      assert.strictEqual(match.prompt, 'Audit balq carefully');
      assert.strictEqual(match.historyUserText, 'audit balq');
    });

    it('resets lastIndex so /g triggers match every turn', () => {
      const tool = new StatusCommandTool({ triggers: [/^status$/gi] });
      assert.isNotNull(tool.match('status'));
      assert.isNotNull(tool.match('status'));
      assert.isNotNull(tool.match('STATUS'));
    });

    it('returns null for non-matching text', () => {
      const tool = new StatusCommandTool({ triggers: ['status'] });
      assert.isNull(tool.match('ping'));
      assert.isNull(tool.match(''));
      assert.isNull(tool.match(null));
    });

    it('evaluates static defaultArgs by shallow copy', () => {
      const defaults = { verbose: true };
      const tool = new StatusCommandTool({
        triggers: ['status'],
        defaultArgs: defaults,
      });
      const match = tool.match('status');
      assert.deepStrictEqual(match.args, { verbose: true });
      match.args.verbose = false;
      assert.strictEqual(defaults.verbose, true);
    });

    it('resolves ephemeralPrefix and historyUserText functions', () => {
      const tool = new StatusCommandTool({
        triggers: ['status'],
        ephemeralPrefix: () => 'CTX:\n',
        historyUserText: () => '/status',
      });
      const match = tool.match('status');
      assert.strictEqual(match.ephemeralPrefix, 'CTX:\n');
      assert.strictEqual(match.historyUserText, '/status');
    });
  });

  describe('formatResponse', () => {
    it('defaults to JSON stringify for objects', async () => {
      const tool = new StatusCommandTool({ triggers: ['status'] });
      const text = await tool.formatResponse({ equity: 42 });
      assert.strictEqual(text, '{\n  "equity": 42\n}');
    });

    it('supports async custom formatters', async () => {
      const tool = new StatusCommandTool({
        triggers: ['status'],
        formatResponse: async (result) => `Equity: ${result.equity}`,
      });
      const text = await tool.formatResponse({ equity: 1000 });
      assert.strictEqual(text, 'Equity: 1000');
    });
  });

  describe('prompt modes', () => {
    it('builds prompt-mode match without executing', () => {
      const tool = new StatusCommandTool({
        triggers: ['audit'],
        mode: 'prompt',
        prompt: 'Run a full audit using available tools.',
      });
      const match = tool.match('audit');
      assert.strictEqual(match.mode, 'prompt');
      assert.strictEqual(match.prompt, 'Run a full audit using available tools.');
    });

    it('hybrid match leaves prompt without data; agent re-evaluates later', () => {
      const tool = new StatusCommandTool({
        triggers: ['explain'],
        mode: 'hybrid',
        prompt: (match, text, data) => (
          data ? `Explain ${JSON.stringify(data)}` : `Explain ${text}`
        ),
      });
      const match = tool.match('explain');
      assert.strictEqual(match.mode, 'hybrid');
      assert.strictEqual(match.prompt, 'Explain explain');
    });
  });
});
