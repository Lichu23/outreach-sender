import { randomUUID } from 'node:crypto';

const MAX_SUBJECT = 150;
const MAX_BODY = 20_000;
const MAX_RECIPIENTS = 300;
const MAX_FAILURES_IN_A_ROW = 3;
const RECHECK_MS = 60_000;
const DAY_MS = 86_400_000;
const MAX_CATEGORY = 40;
const SHOWN_STATUSES = new Set(['sent', 'simulated', 'failed']);

export const PRESET_CATEGORIES = ['Cafés', 'Dentists', 'Barbershops'];
export const RESULTS = ['no_reply', 'not_now', 'not_me', 'not_this', 'not_price', 'interested'];

export const cleanSubject = (value) => String(value ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_SUBJECT);
export const cleanCategory = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_CATEGORY);
const categoryKey = (value) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export const cleanBody = (value) => String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, MAX_BODY);

export function buildFooter({ fromName, senderAddress }) {
  return [
    '--',
    fromName,
    senderAddress,
    'Si no querés recibir más mensajes míos, respondé BAJA y no te escribo más.',
  ].filter(Boolean).join('\n');
}

const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

export function createEngine({ store, transport, config, now = Date.now, random = Math.random }) {
  const { state } = store;
  let timer = null;
  let sending = false;
  let lastSendAt = 0;
  let failuresInARow = 0;

  // A restart must never resend: anything mid-send is treated as possibly delivered.
  const interrupted = state.campaign;
  if (interrupted) {
    interrupted.id ??= randomUUID();
    interrupted.category ??= 'Uncategorized';
    for (const r of interrupted.recipients) {
      if (r.status !== 'sending') continue;
      r.status = 'failed';
      r.error = 'Interrupted. It may have been sent, so it will not be retried.';
      state.history.push({ email: r.email, at: now() });
    }
    if (interrupted.status === 'running') {
      interrupted.status = 'paused';
      interrupted.notice = 'Paused because the app restarted. Press Resume to continue.';
    }
    store.save();
  }

  const footer = buildFooter(config);

  const allSends = () => [...state.sends, ...(state.campaign ? [state.campaign] : [])];

  function archive() {
    if (state.campaign) state.sends.push(state.campaign);
    state.campaign = null;
  }

  function categories() {
    const names = new Map(PRESET_CATEGORIES.map((name) => [categoryKey(name), name]));
    for (const send of allSends()) {
      const key = categoryKey(send.category);
      if (!names.has(key)) names.set(key, send.category);
    }
    return [...names.values()];
  }

  /** Reuses an existing spelling, so "cafes" and "Cafés" stay one category. */
  const canonicalCategory = (name) => categories().find((c) => categoryKey(c) === categoryKey(name)) ?? name;

  const isContacted = (email) => state.history.some((h) => h.email === email);
  const isSuppressed = (email) => state.suppressed.includes(email);

  function sentToday() {
    return state.sendLog.filter((s) => sameDay(s.at, now()) && Boolean(s.simulated) === config.dryRun).length;
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(tick, ms);
    timer.unref?.();
  }

  function buildMail(campaign, to) {
    return {
      from: { name: config.fromName, address: config.fromEmail },
      to,
      subject: campaign.subject,
      text: `${campaign.body}\n\n${footer}`,
      headers: { 'List-Unsubscribe': `<mailto:${config.fromEmail}?subject=BAJA>` },
    };
  }

  const errorText = (error) => String(error?.response ?? error?.message ?? 'Unknown error').slice(0, 200);

  function finishIfDone(campaign) {
    if (campaign.recipients.some((r) => r.status === 'pending')) return false;
    campaign.status = 'done';
    campaign.notice = null;
    campaign.nextAt = null;
    store.save();
    return true;
  }

  async function tick() {
    const campaign = state.campaign;
    if (!campaign || campaign.status !== 'running' || sending) return;
    if (finishIfDone(campaign)) return;

    if (sentToday() >= config.dailyLimit) {
      campaign.notice = `Daily limit of ${config.dailyLimit} reached. Sending continues tomorrow if the app stays open.`;
      campaign.nextAt = null;
      store.save();
      schedule(RECHECK_MS);
      return;
    }
    campaign.notice = null;

    const next = campaign.recipients.find((r) => r.status === 'pending');
    if (isSuppressed(next.email)) {
      next.status = 'skipped';
      next.error = 'On the do-not-contact list.';
      store.save();
      schedule(0);
      return;
    }

    next.status = 'sending';
    store.save();
    sending = true;
    try {
      if (!config.dryRun) await transport.sendMail(buildMail(campaign, next.email));
      next.status = config.dryRun ? 'simulated' : 'sent';
      next.sentAt = now();
      state.sendLog.push({ at: now(), simulated: config.dryRun });
      if (!config.dryRun) state.history.push({ email: next.email, at: now() });
      failuresInARow = 0;
    } catch (error) {
      next.status = 'failed';
      next.error = errorText(error);
      failuresInARow += 1;
      if (error?.code === 'EAUTH') {
        campaign.status = 'paused';
        campaign.notice = 'Your email provider rejected the login. Check SMTP_USER and SMTP_PASS, then restart.';
      } else if (failuresInARow >= MAX_FAILURES_IN_A_ROW) {
        campaign.status = 'paused';
        campaign.notice = `Paused after ${MAX_FAILURES_IN_A_ROW} failures in a row. Check the errors before resuming.`;
      }
    } finally {
      sending = false;
    }

    lastSendAt = now();
    state.sendLog = state.sendLog.filter((s) => now() - s.at < 2 * DAY_MS);
    if (campaign.status === 'running' && !finishIfDone(campaign)) {
      const wait = config.delayMs + Math.floor(random() * config.jitterMs);
      campaign.nextAt = now() + wait;
      store.save();
      schedule(wait);
    } else {
      store.save();
    }
  }

  function start({ subject, body, emails, category }) {
    if (state.campaign && ['running', 'paused'].includes(state.campaign.status)) {
      throw new UserError('A send is already in progress. Finish or cancel it first.');
    }
    const cleanS = cleanSubject(subject);
    const cleanB = cleanBody(body);
    const cleanC = cleanCategory(category);
    if (!cleanC) throw new UserError('Choose a category.');
    if (!cleanS) throw new UserError('Write a subject.');
    if (!cleanB) throw new UserError('Write a message.');
    if (!Array.isArray(emails) || emails.length === 0) throw new UserError('Add at least one email.');
    if (emails.length > MAX_RECIPIENTS) throw new UserError(`The limit is ${MAX_RECIPIENTS} emails per send.`);
    if (!config.dryRun && !config.smtpReady) {
      throw new UserError('Email settings are incomplete. Fill in .env and restart.');
    }

    const ready = [...new Set(emails)].filter((e) => !isSuppressed(e) && !isContacted(e));
    if (ready.length === 0) throw new UserError('Everyone here was already contacted or is on the do-not-contact list.');

    const canonical = canonicalCategory(cleanC);
    archive();
    state.campaign = {
      id: randomUUID(),
      category: canonical,
      subject: cleanS,
      body: cleanB,
      dryRun: config.dryRun,
      status: 'running',
      notice: null,
      nextAt: null,
      startedAt: now(),
      recipients: ready.map((email) => ({ email, status: 'pending' })),
    };
    failuresInARow = 0;
    store.save();
    schedule(0);
  }

  function pause() {
    const c = state.campaign;
    if (c?.status !== 'running') return;
    c.status = 'paused';
    c.notice = null;
    c.nextAt = null;
    clearTimeout(timer);
    store.save();
  }

  function resume() {
    const c = state.campaign;
    if (c?.status !== 'paused') return;
    c.status = 'running';
    c.notice = null;
    failuresInARow = 0;
    store.save();
    // Resuming must not skip the wait between emails.
    schedule(Math.max(0, lastSendAt + config.delayMs - now()));
  }

  function cancel() {
    const c = state.campaign;
    if (!c || !['running', 'paused'].includes(c.status)) return;
    for (const r of c.recipients) {
      if (r.status === 'pending') r.status = 'cancelled';
    }
    c.status = 'cancelled';
    c.notice = null;
    c.nextAt = null;
    clearTimeout(timer);
    store.save();
  }

  function clear() {
    if (state.campaign && ['running', 'paused'].includes(state.campaign.status)) {
      throw new UserError('Cancel the current send first.');
    }
    archive();
    store.save();
  }

  async function sendTest({ subject, body }) {
    const cleanS = cleanSubject(subject);
    const cleanB = cleanBody(body);
    if (!cleanS || !cleanB) throw new UserError('Write a subject and a message first.');
    if (config.dryRun) throw new UserError('Practice mode is on, so test emails are off. Set DRY_RUN=false in .env.');
    if (!config.smtpReady) throw new UserError('Email settings are incomplete. Fill in .env and restart.');
    try {
      await transport.sendMail(buildMail({ subject: `[TEST] ${cleanS}`, body: cleanB }, config.fromEmail));
    } catch (error) {
      throw new UserError(`Test failed: ${errorText(error)}`);
    }
  }

  function sentView({ category, practice = false } = {}) {
    const rows = [];
    const summary = new Map();
    const sends = allSends().filter((s) => Boolean(s.dryRun) === practice);

    for (const send of [...sends].reverse()) {
      const item = summary.get(send.category) ?? { name: send.category, total: 0, delivered: 0, answered: 0, interested: 0 };
      for (const r of send.recipients) {
        if (!SHOWN_STATUSES.has(r.status)) continue;
        item.total += 1;
        if (r.status !== 'failed') item.delivered += 1;
        if (r.result && r.result !== 'no_reply') item.answered += 1;
        if (r.result === 'interested') item.interested += 1;
        if (category && category !== send.category) continue;
        rows.push({
          sendId: send.id,
          email: r.email,
          category: send.category,
          subject: send.subject,
          body: send.body,
          status: r.status,
          error: r.error ?? null,
          at: r.sentAt ?? send.startedAt ?? null,
          result: r.result ?? '',
        });
      }
      if (item.total > 0) summary.set(send.category, item);
    }
    return { rows, categories: [...summary.values()] };
  }

  function setResult({ sendId, email, result }) {
    if (result !== '' && !RESULTS.includes(result)) throw new UserError('Choose a valid result.');
    const recipient = allSends().find((s) => s.id === sendId)?.recipients.find((r) => r.email === email);
    if (!recipient) throw new UserError('That email was not found. Refresh the page.');
    if (!['sent', 'simulated'].includes(recipient.status)) throw new UserError('Only delivered emails can have a result.');
    if (result) recipient.result = result;
    else delete recipient.result;
    store.save();
  }

  function suppress(emails) {
    for (const email of emails) {
      if (!isSuppressed(email)) state.suppressed.push(email);
    }
    store.save();
  }

  return { start, pause, resume, cancel, clear, sendTest, suppress, sentToday, isContacted, isSuppressed, footer, categories, sentView, setResult };
}

/** An error whose message is safe and useful to show in the UI. */
export class UserError extends Error {}
