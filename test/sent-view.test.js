import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, UserError } from '../lib/engine.js';

const base = {
  dryRun: false, smtpReady: true, fromName: 'Test Sender', fromEmail: 'me@x.com', senderAddress: '',
  dailyLimit: 50, delayMs: 0, jitterMs: 1,
};

function setup(overrides = {}, seed = {}) {
  const store = {
    state: { campaign: null, sends: [], history: [], suppressed: [], sendLog: [], ...seed },
    save() {},
  };
  const transport = {
    sendMail: async ({ to }) => { if (to.startsWith('fail')) throw new Error('mailbox not found'); },
  };
  return { store, engine: createEngine({ store, transport, config: { ...base, ...overrides } }) };
}

async function send(engine, store, category, emails) {
  engine.start({ subject: `Hola ${category}`, body: 'Mensaje', category, emails });
  for (let i = 0; i < 200 && store.state.campaign.status === 'running'; i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
  engine.clear();
}

test('a category is required', () => {
  const { engine } = setup();
  assert.throws(() => engine.start({ subject: 'a', body: 'b', category: '  ', emails: ['a@x.com'] }), /category/);
});

test('sends stay in the records after New send, and filter by category', async () => {
  const { engine, store } = setup();
  await send(engine, store, 'Cafés', ['a@x.com', 'b@x.com']);
  await send(engine, store, 'Dentists', ['c@x.com']);

  assert.equal(store.state.campaign, null);
  const all = engine.sentView();
  assert.equal(all.rows.length, 3);
  assert.deepEqual(all.categories.map((c) => [c.name, c.total]).sort(), [['Cafés', 2], ['Dentists', 1]]);

  const cafes = engine.sentView({ category: 'Cafés' });
  assert.deepEqual(cafes.rows.map((r) => r.email).sort(), ['a@x.com', 'b@x.com']);
  assert.equal(cafes.rows[0].subject, 'Hola Cafés');
  assert.equal(cafes.rows[0].body, 'Mensaje');
  assert.equal(cafes.categories.length, 2, 'category counts stay complete while filtered');
});

test('the no-repeat rule still works after a send is archived', async () => {
  const { engine, store } = setup();
  await send(engine, store, 'Cafés', ['a@x.com']);
  assert.equal(engine.isContacted('a@x.com'), true);
  assert.throws(() => engine.start({ subject: 'a', body: 'b', category: 'Cafés', emails: ['a@x.com'] }), UserError);
});

test('different spellings of a category stay one category', async () => {
  const { engine, store } = setup();
  await send(engine, store, 'cafes', ['a@x.com']);
  await send(engine, store, 'BARBERSHOPS', ['b@x.com']);
  await send(engine, store, 'Bakeries Rosario', ['c@x.com']);
  await send(engine, store, 'bakeries rosario', ['d@x.com']);

  const names = engine.sentView().categories.map((c) => c.name).sort();
  assert.deepEqual(names, ['Bakeries Rosario', 'Barbershops', 'Cafés']);
});

test('results count towards the category totals and can be cleared', async () => {
  const { engine, store } = setup();
  await send(engine, store, 'Cafés', ['a@x.com', 'b@x.com', 'c@x.com']);
  const [one, two, three] = engine.sentView().rows;

  engine.setResult({ sendId: one.sendId, email: one.email, result: 'interested' });
  engine.setResult({ sendId: two.sendId, email: two.email, result: 'not_now' });
  engine.setResult({ sendId: three.sendId, email: three.email, result: 'no_reply' });
  let cafes = engine.sentView().categories[0];
  assert.deepEqual([cafes.delivered, cafes.answered, cafes.interested], [3, 2, 1]);

  engine.setResult({ sendId: one.sendId, email: one.email, result: '' });
  cafes = engine.sentView().categories[0];
  assert.deepEqual([cafes.answered, cafes.interested], [1, 0]);
  assert.equal(engine.sentView().rows.find((r) => r.email === one.email).result, '');
});

test('rejects unknown results, unknown rows and results on failed emails', async () => {
  const { engine, store } = setup();
  await send(engine, store, 'Cafés', ['a@x.com', 'fail@x.com']);
  const rows = engine.sentView().rows;
  const good = rows.find((r) => r.status === 'sent');
  const failed = rows.find((r) => r.status === 'failed');

  assert.equal(failed.error, 'mailbox not found');
  assert.throws(() => engine.setResult({ sendId: good.sendId, email: good.email, result: '__proto__' }), /valid result/);
  assert.throws(() => engine.setResult({ sendId: 'nope', email: good.email, result: 'interested' }), /not found/);
  assert.throws(() => engine.setResult({ sendId: failed.sendId, email: failed.email, result: 'interested' }), /delivered/);
});

test('practice runs are kept apart from real sends', async () => {
  const practice = setup({ dryRun: true });
  await send(practice.engine, practice.store, 'Cafés', ['a@x.com']);
  assert.equal(practice.engine.sentView().rows.length, 0);
  assert.equal(practice.engine.sentView({ practice: true }).rows[0].status, 'simulated');
});

test('a send from the older version still loads, as Uncategorized', () => {
  const campaign = {
    subject: 'Viejo', body: 'x', status: 'done',
    recipients: [{ email: 'old@x.com', status: 'sent', sentAt: 1 }],
  };
  const { engine } = setup({}, { campaign });
  const [row] = engine.sentView().rows;
  assert.equal(row.category, 'Uncategorized');
  assert.ok(row.sendId);
});
