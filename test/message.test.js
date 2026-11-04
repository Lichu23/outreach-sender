import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { createEngine } from '../lib/engine.js';

test('real nodemailer builds a correct message, with no way to add recipients', async () => {
  const built = [];
  const stream = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  const transport = {
    sendMail: async (mail) => {
      const info = await stream.sendMail(mail);
      built.push({ raw: info.message.toString('utf8'), envelope: info.envelope });
    },
  };
  const store = {
    state: { campaign: null, sends: [], history: [], suppressed: [], sendLog: [] },
    save() {},
  };
  const engine = createEngine({
    store,
    transport,
    config: {
      dryRun: false, smtpReady: true, fromName: 'Test Sender', fromEmail: 'me@x.com',
      senderAddress: '', dailyLimit: 20, delayMs: 0, jitterMs: 1,
    },
  });

  engine.start({ subject: 'Pedidos\r\nBcc: evil@x.com', body: 'Hola, ¿cómo están?', category: 'Cafés', emails: ['ana@cafe.com'] });
  for (let i = 0; i < 200 && store.state.campaign.status !== 'done'; i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }

  assert.equal(built.length, 1);
  const { raw, envelope } = built[0];
  assert.deepEqual(envelope.to, ['ana@cafe.com']);
  assert.equal(envelope.from, 'me@x.com');
  assert.match(raw, /^To: ana@cafe\.com$/m);
  assert.match(raw, /^List-Unsubscribe: <mailto:me@x\.com\?subject=BAJA>$/m);
  assert.doesNotMatch(raw, /^Bcc:/mi);
  assert.doesNotMatch(raw, /^Content-Type: text\/html/m);
});
