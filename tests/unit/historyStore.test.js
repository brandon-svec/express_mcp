import { assert } from 'chai';
import { InMemoryHistoryStore } from '../../src/agents/historyStore.js';

describe('InMemoryHistoryStore', () => {
  it('throws for invalid windowMinutes', () => {
    assert.throws(() => new InMemoryHistoryStore({ windowMinutes: 0 }), /Invalid history windowMinutes/);
    assert.throws(() => new InMemoryHistoryStore({}), /Invalid history windowMinutes/);
  });

  it('isolates history by key', () => {
    const store = new InMemoryHistoryStore({ windowMinutes: 60 });
    store.append('a', [{ role: 'user', parts: [{ text: 'hello a' }] }]);
    store.append('b', [{ role: 'user', parts: [{ text: 'hello b' }] }]);

    const aHistory = store.get('a');
    const bHistory = store.get('b');

    assert.strictEqual(aHistory.length, 1);
    assert.strictEqual(aHistory[0].parts[0].text, 'hello a');
    assert.strictEqual(bHistory.length, 1);
    assert.strictEqual(bHistory[0].parts[0].text, 'hello b');
  });

  it('prunes turns older than the window', () => {
    const store = new InMemoryHistoryStore({ windowMinutes: 1 });
    const oldDate = new Date(Date.now() - 2 * 60 * 1000);
    store.turnsByKey.set('k', [{
      recordedAt: oldDate,
      contents: [{ role: 'user', parts: [{ text: 'stale' }] }],
    }]);
    store.append('k', [{ role: 'user', parts: [{ text: 'fresh' }] }]);

    const history = store.get('k');
    assert.strictEqual(history.length, 1);
    assert.strictEqual(history[0].parts[0].text, 'fresh');
  });

  it('clear removes one key or all keys', () => {
    const store = new InMemoryHistoryStore({ windowMinutes: 60 });
    store.append('a', [{ role: 'user', parts: [{ text: 'a' }] }]);
    store.append('b', [{ role: 'user', parts: [{ text: 'b' }] }]);

    store.clear('a');
    assert.isEmpty(store.get('a'));
    assert.strictEqual(store.get('b').length, 1);

    store.clear();
    assert.isEmpty(store.get('b'));
  });
});
