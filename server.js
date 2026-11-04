import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
import { createEngine, UserError } from './lib/engine.js';
import { parseEmails } from './lib/parse-emails.js';
import { createStore } from './lib/store.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 4310;
const MAX_BODY_BYTES = 256_000;
const MAX_DAILY_LIMIT = 50;
const MIN_REAL_DELAY_SECONDS = 30;

const env = process.env;
const dryRun = env.DRY_RUN !== 'false';
const number = (value, fallback) => (Number.isFinite(Number(value)) && value !== '' && value !== undefined ? Number(value) : fallback);
const delaySeconds = number(env.SEND_DELAY_SECONDS, 90);

const config = {
  dryRun,
  fromName: env.FROM_NAME || 'Your name',
  fromEmail: env.FROM_EMAIL || 'you@example.com',
  senderAddress: env.SENDER_ADDRESS || '',
  dailyLimit: Math.min(Math.max(1, number(env.DAILY_LIMIT, 20)), MAX_DAILY_LIMIT),
  delayMs: (dryRun ? Math.max(0, delaySeconds) : Math.max(MIN_REAL_DELAY_SECONDS, delaySeconds)) * 1000,
  jitterMs: dryRun ? 1 : 60_000,
  smtpReady: Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.FROM_EMAIL),
};

const smtpPort = number(env.SMTP_PORT, 465);
const transport = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: smtpPort,
  secure: smtpPort === 465,
  requireTLS: smtpPort !== 465,
  auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  tls: { minVersion: 'TLSv1.2' },
});

const store = createStore(join(ROOT, 'data', 'state.json'));
const engine = createEngine({ store, transport, config });

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/sent': ['index.html', 'text/html; charset=utf-8'],
};

const ALLOWED_HOSTS = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((h) => `http://${h}`));

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new UserError('That is too much text.'));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new UserError('Invalid request.'));
      }
    });
    req.on('error', reject);
  });
}

function publicState() {
  return {
    config: {
      dryRun: config.dryRun,
      smtpReady: config.smtpReady,
      from: config.fromEmail,
      fromName: config.fromName,
      dailyLimit: config.dailyLimit,
      delaySeconds: Math.round(config.delayMs / 1000),
      footer: engine.footer,
    },
    campaign: store.state.campaign,
    categories: engine.categories(),
    sentToday: engine.sentToday(),
    suppressedCount: store.state.suppressed.length,
  };
}

function classify(raw) {
  const { valid, invalid, duplicates } = parseEmails(raw);
  const contacted = valid.filter(engine.isContacted);
  const suppressed = valid.filter(engine.isSuppressed);
  const ready = valid.filter((e) => !engine.isContacted(e) && !engine.isSuppressed(e));
  return { ready, invalid, duplicates, contacted, suppressed };
}

const ROUTES = {
  '/api/parse': async (body) => classify(body.raw),
  '/api/start': async (body) => {
    if (body.confirm !== true) throw new UserError('Confirm the send first.');
    const { ready } = classify(Array.isArray(body.emails) ? body.emails.join('\n') : '');
    engine.start({ subject: body.subject, body: body.body, emails: ready, category: body.category });
    return publicState();
  },
  '/api/test': async (body) => {
    await engine.sendTest({ subject: body.subject, body: body.body });
    return { ok: true };
  },
  '/api/result': async (body) => {
    engine.setResult({ sendId: body.sendId, email: body.email, result: body.result ?? '' });
    return { ok: true };
  },
  '/api/pause': async () => (engine.pause(), publicState()),
  '/api/resume': async () => (engine.resume(), publicState()),
  '/api/cancel': async () => (engine.cancel(), publicState()),
  '/api/clear': async () => (engine.clear(), publicState()),
  '/api/suppress': async (body) => {
    const { valid } = parseEmails(body.raw);
    engine.suppress(valid);
    return { added: valid.length, ...publicState() };
  },
};

const server = createServer(async (req, res) => {
  // Only this machine's browser, on this app's own page, may talk to the server.
  if (!ALLOWED_HOSTS.has(req.headers.host ?? '')) return send(res, 403, { error: 'Forbidden' });

  const { pathname, searchParams } = new URL(req.url, `http://${HOST}`);
  try {
    if (req.method === 'GET') {
      if (pathname === '/api/state') return send(res, 200, publicState());
      if (pathname === '/api/sent') {
        return send(res, 200, engine.sentView({
          category: searchParams.get('category') || undefined,
          practice: searchParams.get('practice') === '1',
        }));
      }
      const file = STATIC[pathname];
      if (!file) return send(res, 404, { error: 'Not found' });
      return send(res, 200, await readFile(join(ROOT, 'public', file[0])), file[1]);
    }

    if (req.method !== 'POST' || !ROUTES[pathname]) return send(res, 404, { error: 'Not found' });
    if (!ALLOWED_ORIGINS.has(req.headers.origin ?? '')) return send(res, 403, { error: 'Forbidden' });
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
      return send(res, 415, { error: 'Unsupported content type' });
    }
    return send(res, 200, await ROUTES[pathname](await readJson(req)));
  } catch (error) {
    if (error instanceof UserError) return send(res, 400, { error: error.message });
    console.error(error);
    return send(res, 500, { error: 'Something went wrong. Check the terminal.' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Outreach Sender: http://localhost:${PORT}`);
  console.log(dryRun ? 'PRACTICE MODE: nothing will be sent.' : `LIVE MODE: sending from ${config.fromEmail}.`);
});
