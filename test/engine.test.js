import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, UserError } from '../lib/engine.js';

const base = {
  dryRun: false, smtpReady: true, fromName: 'Test Sender', fromEmail: 'me@x.com', senderAddress: '',
  dailyLimit: 20, delayMs: 0, jitterMs: 1,
};

function setup(overrides = {}, seed = {}, send = async () => {}) {
  const sent = [];
  const store = {
    state: { campaign: null, sends: [], history: [], suppressed: [], sendLog: [], ...seed },
    saves: 0,
    save() { this.saves += 1; },
  };
  const transport = { sendMail: async (mail) => { await send(mail); sent.push(mail); } };
  const engine = createEngine({ store, transport, config: { ...base, ...overrides } });
  return { engine, store, sent };
}

const message = { subject: 'Hola', body: 'Mensaje', category: 'Cafés' };

async function until(check) {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
  assert.fail('condition was never met');
}

test('sends each person one separate email with the opt-out footer', async () => {
  const { engine, store, sent } = setup();
  engine.start({ ...message, emails: ['a@x.com', 'b@x.com'] });
  await until(() => store.state.campaign.status === 'done');

  assert.deepEqual(sent.map((m) => m.to), ['a@x.com', 'b@x.com']);
  assert.match(sent[0].text, /BAJA/);
  assert.equal(sent[0].bcc, undefined);
  assert.equal(store.state.history.length, 2);
});

test('practice mode never touches the transport or the sent history', async () => {
  const { engine, store, sent } = setup({ dryRun: true });
  engine.start({ ...message, emails: ['a@x.com'] });
  await until(() => store.state.campaign.status === 'done');

  assert.equal(sent.length, 0);
  assert.equal(store.state.campaign.recipients[0].status, 'simulated');
  assert.equal(store.state.history.length, 0);
});

test('never re-sends to contacted or blocked people', () => {
  const { engine } = setup({}, { history: [{ email: 'old@x.com', at: 1 }], suppressed: ['no@x.com'] });
  assert.throws(() => engine.start({ ...message, emails: ['old@x.com', 'no@x.com'] }), UserError);
});

test('stops at the daily limit', async () => {
  const { engine, store, sent } = setup({ dailyLimit: 2 });
  engine.start({ ...message, emails: ['a@x.com', 'b@x.com', 'c@x.com'] });
  await until(() => store.state.campaign.notice?.includes('Daily limit'));

  assert.equal(sent.length, 2);
  assert.equal(store.state.campaign.recipients[2].status, 'pending');
  engine.cancel();
});

test('pauses immediately when the login is rejected', async () => {
  const fail = async () => { throw Object.assign(new Error('bad login'), { code: 'EAUTH' }); };
  const { engine, store } = setup({}, {}, fail);
  engine.start({ ...message, emails: ['a@x.com', 'b@x.com'] });
  await until(() => store.state.campaign.status === 'paused');

  assert.equal(store.state.campaign.recipients[0].status, 'failed');
  assert.equal(store.state.campaign.recipients[1].status, 'pending');
  engine.cancel();
});

test('pauses after three failures in a row', async () => {
  const fail = async () => { throw new Error('rejected'); };
  const { engine, store } = setup({}, {}, fail);
  engine.start({ ...message, emails: ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com'] });
  await until(() => store.state.campaign.status === 'paused');

  assert.equal(store.state.campaign.recipients[3].status, 'pending');
  engine.cancel();
});

test('a restart pauses the send and never re-sends an interrupted email', () => {
  const campaign = {
    ...message, status: 'running',
    recipients: [{ email: 'a@x.com', status: 'sending' }, { email: 'b@x.com', status: 'pending' }],
  };
  const { store } = setup({}, { campaign });

  assert.equal(store.state.campaign.status, 'paused');
  assert.equal(campaign.recipients[0].status, 'failed');
  assert.ok(store.state.history.some((h) => h.email === 'a@x.com'));
});

test('cancel stops everything still waiting', async () => {
  const { engine, store } = setup({ delayMs: 60_000 });
  engine.start({ ...message, emails: ['a@x.com', 'b@x.com'] });
  await until(() => store.state.campaign.recipients[0].status === 'sent');
  engine.cancel();

  assert.equal(store.state.campaign.recipients[1].status, 'cancelled');
});

test('rejects a second send while one is running, and header injection in the subject', async () => {
  const { engine, store, sent } = setup({ delayMs: 60_000 });
  engine.start({ ...message, subject: 'Hola\r\nBcc: evil@x.com', body: 'x', emails: ['a@x.com', 'b@x.com'] });
  await until(() => sent.length === 1);

  assert.equal(sent[0].subject, 'Hola Bcc: evil@x.com');
  assert.throws(() => engine.start({ ...message, emails: ['c@x.com'] }), /already in progress/);
  engine.cancel();
  assert.equal(store.state.campaign.status, 'cancelled');
});

test('refuses to send for real without email settings', () => {
  const { engine } = setup({ smtpReady: false });
  assert.throws(() => engine.start({ ...message, emails: ['a@x.com'] }), /incomplete/);
});
