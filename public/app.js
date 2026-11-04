const $ = (id) => document.getElementById(id);
const DRAFT_KEY = 'outreach-draft';
const POLL_MS = 2000;

const LABELS = {
  pending: 'Waiting', sending: 'Sending…', sent: 'Sent', simulated: 'Simulated',
  failed: 'Failed', skipped: 'Skipped', cancelled: 'Cancelled',
};

const RESULT_LABELS = {
  '': 'Not set', no_reply: 'No reply', not_now: 'Not now', not_me: 'Not me',
  not_this: 'Not this', not_price: 'Not at this price', interested: 'Interested',
};
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

let sent = { rows: [], categories: [] };
let ready = [];
const removed = new Set();
let parsed = { invalid: [], duplicates: [], contacted: [], suppressed: [] };
let current = null;
let pollTimer = null;
let parseTimer = null;

async function api(path, body) {
  const options = body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

function showError(message) {
  $('error').textContent = message ?? '';
  $('error').hidden = !message;
}

async function run(action) {
  showError('');
  try {
    return await action();
  } catch (error) {
    showError(error.message);
  }
}

function saveDraft() {
  localStorage.setItem(DRAFT_KEY, JSON.stringify({
    raw: $('raw').value, category: $('category').value, subject: $('subject').value, body: $('body').value,
  }));
}

function loadDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? '{}');
    $('raw').value = draft.raw ?? '';
    $('category').value = draft.category ?? '';
    $('subject').value = draft.subject ?? '';
    $('body').value = draft.body ?? '';
  } catch {
    localStorage.removeItem(DRAFT_KEY);
  }
}

