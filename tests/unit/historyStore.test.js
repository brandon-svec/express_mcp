import { assert } from 'chai';
import {
  InMemoryHistoryStore,
  formatTurnsTranscript,
} from '../../src/agents/historyStore.js';

describe('InMemoryHistoryStore', () => {
  it('throws for invalid windowMinutes', () => {
    assert.throws(() => new InMemoryHistoryStore({ windowMinutes: 0 }), /Invalid history windowMinutes/);
    assert.throws(() => new InMemoryHistoryStore({}), /Invalid history windowMinutes/);
  });

  it('throws for invalid maxTurns', () => {
    assert.throws(
      () => new InMemoryHistoryStore({ windowMinutes: 60, maxTurns: 0 }),
      /Invalid history maxTurns/,
    );
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

  it('evicts oldest turns when maxTurns is exceeded', () => {
    const store = new InMemoryHistoryStore({ windowMinutes: 60, maxTurns: 2 });
    store.append('k', [{ role: 'user', parts: [{ text: 'one' }] }]);
    store.append('k', [{ role: 'user', parts: [{ text: 'two' }] }]);
    store.append('k', [{ role: 'user', parts: [{ text: 'three' }] }]);
    store.append('k', [{ role: 'user', parts: [{ text: 'four' }] }]);

    assert.deepStrictEqual(store.get('k'), [
      { role: 'user', parts: [{ text: 'three' }] },
      { role: 'user', parts: [{ text: 'four' }] },
    ]);
  });

  it('get throws for empty key', () => {
    const store = new InMemoryHistoryStore({ windowMinutes: 60 });
    assert.throws(() => store.get(''), /history key is required/);
  });

  it('append throws for empty key', () => {
    const store = new InMemoryHistoryStore({ windowMinutes: 60 });
    assert.throws(
      () => store.append('', [{ role: 'user', parts: [{ text: 'x' }] }]),
      /history key is required/,
    );
  });

  it('append throws when contents is not an array', () => {
    const store = new InMemoryHistoryStore({ windowMinutes: 60 });
    assert.throws(() => store.append('k', 'not-array'), /contents must be an array/);
  });

  it('clear throws for empty key', () => {
    const store = new InMemoryHistoryStore({ windowMinutes: 60 });
    assert.throws(() => store.clear(''), /history key is required/);
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

  it('getTurns returns pruned turns with timestamps', () => {
    const store = new InMemoryHistoryStore({ windowMinutes: 60, maxTurns: 2 });
    const now = Date.now();
    const t1 = new Date(now - 3 * 60 * 1000);
    const t2 = new Date(now - 2 * 60 * 1000);
    const t3 = new Date(now - 1 * 60 * 1000);
    store.append('k', [{ role: 'user', parts: [{ text: 'one' }] }], { recordedAt: t1 });
    store.append('k', [{ role: 'user', parts: [{ text: 'two' }] }], { recordedAt: t2 });
    store.append('k', [{ role: 'user', parts: [{ text: 'three' }] }], { recordedAt: t3 });

    assert.deepStrictEqual(store.getTurns('k'), [
      {
        recordedAt: new Date(t2.getTime()),
        contents: [{ role: 'user', parts: [{ text: 'two' }] }],
      },
      {
        recordedAt: new Date(t3.getTime()),
        contents: [{ role: 'user', parts: [{ text: 'three' }] }],
      },
    ]);
  });

  it('getTurns prunes turns older than the window', () => {
    const store = new InMemoryHistoryStore({ windowMinutes: 1 });
    const oldDate = new Date(Date.now() - 2 * 60 * 1000);
    store.append('k', [{ role: 'user', parts: [{ text: 'stale' }] }], { recordedAt: oldDate });
    const beforeFresh = Date.now();
    store.append('k', [{ role: 'user', parts: [{ text: 'fresh' }] }]);
    const afterFresh = Date.now();

    const turns = store.getTurns('k');
    assert.deepStrictEqual(turns.map((turn) => turn.contents), [
      [{ role: 'user', parts: [{ text: 'fresh' }] }],
    ]);
    assert.isAtLeast(turns[0].recordedAt.getTime(), beforeFresh);
    assert.isAtMost(turns[0].recordedAt.getTime(), afterFresh);
  });

  it('getTurns returns detached copies so reverse does not mutate store', () => {
    const store = new InMemoryHistoryStore({ windowMinutes: 60 });
    const t1 = new Date(Date.now() - 2 * 60 * 1000);
    const t2 = new Date(Date.now() - 60 * 1000);
    store.append('k', [{ role: 'user', parts: [{ text: 'one' }] }], { recordedAt: t1 });
    store.append('k', [{ role: 'user', parts: [{ text: 'two' }] }], { recordedAt: t2 });

    const copy = store.getTurns('k');
    copy.reverse();
    copy[0].contents.push({ role: 'model', parts: [{ text: 'mutated' }] });

    assert.deepStrictEqual(store.getTurns('k'), [
      {
        recordedAt: new Date(t1.getTime()),
        contents: [{ role: 'user', parts: [{ text: 'one' }] }],
      },
      {
        recordedAt: new Date(t2.getTime()),
        contents: [{ role: 'user', parts: [{ text: 'two' }] }],
      },
    ]);
  });

  it('getTurns throws for empty key', () => {
    const store = new InMemoryHistoryStore({ windowMinutes: 60 });
    assert.throws(() => store.getTurns(''), /history key is required/);
  });

  it('append accepts recordedAt as Date or epoch millis', () => {
    const store = new InMemoryHistoryStore({ windowMinutes: 60 });
    const asDate = new Date(Date.now() - 2 * 60 * 1000);
    const asMillis = Date.now() - 60 * 1000;
    store.append('k', [{ role: 'user', parts: [{ text: 'date' }] }], { recordedAt: asDate });
    store.append('k', [{ role: 'user', parts: [{ text: 'millis' }] }], { recordedAt: asMillis });

    assert.deepStrictEqual(store.getTurns('k'), [
      {
        recordedAt: new Date(asDate.getTime()),
        contents: [{ role: 'user', parts: [{ text: 'date' }] }],
      },
      {
        recordedAt: new Date(asMillis),
        contents: [{ role: 'user', parts: [{ text: 'millis' }] }],
      },
    ]);
  });

  it('append defaults recordedAt to now', () => {
    const store = new InMemoryHistoryStore({ windowMinutes: 60 });
    const before = Date.now();
    store.append('k', [{ role: 'user', parts: [{ text: 'now' }] }]);
    const after = Date.now();
    const turns = store.getTurns('k');
    assert.deepStrictEqual(turns.map((turn) => turn.contents), [
      [{ role: 'user', parts: [{ text: 'now' }] }],
    ]);
    assert.isAtLeast(turns[0].recordedAt.getTime(), before);
    assert.isAtMost(turns[0].recordedAt.getTime(), after);
  });

  it('append throws for invalid recordedAt', () => {
    const store = new InMemoryHistoryStore({ windowMinutes: 60 });
    const contents = [{ role: 'user', parts: [{ text: 'x' }] }];
    assert.throws(
      () => store.append('k', contents, { recordedAt: 'nope' }),
      /recordedAt must be a valid Date or timestamp/,
    );
    assert.throws(
      () => store.append('k', contents, { recordedAt: new Date(NaN) }),
      /recordedAt must be a valid Date or timestamp/,
    );
    assert.throws(
      () => store.append('k', contents, { recordedAt: Number.NaN }),
      /recordedAt must be a valid Date or timestamp/,
    );
  });

  it('get still returns flattened contents without recordedAt', () => {
    const store = new InMemoryHistoryStore({ windowMinutes: 60 });
    const recordedAt = new Date(Date.now() - 30 * 1000);
    store.append('k', [{ role: 'user', parts: [{ text: 'hello' }] }], { recordedAt });

    assert.deepStrictEqual(store.get('k'), [
      { role: 'user', parts: [{ text: 'hello' }] },
    ]);
  });
});

describe('formatTurnsTranscript', () => {
  it('renders newest-first with reversed contents and skips HOST_TOOLS', () => {
    const now = new Date('2026-10-19T12:00:10.000Z');
    const prior = new Date('2026-10-19T12:00:05.000Z');
    const turns = [
      {
        recordedAt: prior,
        contents: [
          { role: 'user', parts: [{ text: 'I am in St Pete' }] },
          {
            role: 'model',
            parts: [
              { text: 'HOST_TOOLS: [{"tool":"echo"}]' },
              { text: 'Set location to St Pete.' },
            ],
          },
        ],
      },
      {
        recordedAt: now,
        contents: [
          { role: 'user', parts: [{ text: 'I got pizza' }] },
        ],
      },
    ];

    assert.deepStrictEqual(
      formatTurnsTranscript(turns, {
        now,
        userLabel: 'User',
        modelLabel: 'Gillium',
      }),
      [
        '0, User, I got pizza',
        '-5, Gillium, Set location to St Pete.',
        '-5, User, I am in St Pete',
      ].join('\n'),
    );
  });

  it('skips non-text parts', () => {
    const now = new Date('2026-10-19T12:00:00.000Z');
    assert.deepStrictEqual(
      formatTurnsTranscript([
        {
          recordedAt: now,
          contents: [
            { role: 'user', parts: [{ functionCall: { name: 'echo', args: {} } }] },
            { role: 'model', parts: [{ text: 'done' }] },
          ],
        },
      ], { now }),
      '0, Model, done',
    );
  });
});