function renderReady() {
  const list = $('ready');
  list.replaceChildren(...ready.map((email) => {
    const item = document.createElement('li');
    const text = document.createElement('span');
    text.textContent = email;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'link';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove ${email}`);
    remove.addEventListener('click', () => {
      removed.add(email);
      ready = ready.filter((e) => e !== email);
      renderReady();
    });
    item.append(text, remove);
    return item;
  }));

  $('ready-title').textContent = `Ready to send (${ready.length})`;
  $('ready-empty').hidden = ready.length > 0;
  $('clear-list').hidden = ready.length === 0;
  renderProblems();
  updateStart();
}

function renderProblems() {
  const groups = [
    ['Not valid, fix these', parsed.invalid, 'warn'],
    ['Already emailed, skipped', parsed.contacted, 'muted'],
    ['On your do-not-contact list, skipped', parsed.suppressed, 'muted'],
    ['Duplicates removed', parsed.duplicates, 'muted'],
  ].filter(([, items]) => items.length > 0);

  $('problems').replaceChildren(...groups.map(([title, items, tone]) => {
    const box = document.createElement('details');
    box.className = tone;
    box.open = tone === 'warn';
    const summary = document.createElement('summary');
    summary.textContent = `${title} (${items.length})`;
    const list = document.createElement('ul');
    list.className = 'plain';
    list.append(...items.map((value) => {
      const li = document.createElement('li');
      li.textContent = value;
      return li;
    }));
    box.append(summary, list);
    return box;
  }));
}

function updateStart() {
  const hasMessage = $('category').value.trim() && $('subject').value.trim() && $('body').value.trim();
  $('start').disabled = !(ready.length > 0 && hasMessage);
  const limit = current?.config.dailyLimit ?? 20;
  if (ready.length === 0) {
    $('estimate').textContent = '';
  } else if (ready.length <= limit) {
    $('estimate').textContent = `All ${ready.length} can go out today, one at a time.`;
  } else {
    $('estimate').textContent = `At ${limit} a day, this will take ${Math.ceil(ready.length / limit)} days. The app must stay open.`;
  }
  $('confirm').hidden = true;
}

function parseNow() {
  clearTimeout(parseTimer);
  parseTimer = setTimeout(() => run(async () => {
    parsed = await api('/api/parse', { raw: $('raw').value });
    ready = parsed.ready.filter((email) => !removed.has(email));
    renderReady();
  }), 250);
}

function renderResult(recipient) {
  const item = document.createElement('li');
  const email = document.createElement('span');
  email.textContent = recipient.email;
  const status = document.createElement('span');
  status.className = `status ${recipient.status}`;
  status.textContent = LABELS[recipient.status] ?? recipient.status;
  item.append(email, status);
  if (recipient.error) {
    const detail = document.createElement('small');
    detail.textContent = recipient.error;
    item.append(detail);
  }
  return item;
}

function renderCampaign() {
  const campaign = current.campaign;
  const active = campaign && ['running', 'paused'].includes(campaign.status);
  $('compose').hidden = Boolean(campaign);
  $('progress').hidden = !campaign;
  if (!campaign) return;

  const list = campaign.recipients;
  const count = (...states) => list.filter((r) => states.includes(r.status)).length;
  const finished = count('sent', 'simulated', 'failed', 'skipped', 'cancelled');
  const delivered = count('sent', 'simulated');

  const titles = {
    running: 'Sending…', paused: 'Paused', done: 'Finished', cancelled: 'Cancelled',
  };
  $('progress-title').textContent = `${titles[campaign.status]}: ${campaign.category}${campaign.dryRun ? ' (practice)' : ''}`;
  $('bar').max = list.length;
  $('bar').value = finished;

  const verb = campaign.dryRun ? 'simulated' : 'sent';
  let summary = `${delivered} of ${list.length} ${verb}. ${count('failed')} failed. ${current.sentToday} of ${current.config.dailyLimit} used today.`;
  if (campaign.status === 'running' && campaign.nextAt) {
    const seconds = Math.max(0, Math.round((campaign.nextAt - Date.now()) / 1000));
    summary += ` Next email in ${seconds}s.`;
  }
  $('counts').textContent = summary;
  $('notice').textContent = campaign.notice ?? '';
  $('notice').hidden = !campaign.notice;

  $('pause').hidden = campaign.status !== 'running';
  $('resume').hidden = campaign.status !== 'paused';
  $('cancel').hidden = !active;
  $('new').hidden = active;
  $('results').replaceChildren(...list.map(renderResult));
}

function render() {
  const { config } = current;
  $('mode').textContent = config.dryRun ? 'Practice mode: nothing is sent' : `Live: sending from ${config.from}`;
  $('mode').className = `badge ${config.dryRun ? 'practice' : 'live'}`;
  $('footer').textContent = config.footer;
  $('category-options').replaceChildren(...current.categories.map((name) => {
    const option = document.createElement('option');
    option.value = name;
    return option;
  }));
  $('suppressed-count').textContent = `${current.suppressedCount} blocked so far.`;
  $('test').disabled = config.dryRun;
  $('test').title = config.dryRun ? 'Turn off practice mode to send a test' : '';
  renderCampaign();
  updatePolling();
}

function updatePolling() {
  const active = current.campaign && ['running', 'paused'].includes(current.campaign.status);
  if (active && !pollTimer) {
    pollTimer = setInterval(refresh, POLL_MS);
  } else if (!active && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function refresh() {
  const confirmOpen = !$('confirm').hidden;
  current = await api('/api/state');
  render();
  if (confirmOpen) $('confirm').hidden = false;
}

async function startSend() {
  await run(async () => {
    current = await api('/api/start', {
      confirm: true,
      category: $('category').value,
      subject: $('subject').value,
      body: $('body').value,
      emails: ready,
    });
    $('confirm').hidden = true;
    render();
  });
}

function wire() {
  $('raw').addEventListener('input', () => { saveDraft(); parseNow(); });
  for (const id of ['category', 'subject', 'body']) {
    $(id).addEventListener('input', () => { saveDraft(); updateStart(); });
  }

  $('clear-list').addEventListener('click', () => {
    ready = [];
    removed.clear();
    $('raw').value = '';
    parsed = { invalid: [], duplicates: [], contacted: [], suppressed: [] };
    saveDraft();
    renderReady();
    $('raw').focus();
  });

  $('start').addEventListener('click', () => {
    const verb = current.config.dryRun ? 'simulate sending this to' : 'send this to';
    $('confirm-text').textContent = `You're about to ${verb} ${ready.length} ${ready.length === 1 ? 'person' : 'people'} in ${$('category').value.trim()}. Sent emails can't be recalled.`;
    $('confirm').hidden = false;
    $('confirm-no').focus();
  });
  $('confirm-no').addEventListener('click', () => {
    $('confirm').hidden = true;
    $('start').focus();
  });
  $('confirm-yes').addEventListener('click', startSend);

  $('test').addEventListener('click', () => run(async () => {
    await api('/api/test', { subject: $('subject').value, body: $('body').value });
    $('estimate').textContent = `Test sent to ${current.config.from}. Check your inbox and spam folder.`;
  }));

  for (const action of ['pause', 'resume', 'cancel']) {
    $(action).addEventListener('click', () => run(async () => {
      current = await api(`/api/${action}`, {});
      render();
    }));
  }

  $('new').addEventListener('click', () => run(async () => {
    current = await api('/api/clear', {});
    render();
    parseNow();
  }));

  $('suppress').addEventListener('click', () => run(async () => {
    const result = await api('/api/suppress', { raw: $('suppress-raw').value });
    current = result;
    $('suppress-raw').value = '';
    render();
    parseNow();
  }));
}

function sentUrl(category, query, practice) {
  const params = new URLSearchParams();
  if (category) params.set('category', category);
  if (query) params.set('q', query);
  if (practice) params.set('practice', '1');
  const text = params.toString();
  return text ? `/sent?${text}` : '/sent';
}

const sentParams = () => new URLSearchParams(location.search);

function resultSelect(row) {
  const select = document.createElement('select');
  select.name = 'result';
  select.setAttribute('aria-label', `Result for ${row.email}`);
  select.append(...Object.entries(RESULT_LABELS).map(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
  }));
  select.value = row.result;
  select.addEventListener('change', () => run(async () => {
    const previous = row.result;
    try {
      await api('/api/result', { sendId: row.sendId, email: row.email, result: select.value });
      row.result = select.value;
      await loadSent();
    } catch (error) {
      select.value = previous;
      throw error;
    }
  }));
  return select;
}

function cell(text, className) {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function sentRow(row) {
  const main = document.createElement('tr');
  const detail = document.createElement('tr');
  detail.hidden = true;

  const emailCell = document.createElement('td');
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'link email';
  toggle.textContent = row.email;
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-label', `Show message sent to ${row.email}`);
  toggle.addEventListener('click', () => {
    detail.hidden = !detail.hidden;
    toggle.setAttribute('aria-expanded', String(!detail.hidden));
  });
  emailCell.append(toggle);

  const status = cell(LABELS[row.status] ?? row.status, `status ${row.status}`);
  const resultCell = document.createElement('td');
  if (row.status === 'failed') resultCell.textContent = '-';
  else resultCell.append(resultSelect(row));

  main.append(
    emailCell, cell(row.category), cell(row.subject),
    cell(row.at ? dateFormat.format(row.at) : '-', 'nowrap'), status, resultCell,
  );

  const detailCell = document.createElement('td');
  detailCell.colSpan = 6;
  const subject = document.createElement('strong');
  subject.textContent = row.subject;
  const body = document.createElement('pre');
  body.className = 'footer';
  body.textContent = row.body;
  detailCell.append(subject, body);
  if (row.error) {
    const error = document.createElement('p');
    error.className = 'failure';
    error.textContent = `Why it failed: ${row.error}`;
    detailCell.append(error);
  }
  detail.append(detailCell);
  return [main, detail];
}

function categoryLink(label, count, category, selected) {
  const link = document.createElement('a');
  link.href = sentUrl(category, $('search').value.trim(), $('practice').checked);
  link.textContent = `${label} (${count})`;
  if (selected) link.setAttribute('aria-current', 'true');
  return link;
}

function renderSent() {
  const category = sentParams().get('category') ?? '';
  const query = $('search').value.trim().toLowerCase();
  const total = sent.categories.reduce((sum, c) => sum + c.total, 0);

  $('categories').replaceChildren(
    categoryLink('All', total, '', !category),
    ...sent.categories.map((c) => categoryLink(c.name, c.total, c.name, c.name === category)),
  );

  const scope = category ? sent.categories.filter((c) => c.name === category) : sent.categories;
  const add = (key) => scope.reduce((sum, c) => sum + c[key], 0);
  const delivered = add('delivered');
  const share = delivered ? Math.round((add('interested') / delivered) * 100) : 0;
  $('sent-summary').textContent = delivered
    ? `${delivered} delivered. ${add('answered')} answered. ${add('interested')} interested (${share}%).`
    : '';

  const rows = sent.rows.filter((r) => r.email.includes(query));
  $('sent-rows').replaceChildren(...rows.flatMap(sentRow));
  $('sent-table').hidden = rows.length === 0;
  $('sent-empty').hidden = rows.length > 0;
  if (rows.length === 0) {
    if (query) $('sent-empty').textContent = 'No emails match your search.';
    else if (category) $('sent-empty').textContent = `Nothing sent in ${category} yet.`;
    else $('sent-empty').textContent = 'Emails you send will appear here.';
  }
}

async function loadSent() {
  const params = new URLSearchParams();
  const category = sentParams().get('category');
  if (category) params.set('category', category);
  if ($('practice').checked) params.set('practice', '1');
  sent = await api(`/api/sent?${params}`);
  renderSent();
}

function showView() {
  const onSent = location.pathname === '/sent';
  $('send-view').hidden = onSent;
  $('sent-view').hidden = !onSent;
  document.title = onSent ? 'Sent emails - Outreach Sender' : 'Outreach Sender';
  for (const [id, active] of [['nav-send', !onSent], ['nav-sent', onSent]]) {
    if (active) $(id).setAttribute('aria-current', 'page');
    else $(id).removeAttribute('aria-current');
  }
  if (!onSent) return;
  const params = sentParams();
  $('search').value = params.get('q') ?? '';
  $('practice').checked = params.get('practice') === '1';
  run(loadSent);
}

function goTo(url, { replace = false } = {}) {
  history[replace ? 'replaceState' : 'pushState'](null, '', url);
  showView();
}

function wireSent() {
  // Plain left clicks stay in the app. Ctrl/Cmd and middle clicks keep working as normal links.
  document.addEventListener('click', (event) => {
    const link = event.target.closest?.('a[href^="/"]');
    if (!link || event.defaultPrevented || event.button !== 0) return;
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    goTo(link.getAttribute('href'));
  });
  window.addEventListener('popstate', showView);
  $('practice').addEventListener('change', () => {
    goTo(sentUrl('', $('search').value.trim(), $('practice').checked));
  });
  $('search').addEventListener('input', () => {
    const category = sentParams().get('category') ?? '';
    history.replaceState(null, '', sentUrl(category, $('search').value.trim(), $('practice').checked));
    renderSent();
  });
}

wire();
wireSent();
loadDraft();
await run(refresh);
showView();
if ($('raw').value) parseNow();
else renderReady();
