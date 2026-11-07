'use strict';

// StediMail (formerly Mailboard): Gmail as Kanban columns. Runs entirely in the browser; each
// column (other than Inbox) is a Gmail label named "Board/<column>".

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
// Full access: gmail.modify can move mail to Trash but not delete it forever.
// Full Gmail access (delete forever needs it), plus read-only Contacts and "Other contacts" (people you've
// emailed) for address suggestions in To. A scope change makes everyone sign in once more.
const SCOPE = 'https://mail.google.com/ https://www.googleapis.com/auth/contacts.readonly https://www.googleapis.com/auth/contacts.other.readonly';
const LABEL_PREFIX = 'Board/';
const COLOR_PREFIX = 'Board/Color/';
// Mailboard's own snooze (Gmail's API can't snooze): a hidden label holds the wake time in UTC, e.g.
// Mailboard/Snooze/20261103-1700Z. Mailboard wakes due ones when it loads; the optional Apps Script
// helper (Settings) wakes them on time even when Mailboard is closed.
const SNOOZE_PREFIX = 'Mailboard/Snooze/';
// Plus one visible label on every Mailboard-snoozed email, so they're easy to find in Gmail's sidebar
// (Gmail's own Snoozed folder can't be used by apps). Removed again when the email wakes.
const SNOOZE_FLAG = 'Mailboard Snoozed';
// Background colors must come from Gmail's fixed label palette.
const COLORS = [
  { name: 'Red', bg: '#fb4c2f' },
  { name: 'Orange', bg: '#ffad47' },
  { name: 'Yellow', bg: '#fad165' },
  { name: 'Green', bg: '#16a766' },
  { name: 'Blue', bg: '#4a86e8' },
  { name: 'Purple', bg: '#a479e2' },
  { name: 'Pink', bg: '#f691b3' },
];
const REFRESH_MS = 2 * 60 * 1000;
const WATCH_MS = 15 * 1000;
const RENEW_BEFORE_MS = 5 * 60 * 1000;
const RENEW_EVERY_MS = 4 * 60 * 1000;
const RENEW_IDLE_MS = 30 * 1000;
const RENEW_LAST_MS = 60 * 1000;

const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Everything saved belongs to one Gmail account ("me@gmail.com|columns"), so a second person signing in on
// the same browser starts fresh and nothing of the first person's reaches their Gmail. Only these two are
// for the browser as a whole: 'email' is whoever signed in last.
const BROWSER_KEYS = new Set(['clientId', 'email']);
const store = {
  account: '',
  key(key) { return BROWSER_KEYS.has(key) || !this.account ? key : `${this.account}|${key}`; },
  get(key, fallback) {
    try { const v = localStorage.getItem(this.key(key)); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(this.key(key), JSON.stringify(value)); } catch {} },
};

// Settings saved before they were per account belong to the account that signed in first ('email').
store.account = store.get('email', '');
if (store.account) {
  try {
    for (const key of Object.keys(localStorage)) {
      if (BROWSER_KEYS.has(key) || key.includes('|')) continue;
      if (localStorage.getItem(`${store.account}|${key}`) == null) localStorage.setItem(`${store.account}|${key}`, localStorage.getItem(key));
      localStorage.removeItem(key);
    }
  } catch {}
}

// StediMail's own Google sign-in client, used on stedimail.com (and when testing locally), so testers just
// click Sign in. A Client ID isn't a secret. Anyone hosting their own copy pastes theirs (see README).
const BUILT_IN_CLIENT_ID = '922000608082-id99bt36apvi1fond3n02uialhdlvcg0.apps.googleusercontent.com';
function builtInClientId() {
  return ['stedimail.com', 'www.stedimail.com', 'localhost', '127.0.0.1'].includes(location.hostname) ? BUILT_IN_CLIENT_ID : '';
}

const settings = {
  clientId: store.get('clientId', '') || builtInClientId(),
  inboxName: store.get('inboxName', 'Inbox'),
  // A new user starts with just the Inbox: no columns, so no labels are added to their Gmail until they
  // make a column themselves. Someone who already has StediMail labels (new browser or new address)
  // gets those back instead; see adoptColumns().
  columns: store.get('columns', []),
  columnsSaved: store.get('columns', null) !== null,
  // Columns that show one of the person's own Gmail labels (column name → that label's full name).
  // Every other column is StediMail's own label "Board/<name>".
  columnLabels: store.get('columnLabels', {}),
  colWidth: store.get('colWidth', null),   // px shared by all columns; null = automatic
  collapsedCols: store.get('collapsedCols', []), // names of columns minimized to a vertical strip
  readerWidth: store.get('readerWidth', null),
  barColor: store.get('barColor', null),   // title bar color (#rrggbb); null = default olive   // px for the opened-email panel; null = normal (760)
};

function labelNameOf(col) { return settings.columnLabels[col] || LABEL_PREFIX + col; }
function isOwnLabel(col) { return !!settings.columnLabels[col]; }

function columns() {
  const cols = [{ name: settings.inboxName, inbox: true }];
  settings.columns.forEach((name, i) =>
    cols.push({ name }));   // every column just sorts; only Archive archives
  return cols;
}

const state = {
  token: null,
  tokenExp: 0,
  me: store.get('email', ''),
  labelIds: {},        // column name -> Gmail label id
  colorIds: {},        // color name -> Gmail label id (created on first use)
  nestLabels: new Map(), // parent thread id -> id of its hidden nesting label
  nestParents: new Map(), // hidden nesting label id -> parent thread id
  cardLabels: new Map(), // thread id -> { id of its hidden label, text } for labels typed on cards
  cardLabelSaves: new Map(), // the same, for ones still being saved (null = being removed)
  nestFlagId: null,    // hidden label on every thread in a nest, so they're loaded even when old
  nestOf: new Map(),   // nested thread id -> parent, as shown on the board now
  nestKids: new Map(), // parent thread id -> nested thread ids, as shown on the board now
  threads: new Map(),  // thread id -> summary
  board: [],           // per column: sorted thread ids
  more: [],            // per column: Gmail has more than we fetched
  search: null,        // { q, title, ids, more } while a search or folder is shown
  searchSeq: 0,        // bumps per search so a slow, older one can't overwrite a newer one
  searchArgs: null,    // { q, folder } that produced state.search, to re-run it
  selected: new Set(), // checked thread ids
  selectAll: null,     // { key, scope, total } when "all matching in a column" is selected
  folder: null,        // sidebar folder or label being shown, by name
  userLabels: [],      // the user's own Gmail labels, for the sidebar
  labelCounts: {},     // label id -> Gmail label (with unread/total counts)
  sidebarOpen: store.get('sidebar', window.innerWidth > 800),
  navMore: store.get('navMore', false),       // hidden folders expanded
  labelsMore: store.get('labelsMore', false), // hidden labels expanded
  addingColumn: false, // the "new column" name box is open; don't re-render under it
  openId: null,
  dragging: false,
  watchedHistory: null, // mailbox history number at the last check for new mail
  renewing: false,     // a quiet sign-in renewal is under way
  lastRenew: 0,
  lastInput: 0,        // last key, click, scroll or mouse move in this window
  loading: false,
  lastLoad: 0,
};

class AuthError extends Error {}

// ---------- auth ----------

let tokenClient = null;

function waitForGis() {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function check() {
      if (window.google?.accounts?.oauth2) return resolve();
      if (Date.now() - start > 15000) return reject(new Error('Could not load Google sign-in.'));
      setTimeout(check, 100);
    })();
  });
}

function initAuth() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: settings.clientId,
    scope: SCOPE,
    callback: (resp) => {
      const quiet = state.renewing;
      state.renewing = false;
      if (resp.error) { if (!quiet) toast('Sign-in failed: ' + resp.error); return; }
      const wasSignedOut = !state.token;
      setToken(resp.access_token, resp.expires_in);
      $('#banner').hidden = true;
      if (!quiet) start();
      else if (wasSignedOut) loadBoard();
    },
    error_callback: (err) => {
      if (state.renewing) { state.renewing = false; return; } // the banner still offers signing in
      toast(err.type === 'popup_closed' ? 'Sign-in window was closed.' : 'Sign-in failed: ' + err.type);
    },
  });
}

function setToken(token, expiresIn) {
  state.token = token;
  state.tokenExp = Date.now() + (Number(expiresIn) - 60) * 1000;
  try { sessionStorage.setItem('token', JSON.stringify({ token, exp: state.tokenExp, scope: SCOPE })); } catch {}
}

function restoreToken() {
  try {
    const saved = JSON.parse(sessionStorage.getItem('token'));
    // A token from before a scope change lacks permissions; sign in again.
    if (saved && saved.exp > Date.now() && saved.scope === SCOPE) {
      state.token = saved.token;
      state.tokenExp = saved.exp;
      return true;
    }
  } catch {}
  return false;
}

function signIn() {
  state.renewing = false;
  tokenClient.requestAccessToken(state.me ? { login_hint: state.me } : {});
}

// Google's sign-in lasts about an hour. Ask for a new one shortly before it runs out (or on coming back
// to an expired window), so a window left open keeps updating. Google's window flashes up for a moment,
// so wait for a pause in the user's typing and clicking until the last minute. If the browser blocks it
// as a pop-up, the "sign in again" banner shows, as before.
function renewSignIn() {
  if (!tokenClient || !state.me || $('#main-row').hidden) return;
  const now = Date.now();
  if (state.token && now < state.tokenExp - RENEW_BEFORE_MS) return;
  if (state.token && now < state.tokenExp - RENEW_LAST_MS && now - state.lastInput < RENEW_IDLE_MS) return;
  if (now - state.lastRenew < RENEW_EVERY_MS) return;
  state.lastRenew = now;
  state.renewing = true;
  tokenClient.requestAccessToken({ prompt: '', login_hint: state.me });
}

function needSignIn() {
  state.token = null;
  try { sessionStorage.removeItem('token'); } catch {}
  if ($('#main-row').hidden) show('signin');
  else $('#banner').hidden = false;
}

function signOut() {
  if (state.token) google.accounts.oauth2.revoke(state.token, () => {});
  state.token = null;
  state.me = '';                // the next sign-in can be anyone; start() checks who it is
  store.set('email', '');
  store.account = '';
  state.threads.clear();
  try { sessionStorage.removeItem('token'); } catch {}
  closeReader();
  document.title = 'StediMail';
  show('signin');
}

// ---------- Gmail API ----------

async function api(path, { method = 'GET', body } = {}, attempt = 0) {
  if (!state.token || Date.now() > state.tokenExp) { needSignIn(); throw new AuthError('Signed out'); }
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: 'Bearer ' + state.token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { needSignIn(); throw new AuthError('Session expired'); }
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await sleep(500 * 2 ** attempt + Math.random() * 300);
    return api(path, { method, body }, attempt + 1);
  }
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error.message; } catch {}
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  const worker = async () => { while (next < items.length) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// First load in this browser: if Gmail already has board labels ("Board/<name>") from using StediMail
// elsewhere, show those as the columns; otherwise start with none. Never creates a label.
const USUAL_ORDER = ['To Do', 'Waiting', 'Done'];
async function adoptColumns() {
  const { labels = [] } = await api('/labels');
  const board = labels.filter((l) => l.name.startsWith(LABEL_PREFIX) && !l.name.startsWith(COLOR_PREFIX)
    && l.name.length > LABEL_PREFIX.length && !l.name.slice(LABEL_PREFIX.length).includes('/'));
  // Empty labels aren't columns worth bringing back: leftovers like the first version's To Do / Waiting /
  // Done, or another person's columns once added to this Gmail by mistake. They stay offered under +.
  const kept = [];
  for (const l of board) {
    try { if ((await api(`/labels/${l.id}`)).threadsTotal === 0) continue; } catch (e) { if (e instanceof AuthError) throw e; }
    kept.push(l.name.slice(LABEL_PREFIX.length));
  }
  const names = kept;
  const rank = (n) => { const i = USUAL_ORDER.indexOf(n); return i < 0 ? USUAL_ORDER.length : i; };
  names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, undefined, { sensitivity: 'base' }));
  settings.columns = names.slice(0, 8);
  settings.columnsSaved = true;
  store.set('columns', settings.columns);
  // Nothing from StediMail yet: ask which of their own labels should be columns (none chosen for them).
  if (!settings.columns.length && ownLabelChoices(labels).length) state.pickLabels = ownLabelChoices(labels);
}

// The person's own labels that could be columns (not Gmail's system labels or StediMail's own).
function ownLabelChoices(labels) {
  return labels.filter((l) => l.type === 'user' && !l.name.startsWith(LABEL_PREFIX) && !l.name.startsWith('Mailboard/')
      && l.name !== 'Mailboard' && l.name !== SNOOZE_FLAG)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

const MAX_COLUMNS = 8;
function showLabelPicker(labels) {
  const dlg = el('dialog', { class: 'pick-labels', 'aria-label': 'Choose columns' });
  const boxes = labels.map((l) => {
    const cb = el('input', { type: 'checkbox', value: l.name });
    return { cb, row: el('label', { class: 'pick-row' }, [cb, el('span', {}, l.name)]) };
  });
  const count = el('p', { class: 'hint' });
  const update = () => {
    const n = boxes.filter((b) => b.cb.checked).length;
    boxes.forEach((b) => { b.cb.disabled = !b.cb.checked && n >= MAX_COLUMNS; });
    count.textContent = n ? `${n} chosen (up to ${MAX_COLUMNS}).` : `Choose up to ${MAX_COLUMNS}, or none.`;
  };
  boxes.forEach((b) => b.cb.addEventListener('change', update));
  const use = el('button', { type: 'button', class: 'primary' }, 'Use these');
  const skip = el('button', { type: 'button' }, 'Not now');
  dlg.append(
    el('h2', {}, 'Which of your labels should be columns?'),
    el('p', {}, 'Each column shows the emails with that label. Moving an email to another column moves its label. '
      + 'StediMail doesn\u2019t add anything to your Gmail. You can add or remove columns any time.'),
    el('div', { class: 'pick-list' }, boxes.map((b) => b.row)),
    count,
    el('div', { class: 'pick-buttons' }, [skip, use]));
  use.addEventListener('click', () => {
    const chosen = boxes.filter((b) => b.cb.checked).map((b) => b.cb.value);
    dlg.close(); dlg.remove();
    for (const name of chosen) settings.columnLabels[name] = name;
    saveColumnList([...settings.columns, ...chosen]);
  });
  skip.addEventListener('click', () => { dlg.close(); dlg.remove(); });
  document.body.append(dlg);
  update();
  dlg.showModal();
}

async function ensureLabels(cols) {
  const { labels = [] } = await api('/labels');
  const byName = Object.fromEntries(labels.map((l) => [l.name, l.id]));
  for (const c of COLORS) if (byName[COLOR_PREFIX + c.name]) state.colorIds[c.name] = byName[COLOR_PREFIX + c.name];
  state.snoozeLabels = labels.filter((l) => l.name.startsWith(SNOOZE_PREFIX))
    .map((l) => ({ id: l.id, name: l.name, due: snoozeDue(l.name) })).filter((l) => l.due);
  state.snoozeIds = new Set(state.snoozeLabels.map((l) => l.id));
  state.snoozeFlagId = labels.find((l) => l.name === SNOOZE_FLAG)?.id || null;
  state.nestLabels = new Map(); state.nestParents = new Map();
  for (const l of labels) {
    if (!l.name.startsWith(NEST_PREFIX)) continue;
    state.nestLabels.set(l.name.slice(NEST_PREFIX.length), l.id);
    state.nestParents.set(l.id, l.name.slice(NEST_PREFIX.length));
  }
  state.nestFlagId = labels.find((l) => l.name === NEST_FLAG)?.id || null;
  const cardLabels = new Map();
  for (const l of labels) {
    if (!l.name.startsWith(CARD_LABEL_PREFIX)) continue;
    const [threadId, code] = l.name.slice(CARD_LABEL_PREFIX.length).split('/');
    try { cardLabels.set(threadId, { id: l.id, text: decodeCardLabel(code) }); } catch {}
  }
  state.cardLabelSaves.forEach((saving, id) => { if (saving) cardLabels.set(id, saving); else cardLabels.delete(id); });
  state.cardLabels = cardLabels;
  state.allUserLabels = ownLabelChoices(labels);
  // StediMail's spare column labels (Board/<name> that isn't a column now), for the + suggestions.
  const inUse = new Set(cols.filter((c) => !c.inbox).map((c) => labelNameOf(c.name)));
  state.spareBoardLabels = labels.filter((l) => l.name.startsWith(LABEL_PREFIX) && !l.name.startsWith(COLOR_PREFIX)
      && !inUse.has(l.name) && !l.name.slice(LABEL_PREFIX.length).includes('/'))
    .map((l) => l.name.slice(LABEL_PREFIX.length));
  // The sidebar lists every label like Gmail does, column labels (Board/…) included.
  state.userLabels = labels
    .filter((l) => l.type === 'user' && !l.name.startsWith(COLOR_PREFIX) && !l.name.startsWith('Mailboard/') && l.name !== 'Mailboard' && l.name !== SNOOZE_FLAG)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  for (const col of cols) {
    if (col.inbox) continue;
    const name = labelNameOf(col.name);
    if (!byName[name]) {
      const made = await api('/labels', {
        method: 'POST',
        body: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
      });
      byName[name] = made.id;
      storeUserLabel(made);                              // show the new label in the sidebar right away
    }
    state.labelIds[col.name] = byName[name];
  }
}

function header(msg, name) {
  const h = msg.payload?.headers?.find((x) => x.name.toLowerCase() === name);
  return h ? h.value : '';
}

function summarize(t) {
  const msgs = t.messages || [];
  const last = msgs[msgs.length - 1] || {};
  const labels = new Set(msgs.flatMap((m) => m.labelIds || []));
  const people = [], senders = [];
  for (const m of msgs) {
    const from = header(m, 'from');
    if (from && !senders.some((x) => x.addr === addrOf(from))) senders.push({ name: displayName(from), addr: addrOf(from) });
    const name = addrOf(from) === state.me.toLowerCase() ? 'me' : displayName(from);
    if (!people.includes(name)) people.push(name);
  }
  return {
    id: t.id,
    historyId: t.historyId,
    subject: header(msgs[0] || {}, 'subject') || '(no subject)',
    people: people.join(', '),
    senders,
    snippet: decodeEntities(last.snippet || ''),
    date: Number(last.internalDate || 0),
    count: msgs.length,
    replied: (last.labelIds || []).includes('SENT'),
    attachments: msgs.filter((m) => /multipart\/mixed/i.test(header(m, 'content-type'))).length,
    unread: labels.has('UNREAD'),
    labels,
  };
}

function snoozeDue(name) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})Z$/.exec(name.slice(SNOOZE_PREFIX.length));
  return m ? new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5])) : null;
}

function snoozeName(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${SNOOZE_PREFIX}${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}-${p(date.getUTCHours())}${p(date.getUTCMinutes())}Z`;
}

function snoozedLabelOf(t) {
  return (state.snoozeLabels || []).find((l) => t.labels.has(l.id)) || null;
}

const whenLabel = (d) => d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// Hide a thread until `date`: out of the Inbox (it keeps its column, and comes back there), plus the
// wake-time label. Undo puts it back.
async function snoozeThread(id, date) {
  const t = state.threads.get(id);
  if (!t) return;
  try {
    const name = snoozeName(date);
    let lab = state.snoozeLabels.find((l) => l.name === name);
    if (!lab) {
      const made = await api('/labels', { method: 'POST', body: { name, labelListVisibility: 'labelHide', messageListVisibility: 'hide' } });
      lab = { id: made.id, name, due: snoozeDue(name) };
      state.snoozeLabels.push(lab);
      state.snoozeIds.add(lab.id);
    }
    if (!state.snoozeFlagId) {
      const flag = await api('/labels', { method: 'POST', body: { name: SNOOZE_FLAG, labelListVisibility: 'labelShow', messageListVisibility: 'show' } });
      state.snoozeFlagId = flag.id;
    }
    const old = (state.snoozeLabels || []).filter((l) => l.id !== lab.id && t.labels.has(l.id)).map((l) => l.id);
    const wasInbox = t.labels.has('INBOX'), wasUnread = t.labels.has('UNREAD');
    // Snoozing also marks it unread (as Paul does before snoozing in Gmail), so it stands out when it's back.
    await api(`/threads/${id}/modify`, { method: 'POST', body: { addLabelIds: [lab.id, state.snoozeFlagId, 'UNREAD'], removeLabelIds: ['INBOX', ...old] } });
    t.labels.add(lab.id); t.labels.add(state.snoozeFlagId); t.labels.add('UNREAD'); t.unread = true;
    t.labels.delete('INBOX'); old.forEach((l) => t.labels.delete(l));
    if (state.openId === id) closeReader();
    assign(columns()); render();
    toast(`Snoozed until ${whenLabel(date)}`, { label: 'Undo', run: async () => {
      await api(`/threads/${id}/modify`, { method: 'POST', body: { addLabelIds: wasInbox ? ['INBOX'] : [],
        removeLabelIds: [lab.id, state.snoozeFlagId, ...(wasUnread ? [] : ['UNREAD'])] } });
      t.labels.delete(lab.id); t.labels.delete(state.snoozeFlagId); if (wasInbox) t.labels.add('INBOX');
      if (!wasUnread) { t.labels.delete('UNREAD'); t.unread = false; }
      assign(columns()); render();
    } });
  } catch (e) {
    if (!(e instanceof AuthError)) toast('Could not snooze: ' + e.message);
  }
}

// Bring back every snoozed thread whose time has come: back in the Inbox, unread; the label goes.
async function wakeDueSnoozes() {
  const due = (state.snoozeLabels || []).filter((l) => l.due <= new Date());
  let woke = 0;
  for (const lab of due) {
    let page = '';
    do {
      const r = await api(`/threads?labelIds=${lab.id}&maxResults=500${page ? '&pageToken=' + page : ''}`);
      await mapLimit(r.threads || [], 5, (th) => api(`/threads/${th.id}/modify`, { method: 'POST',
        body: { addLabelIds: ['INBOX', 'UNREAD'], removeLabelIds: [lab.id, ...(state.snoozeFlagId ? [state.snoozeFlagId] : [])] } }));
      woke += (r.threads || []).length;
      page = r.nextPageToken;
    } while (page);
    await api(`/labels/${lab.id}`, { method: 'DELETE' }).catch(() => {});
    state.snoozeIds.delete(lab.id);
  }
  state.snoozeLabels = (state.snoozeLabels || []).filter((l) => !due.includes(l));
  if (woke) toast(woke === 1 ? 'A snoozed email is back' : `${woke} snoozed emails are back`);
}

function nextAt(days, hour, fromDate = new Date()) {
  const d = new Date(fromDate); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0); return d;
}

function snoozeChoices() {
  const now = new Date(), out = [];
  if (now.getHours() < 17) out.push(['Later today', nextAt(0, 18)]);
  out.push(['Tomorrow', nextAt(1, 8)]);
  const day = now.getDay();                                  // 0 Sun … 6 Sat
  if (day >= 1 && day <= 5) out.push(['This weekend', nextAt(6 - day, 8)]);
  const toMonday = ((8 - day) % 7) || 7;
  out.push(['Next week', nextAt(toMonday === 1 ? 8 : toMonday, 8)]);   // never the same as Tomorrow
  return out;
}

function openSnoozeMenu(anchor, id) {
  openMenu(anchor, [
    { heading: 'Snooze until…' },
    ...snoozeChoices().map(([label, d]) => ({ label: `${label} · ${whenLabel(d)}`, run: () => snoozeThread(id, d) })),
    { sep: true },
    { label: 'Pick date & time…', run: () => pickSnoozeTime(id) },
  ]);
}

function pickSnoozeTime(id) {
  const d = nextAt(1, 8), p = (n) => String(n).padStart(2, '0');
  const input = el('input', { type: 'datetime-local', value: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T08:00` });
  const ok = el('button', { type: 'button', class: 'primary' }, 'Snooze');
  const cancel = el('button', { type: 'button' }, 'Cancel');
  const dlg = el('dialog', { class: 'snooze-pick' }, [el('h2', {}, 'Snooze until'), input, el('div', { class: 'row' }, [cancel, ok])]);
  document.body.append(dlg);
  const done = () => { dlg.close(); dlg.remove(); };
  cancel.addEventListener('click', done);
  ok.addEventListener('click', () => {
    const when = new Date(input.value);
    if (isNaN(when) || when <= new Date()) { input.focus(); return; }
    done(); snoozeThread(id, when);
  });
  dlg.showModal(); input.focus();
}

// Which column a thread belongs in, or -1 if none.
function columnOf(t, cols) {
  if (snoozedLabelOf(t)) return -1;                  // snoozed: off the board until it wakes
  for (let i = 1; i < cols.length; i++) {
    if (!t.labels.has(state.labelIds[cols[i].name])) continue;
    // A new reply to an archived ("Done") thread lands back in the Inbox.
    if (cols[i].archive && t.labels.has('INBOX')) return 0;
    return i;
  }
  return t.labels.has('INBOX') ? 0 : -1;
}

const byText = (f) => (a, b) => f(a).localeCompare(f(b), undefined, { sensitivity: 'base' }) || b.date - a.date;
const SORTS = [
  { key: 'newest', label: 'Newest first', cmp: (a, b) => sortTime(b) - sortTime(a) },
  { key: 'oldest', label: 'Oldest first', cmp: (a, b) => sortTime(a) - sortTime(b) },
  { key: 'unread', label: 'Unread first', cmp: (a, b) => b.unread - a.unread || sortTime(b) - sortTime(a) },
  { key: 'sender', label: 'Sender A–Z', cmp: byText((t) => t.people) },
  { key: 'subject', label: 'Subject A–Z', cmp: byText((t) => t.subject) },
];
// Per-column sort, by column name, kept in this browser.
const columnSorts = store.get('sorts', {});
const sortOf = (col) => SORTS.find((s) => s.key === columnSorts[col.name]) || SORTS[0];

function setSort(col, key) {
  if (key === 'newest') delete columnSorts[col.name]; else columnSorts[col.name] = key;
  store.set('sorts', columnSorts);
  assign(columns());
  render();
}

function openSortMenu(anchor, col) {
  const current = sortOf(col).key;
  openMenu(anchor, [
    { heading: 'Sort' },
    ...SORTS.map((s) => ({ label: s.label, checked: s.key === current, run: () => setSort(col, s.key) })),
  ]);
}

// ---------- nesting: an email under another email, one level deep ----------
// Gmail has no such idea, so a nested thread carries a hidden label naming its parent thread, the way
// snoozed threads carry one naming their wake time. Labels survive reloads and work on other computers.
// A nest only shows when both emails are in the same column; otherwise the email just stands alone, and
// comes back under its parent if they meet again (e.g. Undo after deleting the parent).
const NEST_PREFIX = 'Mailboard/Nest/';
const NEST_FLAG = 'Mailboard/Nested';
// A card's own label, typed in the strip above its sender. Its text and thread are both in the name of a
// hidden Gmail label, so it follows Paul to other computers; the label is never put on the email itself.
const CARD_LABEL_PREFIX = 'Mailboard/CardLabel/';
const encodeCardLabel = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decodeCardLabel = (code) => new TextDecoder().decode(b64urlBytes(code));
const NEST_COLLAPSED = store.get('nestCollapsed', {});
const hiddenLabel = (name) => api('/labels', { method: 'POST', body: { name, labelListVisibility: 'labelHide', messageListVisibility: 'hide' } });
const nestLabelIdsOn = (t) => [...t.labels].filter((l) => state.nestParents.has(l));
const savedParentOf = (t) => { const l = nestLabelIdsOn(t)[0]; return l ? state.nestParents.get(l) : null; };

function arrangeNests(cols) {
  state.nestOf = new Map(); state.nestKids = new Map();
  state.board.forEach((list) => {
    const here = new Set(list);
    const parentOf = new Map();
    for (const id of list) {
      const p = savedParentOf(state.threads.get(id));
      if (p && p !== id && here.has(p) && !savedParentOf(state.threads.get(p))) parentOf.set(id, p);
    }
    const kids = new Map();
    for (const id of list) if (parentOf.has(id)) {
      if (!kids.has(parentOf.get(id))) kids.set(parentOf.get(id), []);
      kids.get(parentOf.get(id)).push(id);
    }
    // A nest sits where its best-placed email sorts, so new mail in a nested email brings the nest up.
    const placed = new Set(), out = [];
    for (const id of list) {
      const root = parentOf.get(id) || id;
      if (placed.has(root)) continue;
      placed.add(root);
      out.push(root, ...(kids.get(root) || []));
    }
    list.splice(0, list.length, ...out);
    parentOf.forEach((p, id) => state.nestOf.set(id, p));
    kids.forEach((k, p) => state.nestKids.set(p, k));
  });
}

// Puts thread id under parentId, or takes it out with parentId = null.
async function setNest(id, parentId) {
  const t = state.threads.get(id);
  if (!t) return;
  const oldParent = savedParentOf(t);
  const add = [], remove = nestLabelIdsOn(t);
  if (parentId) {
    let lab = state.nestLabels.get(parentId);
    if (!lab) {
      lab = (await hiddenLabel(NEST_PREFIX + parentId)).id;
      state.nestLabels.set(parentId, lab); state.nestParents.set(lab, parentId);
    }
    if (!state.nestFlagId) state.nestFlagId = (await hiddenLabel(NEST_FLAG)).id;
    add.push(lab, state.nestFlagId);
    remove.splice(0, remove.length, ...remove.filter((l) => l !== lab));
  } else if (state.nestFlagId && t.labels.has(state.nestFlagId)
    && ![...state.threads.values()].some((x) => savedParentOf(x) === id)) {
    remove.push(state.nestFlagId);
  }
  add.forEach((l) => t.labels.add(l));
  remove.forEach((l) => t.labels.delete(l));
  const calls = [api(`/threads/${id}/modify`, { method: 'POST', body: { addLabelIds: add, removeLabelIds: remove } })];
  const parent = parentId && state.threads.get(parentId);
  if (parent && !parent.labels.has(state.nestFlagId)) {
    parent.labels.add(state.nestFlagId);
    calls.push(api(`/threads/${parentId}/modify`, { method: 'POST', body: { addLabelIds: [state.nestFlagId], removeLabelIds: [] } }));
  }
  // Nobody left under the old parent: its label and flag have no more use.
  if (oldParent && oldParent !== parentId && ![...state.threads.values()].some((x) => savedParentOf(x) === oldParent)) {
    const lab = state.nestLabels.get(oldParent);
    state.nestLabels.delete(oldParent); state.nestParents.delete(lab);
    const was = state.threads.get(oldParent);
    if (was && state.nestFlagId && was.labels.delete(state.nestFlagId) && !savedParentOf(was)) {
      calls.push(api(`/threads/${oldParent}/modify`, { method: 'POST', body: { addLabelIds: [], removeLabelIds: [state.nestFlagId] } }));
    }
    calls.push(api(`/labels/${lab}`, { method: 'DELETE' }));
  }
  assign(columns());
  render();
  await Promise.all(calls);
}

async function nestWithUndo(id, parentId) {
  const cols = columns();
  const t = state.threads.get(id), parent = state.threads.get(parentId);
  if (!t || !parent) return;
  const prevCol = columnOf(t, cols), parentCol = columnOf(parent, cols), prevParent = state.nestOf.get(id) || null;
  try {
    if (prevCol !== parentCol && !await moveThread(id, parentCol)) return;
    await setNest(id, parentId);
    toast(`Nested under “${parent.subject}”`, { label: 'Undo', run: async () => {
      try {
        await setNest(id, prevParent);
        if (prevCol !== parentCol && prevCol >= 0) await moveThread(id, prevCol);
      } catch (e) { if (!(e instanceof AuthError)) toast('Undo failed: ' + e.message); }
    } });
  } catch (e) {
    if (!(e instanceof AuthError)) toast('Could not nest: ' + e.message);
    await loadBoard();
  }
}

async function unnestWithUndo(id) {
  const parent = state.nestOf.get(id);
  try {
    await setNest(id, null);
    toast('Took it out of the nest', { label: 'Undo', run: () => setNest(id, parent).catch((e) => toast(e.message)) });
  } catch (e) { if (!(e instanceof AuthError)) toast('Could not take it out: ' + e.message); }
}

function toggleNest(id) {
  if (NEST_COLLAPSED[id]) delete NEST_COLLAPSED[id]; else NEST_COLLAPSED[id] = 1;
  store.set('nestCollapsed', NEST_COLLAPSED);
  render();
}

// Dropping on the middle of a card nests. A card dragged in from another column has to rest there a
// moment first, because a quick drop anywhere in a column has always meant "move it to this column".
const NEST_HOLD_MS = 500;
const nestHover = { id: null, since: 0 };
function clearNestTarget() {
  nestHover.id = null;
  document.querySelectorAll('.card.nest-target').forEach((c) => c.classList.remove('nest-target'));
}
function nestTargetFor(card, t, colIdx, e) {
  const dragged = state.dragId;
  const parentId = state.nestOf.get(t.id) || t.id;         // onto a nested email = into the same nest
  if (!dragged || dragged === parentId || colIdx < 0 || state.nestKids.has(dragged)) return null;
  if (state.nestOf.get(dragged) === parentId) return null;
  if (state.selected.has(dragged) && state.selected.size > 1) return null;
  const r = card.getBoundingClientRect();
  const where = (e.clientY - r.top) / r.height;
  return where > .2 && where < .8 ? parentId : null;
}

function assign(cols) {
  state.board = cols.map(() => []);
  for (const t of state.threads.values()) {
    const c = columnOf(t, cols);
    if (c >= 0) state.board[c].push(t.id);
  }
  state.board.forEach((list, i) => {
    const { cmp } = sortOf(cols[i]);
    list.sort((a, b) => cmp(state.threads.get(a), state.threads.get(b)));
  });
  arrangeNests(cols);
}

const metadataPath = (id) =>
  `/threads/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Content-Type`;

// Fetch summaries for listed threads whose cached copy is out of date.
// Returns the ids that loaded; threads that vanish mid-load are skipped.
async function fetchSummaries(listed) {
  const ok = new Set(listed.map((t) => t.id));
  const stale = listed.filter((t) => state.threads.get(t.id)?.historyId !== t.historyId);
  if (stale.length > 10) setStatus(`Loading ${stale.length} conversations…`);
  await mapLimit(stale, 5, async (item) => {
    try {
      state.threads.set(item.id, summarize(await api(metadataPath(item.id))));
    } catch (e) {
      if (e instanceof AuthError) throw e;
      ok.delete(item.id);
    }
  });
  return ok;
}

// Show a search, or a sidebar folder, as the extra column left of the board.
// Gmail leaves Spam and Trash out of a search unless told to include them.
const searchesSpamTrash = (q) => /(^|\s)in:(anywhere|trash|spam)(\s|$)/i.test(q);

async function runSearch(q, folder) {
  q = (q || '').trim();
  if (q && !folder) rememberSearch(q);
  if (!q && !folder) { clearSearch(); return; }
  const seq = ++state.searchSeq;
  state.folder = folder ? folder.name : null;
  if (folder) $('#search').value = '';
  renderSidebar();
  setStatus(folder ? 'Loading…' : 'Searching…');
  try {
    const p = new URLSearchParams({ maxResults: '50' });
    if (folder?.q || q) p.set('q', folder?.q || q);
    if (folder?.label) p.set('labelIds', folder.label);
    if (folder?.spamTrash || searchesSpamTrash(q)) p.set('includeSpamTrash', 'true');
    const r = await api('/threads?' + p);
    const listed = r.threads || [];
    const ok = await fetchSummaries(listed);
    if (seq !== state.searchSeq) return; // a newer search or folder click won
    state.searchArgs = { q, folder };
    state.search = {
      q, title: folder?.name,
      ids: listed.map((t) => t.id).filter((id) => ok.has(id)),
      more: !!r.nextPageToken,
    };
    assign(columns());
    render();
    $('#board').scrollLeft = 0;
    setStatus('');
  } catch (e) {
    if (!(e instanceof AuthError)) toast('Could not load: ' + e.message);
    setStatus('');
  }
}

function clearSearch() {
  state.searchSeq++;
  state.search = null;
  state.searchArgs = null;
  state.folder = null;
  if (state.selectAll?.key < 0) state.selectAll = null;
  $('#search').value = '';
  render();
  renderSidebar();
}

// Sending a draft finishes the job it was opened for, so the Drafts column closes with it.
function closeDraftsFolder() {
  if (state.searchArgs?.folder?.label === 'DRAFT') clearSearch();
}

// ---------- selection & bulk actions ----------
// Column keys: board column index, or -1 for the search/folder column.

function columnThreadIds(key) {
  return key < 0 ? state.search?.ids || [] : state.board[key] || [];
}

function toggleSelect(id) {
  state.selectAll = null;
  if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
  render();
}

function toggleColumnSelect(key) {
  const ids = columnThreadIds(key);
  const all = ids.length > 0 && ids.every((id) => state.selected.has(id));
  state.selectAll = null;
  for (const id of ids) if (all) state.selected.delete(id); else state.selected.add(id);
  render();
}

function clearSelection() {
  state.selected.clear();
  state.selectAll = null;
  render();
}

// The column whose cards are exactly the current selection, if any.
function fullySelectedColumn() {
  const keys = [...(state.search ? [-1] : []), ...state.board.map((_, i) => i)];
  return keys.find((k) => {
    const ids = columnThreadIds(k);
    return ids.length && ids.length === state.selected.size && ids.every((id) => state.selected.has(id));
  });
}

const searchLabel = (name) => name.toLowerCase().replace(/[\s/]+/g, '-');

// What "everything in this column" means as a Gmail query.
function columnScope(key) {
  if (key < 0) {
    const { q, folder } = state.searchArgs;
    return { q: folder?.q || q || '', labelIds: folder?.label, spamTrash: folder?.spamTrash || searchesSpamTrash(q || ''), name: state.search.title || `“${q}”` };
  }
  const cols = columns();
  const col = cols[key];
  if (col.inbox) {
    const others = cols.slice(1).map((c) => `-label:${searchLabel(labelNameOf(c.name))}`).join(' ');
    return { q: `in:inbox ${others}`.trim(), name: col.name };
  }
  return { labelIds: state.labelIds[col.name], name: col.name };
}

function scopeParams(s, max, pageToken) {
  const p = new URLSearchParams({ maxResults: String(max) });
  if (s.q) p.set('q', s.q);
  if (s.labelIds) p.set('labelIds', s.labelIds);
  if (s.spamTrash) p.set('includeSpamTrash', 'true');
  if (pageToken) p.set('pageToken', pageToken);
  return p;
}

async function scopeTotal(s) {
  if (s.labelIds && !s.q) {
    const l = await api(`/labels/${encodeURIComponent(s.labelIds)}`);
    return { n: l.threadsTotal, exact: true };
  }
  const r = await api('/threads?' + scopeParams(s, 1));
  return { n: r.resultSizeEstimate || 0, exact: false };
}

function selectAllMatching(key) {
  const scope = columnScope(key);
  state.selectAll = { key, scope, total: null };
  renderBulk();
  scopeTotal(scope).then((total) => {
    if (state.selectAll?.scope === scope) { state.selectAll.total = total; renderBulk(); }
  }).catch((e) => { if (!(e instanceof AuthError)) toast(e.message); });
}

async function listAllMessageIds(scope) {
  const ids = [];
  let pageToken;
  do {
    const r = await api('/messages?' + scopeParams(scope, 500, pageToken));
    for (const m of r.messages || []) ids.push(m.id);
    pageToken = r.nextPageToken;
    setStatus(`Finding conversations… ${ids.length.toLocaleString()}`);
  } while (pageToken && ids.length < 100000);
  return ids;
}

async function batchModify(ids, add, remove) {
  for (let i = 0; i < ids.length; i += 1000) {
    setStatus(`Updating… ${Math.min(i + 1000, ids.length).toLocaleString()} of ${ids.length.toLocaleString()}`);
    await api('/messages/batchModify', {
      method: 'POST',
      body: { ids: ids.slice(i, i + 1000), addLabelIds: add, removeLabelIds: remove },
    });
  }
}

async function bulkChange(action, arg) {
  const cols = columns();
  const boardLabels = cols.slice(1).map((c) => state.labelIds[c.name]);
  const fromSpamTrash = state.selectAll?.scope.spamTrash || state.searchArgs?.folder?.spamTrash;
  if (action === 'archive') return { add: [], remove: ['INBOX', ...boardLabels], verb: 'Archived' };
  if (action === 'move') {
    const target = cols[arg];
    const tl = state.labelIds[target.name];
    return {
      add: [...(target.inbox ? [] : [tl]), ...(target.archive ? [] : ['INBOX'])],
      remove: [...boardLabels.filter((l) => l !== tl), ...(target.archive ? ['INBOX'] : []), ...(state.snoozeIds || []), ...(state.snoozeFlagId ? [state.snoozeFlagId] : []),
        ...(fromSpamTrash ? ['SPAM', 'TRASH'] : [])],
      verb: `Moved to ${target.name}`,
    };
  }
  if (action === 'labels') return arg;
  if (action === 'color') {
    const add = arg ? [await colorLabelId(arg)] : [];
    return { add, remove: Object.values(state.colorIds).filter((l) => !add.includes(l)), verb: arg ? `Colored ${arg.name}` : 'Color removed' };
  }
  return {
    spam: { add: ['SPAM'], remove: ['INBOX'], verb: 'Reported as spam' },
    trash: { add: ['TRASH'], remove: [], verb: 'Moved to Trash' },
    read: { add: [], remove: ['UNREAD'], verb: 'Marked read' },
    unread: { add: ['UNREAD'], remove: [], verb: 'Marked unread' },
  }[action];
}

async function refreshAfterBulk() {
  if (state.searchArgs) await runSearch(state.searchArgs.q, state.searchArgs.folder);
  await loadBoard();
}

async function runBulk(action, arg) {
  const all = state.selectAll;
  if (action === 'trash' && (all ? all.scope.labelIds === 'TRASH' : state.searchArgs?.folder?.label === 'TRASH')) {
    return bulkDeleteForever(all);
  }
  // Everything in a labelled column (not the Inbox, not a search), so deleting it all closes the column
  // too (Paul, 2026-11-03: "if I select all in a labeled column and delete everything, I want the column
  // to close").
  const whole = all ? all.key : (() => {
    const k = fullySelectedColumn();
    return k !== undefined && !(k < 0 ? state.search?.more : state.more[k]) ? k : undefined;
  })();
  try {
    const change = await bulkChange(action, arg);
    let count;
    let undo;
    if (all) {
      const t = all.total;
      const howMany = t ? `${t.exact ? '' : 'about '}${t.n.toLocaleString()}` : 'all';
      if (!await askConfirm(`${change.verb}: ${howMany} conversations in ${all.scope.name}. Continue?`, change.verb)) return;
      const ids = await listAllMessageIds(all.scope);
      await batchModify(ids, change.add, change.remove);
      count = t ? t.n : ids.length;
      undo = () => batchModify(ids, change.remove, change.add);
    } else {
      const ids = [...state.selected];
      if (action === 'move' || action === 'archive') {   // a nest moves together
        for (const id of [...ids]) for (const k of state.nestKids.get(id) || []) if (!ids.includes(k)) ids.push(k);
      }
      const modify = (add, remove) => mapLimit(ids, 5, (id) =>
        api(`/threads/${id}/modify`, { method: 'POST', body: { addLabelIds: add, removeLabelIds: remove } }));
      setStatus('Updating…');
      await modify(change.add, change.remove);
      count = ids.length;
      undo = () => modify(change.remove, change.add);
    }
    clearSelection();
    setStatus('');
    await refreshAfterBulk();
    toast(`${change.verb}: ${count.toLocaleString()} conversation${count === 1 ? '' : 's'}`, {
      label: 'Undo',
      run: async () => {
        try { await undo(); setStatus(''); await refreshAfterBulk(); }
        catch (e) { if (!(e instanceof AuthError)) toast('Undo failed: ' + e.message); }
      },
    });
    // Its Undo (and Ctrl+Z) brings the column back; the next one brings the emails back.
    if (action === 'trash' && whole > 0 && whole < columns().length) await removeColumn(whole, true);
    // A sidebar folder or search (Promotions, …) shown as the left column: emptied, it closes too.
    if (action === 'trash' && whole < 0 && state.search) clearSearch();
  } catch (e) {
    setStatus('');
    if (!(e instanceof AuthError)) toast('Could not update: ' + e.message);
  }
}

// Spam or Trash with nothing left in it: its column goes too.
function closeEmptiedFolder() {
  const label = state.searchArgs?.folder?.label;
  if ((label === 'SPAM' || label === 'TRASH') && !state.search?.ids.length && !state.search?.more) clearSearch();
}

async function bulkDeleteForever(all) {
  if (!all) {
    if (await deleteForever([...state.selected])) clearSelection();
    return;
  }
  const t = all.total;
  const howMany = t ? `${t.exact ? '' : 'about '}${t.n.toLocaleString()}` : 'all';
  if (!await askConfirm(`Delete ${howMany} conversations in ${all.scope.name} forever? This can't be undone.`, 'Delete forever')) return;
  try {
    const ids = await listAllMessageIds(all.scope);
    for (let i = 0; i < ids.length; i += 1000) {
      setStatus(`Deleting… ${Math.min(i + 1000, ids.length).toLocaleString()} of ${ids.length.toLocaleString()}`);
      await api('/messages/batchDelete', { method: 'POST', body: { ids: ids.slice(i, i + 1000) } });
    }
    clearSelection();
    setStatus('');
    await refreshAfterBulk();
    closeEmptiedFolder();
    toast(`Deleted forever: ${ids.length.toLocaleString()} messages`);
  } catch (e) {
    setStatus('');
    if (!(e instanceof AuthError)) toast('Could not delete: ' + e.message);
  }
}

// Spam and Trash's "delete all": no ticking boxes first (Paul, 2026-11-05).
async function deleteWholeFolder() {
  const scope = columnScope(-1);
  let total = null;
  try { total = await scopeTotal(scope); } catch (e) { if (e instanceof AuthError) return; }
  await bulkDeleteForever({ scope, total });
}

function linkButton(text, run) {
  const b = el('button', { class: 'link-btn' }, text);
  b.addEventListener('click', run);
  return b;
}

function renderBulk() {
  const bar = $('#bulk');
  const n = state.selected.size;
  $('#board').classList.toggle('selecting', n > 0);
  if (!n) { bar.hidden = true; return; }
  const cols = columns();
  const all = state.selectAll;
  const info = el('span', { class: 'bulk-info' });
  if (all) {
    const t = all.total;
    info.append(t
      ? `All ${t.exact ? '' : 'about '}${t.n.toLocaleString()} conversations in ${all.scope.name} are selected. `
      : `Counting conversations in ${all.scope.name}… `,
    linkButton('Select only these', () => { state.selectAll = null; renderBulk(); }));
  } else {
    info.append(`${n} selected`);
    const full = fullySelectedColumn();
    if (full !== undefined && (full < 0 ? state.search?.more : state.more[full])) {
      info.append(' · ', linkButton(`Select all conversations in ${columnScope(full).name}`, () => selectAllMatching(full)));
    }
  }
  const move = el('select', { 'aria-label': 'Move to column' }, [
    el('option', { value: '' }, 'Move to…'),
    ...cols.map((c, i) => el('option', { value: String(i) }, c.name)),
  ]);
  move.addEventListener('change', () => { if (move.value !== '') runBulk('move', Number(move.value)); });
  const color = el('button', {}, [icon('palette'), ' Color']);
  color.classList.add('color-btn');
  color.addEventListener('click', (e) => { e.stopPropagation(); openColorPicker(color, null, (c) => runBulk('color', c)); });
  const act = (label, action) => { const b = el('button', {}, label); b.addEventListener('click', () => runBulk(action)); return b; };
  const close = el('button', { class: 'icon-btn', title: 'Clear selection', 'aria-label': 'Clear selection' }, '✕');
  close.addEventListener('click', clearSelection);
  bar.replaceChildren(info, el('div', { class: 'bulk-actions' }, [
    move, color, act('Archive', 'archive'), act('Spam', 'spam'), act(state.searchArgs?.folder?.label === 'TRASH' ? 'Delete forever' : 'Delete', 'trash'),
    act('Mark read', 'read'), act('Mark unread', 'unread'), close,
  ]));
  bar.hidden = false;
}

function checkbox(label, checked, onChange) {
  const box = el('input', { type: 'checkbox', class: 'pick', 'aria-label': label, title: label, draggable: 'false' });
  box.checked = checked;
  box.addEventListener('click', (e) => e.stopPropagation());
  box.addEventListener('change', onChange);
  return box;
}

function columnCheckbox(key) {
  const ids = columnThreadIds(key);
  const picked = ids.filter((id) => state.selected.has(id)).length;
  const box = checkbox('Select all in this column', ids.length > 0 && picked === ids.length, () => toggleColumnSelect(key));
  box.indeterminate = picked > 0 && picked < ids.length;
  return box;
}

// ---------- sidebar ----------

const FOLDERS = [
  { name: 'Inbox', icon: 'inbox', label: 'INBOX', count: 'unread', board: true },
  { name: 'Snoozed', icon: 'clock', q: 'in:snoozed' },                     // Gmail's own snoozes only
  // Mailboard's snoozes only (the "Mailboard Snoozed" label, plus the wake-time labels in case it was removed)
  { name: 'Mailboard Snoozed', icon: 'clock', get q() { return ['label:mailboard-snoozed', ...(state.snoozeLabels || []).map((l) => 'label:' + l.name.toLowerCase().replace(/[/\s]/g, '-'))].join(' OR '); } },
  { name: 'Sent', icon: 'send', label: 'SENT' },
  { name: 'Drafts', icon: 'draft', label: 'DRAFT', count: 'total' },
  { name: 'All Mail', icon: 'allmail' },
  { name: 'Spam', icon: 'spam', label: 'SPAM', count: 'unread', spamTrash: true },
  { name: 'Trash', icon: 'trash', label: 'TRASH', spamTrash: true },
  { name: 'Purchases', icon: 'bag', q: 'category:purchases' },
  // Gmail's own search, like Purchases: the CATEGORY_PROMOTIONS label filter came back empty (Paul, 2026-11-03);
  // the label is still used for the unread count.
  { name: 'Promotions', icon: 'offer', q: 'category:promotions', countLabel: 'CATEGORY_PROMOTIONS', count: 'unread' },
  { name: 'Starred', icon: 'star', label: 'STARRED' },
  { name: 'Important', icon: 'important', label: 'IMPORTANT' },
  { name: 'Scheduled', icon: 'clock', q: 'in:scheduled' },
];

async function loadCounts() {
  const ids = [
    ...FOLDERS.filter((f) => f.count).map((f) => f.countLabel || f.label),
    ...state.userLabels.slice(0, 40).map((l) => l.id),
  ];
  const got = await Promise.all(ids.map((id) =>
    api(`/labels/${encodeURIComponent(id)}`).catch((e) => { if (e instanceof AuthError) throw e; return null; })));
  for (const l of got) if (l) state.labelCounts[l.id] = l;
  renderSidebar();
}

// Gmail doesn't let apps hide its system folders, so that choice is kept per browser.
const hiddenFolders = new Set(store.get('hiddenFolders', []));

function navItem(name, iconName, n, active, onClick, onMenu, iconColor, onDrop) {
  const main = el('button', { class: 'nav-main' }, [
    icon(iconName), el('span', { class: 'nav-name' }, name), n ? el('span', { class: 'n' }, n.toLocaleString()) : null,
  ]);
  if (iconColor) main.firstChild.style.fill = iconColor;
  main.addEventListener('click', onClick);
  const row = el('div', { class: 'nav-item' + (active ? ' active' : '') + (n ? ' has-count' : '') }, [main]);
  if (onMenu) {
    const more = el('button', { class: 'nav-menu', title: 'Options', 'aria-label': `Options for ${name}` }, '⋮');
    more.addEventListener('click', (e) => { e.stopPropagation(); onMenu(more); });
    row.append(more);
  }
  if (onDrop) {
    row.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes(COLUMN_DRAG)) return;
      e.preventDefault();
      row.classList.add('drop');
    });
    row.addEventListener('dragleave', (e) => { if (!row.contains(e.relatedTarget)) row.classList.remove('drop'); });
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drop');
      state.dragging = false;
      const id = e.dataTransfer.getData('text/plain');
      if (id) onDrop(id);
    });
  }
  return row;
}

// Add/remove labels on one thread, with undo.
async function labelThread(id, add, remove, verb) {
  const t = state.threads.get(id);
  if (!t) return;
  const apply = async (a, r) => {
    a.forEach((l) => t.labels.add(l));
    r.forEach((l) => t.labels.delete(l));
    assign(columns());
    render();
    refreshReaderActions(id);
    await api(`/threads/${id}/modify`, { method: 'POST', body: { addLabelIds: a, removeLabelIds: r } });
  };
  try {
    await apply(add, remove);
    toast(verb, { label: 'Undo', run: () => apply(remove, add).catch((e) => toast(e.message)) });
  } catch (e) {
    if (!(e instanceof AuthError)) toast('Could not update: ' + e.message);
  }
}

// Dropping a card on a sidebar folder or label, Gmail-style. Returns null
// for folders that can't take a drop (Sent, Drafts, Snoozed, …).
function navDropHandler(target) {
  const many = (id) => state.selected.has(id) && state.selected.size > 1 && !state.selectAll;
  const pick = (one, bulk) => (id) => (many(id) ? runBulk(...bulk) : one(id));
  const addLabel = (labelId, verb, move) => {
    // Off the board's columns, but never out of Gmail's Inbox: StediMail doesn't rearrange a tester's
    // Gmail inbox (Paul's rule). Only Archive takes an email out of the Inbox.
    const offBoard = () => columns().slice(1).map((c) => state.labelIds[c.name]).filter((l) => l !== labelId);
    return pick(
      (id) => {
        const t = state.threads.get(id);
        const remove = move && t ? offBoard().filter((l) => t.labels.has(l)) : [];
        return labelThread(id, [labelId], remove, verb);
      },
      ['labels', { add: [labelId], remove: move ? offBoard() : [], verb }],
    );
  };
  if (target.userLabel) return addLabel(target.userLabel.id, `Labelled “${target.userLabel.name}”. It stays in your Gmail Inbox.`, true);
  switch (target.name) {
    case 'Inbox': return pick((id) => moveWithUndo(id, 0), ['move', 0]);
    case 'All Mail': return pick(archiveThread, ['archive']);
    case 'Spam': return pick(spamThread, ['spam']);
    case 'Trash': return pick(trashThread, ['trash']);
    case 'Starred': return addLabel('STARRED', 'Starred', false);
    case 'Important': return addLabel('IMPORTANT', 'Marked important', false);
    default: return null;
  }
}

function navToggle(open, onClick) {
  const b = el('button', { class: 'nav-toggle' }, [el('span', { class: 'chev' }, open ? '⌃' : '⌄'), open ? 'Less' : 'More']);
  b.addEventListener('click', onClick);
  return b;
}

function renderSidebar() {
  const nav = $('#sidebar');
  if (!nav) return;
  const counts = state.labelCounts;

  const folderRow = (f) => {
    const c = (f.countLabel || f.label) && counts[f.countLabel || f.label];
    const n = !c ? 0 : f.count === 'total' ? c.messagesTotal : f.count === 'unread' ? c.threadsUnread : 0;
    const active = f.board ? !state.search : state.folder === f.name;
    return navItem(f.name, f.icon, n, active, () => (f.board ? clearSearch() : runSearch('', f)),
      f.board ? null : (anchor) => openFolderMenu(anchor, f), null, navDropHandler(f));
  };
  const shownFolders = FOLDERS.filter((f) => f.board || !hiddenFolders.has(f.name));
  const moreFolders = FOLDERS.filter((f) => !f.board && hiddenFolders.has(f.name));

  const unreadOf = (l) => counts[l.id]?.threadsUnread || 0;
  const labelShown = (l) => l.labelListVisibility === 'labelShowIfUnread' ? unreadOf(l) > 0 : l.labelListVisibility !== 'labelHide';
  const labelRow = (l) => navItem(l.name, 'label', unreadOf(l), state.folder === l.name,
    () => runSearch('', { name: l.name, label: l.id }), (anchor) => openLabelMenu(anchor, l), l.color?.backgroundColor,
    navDropHandler({ userLabel: l }));
  const shownLabels = state.userLabels.filter(labelShown);
  const moreLabels = state.userLabels.filter((l) => !labelShown(l));

  const add = el('button', { class: 'icon-btn', title: 'Create new label', 'aria-label': 'Create new label' }, '+');
  add.addEventListener('click', () => createLabel(''));

  nav.replaceChildren(...[ // null = a toggle that isn't needed; replaceChildren would print it as "null"
    ...shownFolders.map(folderRow),
    ...(state.navMore ? moreFolders.map(folderRow) : []),
    moreFolders.length ? navToggle(state.navMore, () => { state.navMore = !state.navMore; store.set('navMore', state.navMore); renderSidebar(); }) : null,
    el('div', { class: 'nav-item nav-demo' }, [el('a', { class: 'nav-main', href: '/videos/', target: '_blank' }, [icon('play'), el('span', { class: 'nav-name' }, 'Demo videos')])]),
    el('div', { class: 'nav-head' }, [el('span', {}, 'Labels'), add]),
    ...shownLabels.map(labelRow),
    ...(state.labelsMore ? moreLabels.map(labelRow) : []),
    moreLabels.length ? navToggle(state.labelsMore, () => { state.labelsMore = !state.labelsMore; store.set('labelsMore', state.labelsMore); renderSidebar(); }) : null,
  ].filter(Boolean));
}

// ----- sidebar menus -----

function placePopup(pop, anchor) {
  const r = anchor.getBoundingClientRect();
  pop.style.top = Math.max(8, Math.min(r.bottom + 4, innerHeight - pop.offsetHeight - 8)) + 'px';
  pop.style.left = Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8)) + 'px';
}

function closeMenu() { $('#menu')?.remove(); }

// items: { heading } | { sep: true } | { swatches: true, current, run(color|null) } | { label, checked, run }
function openMenu(anchor, items) {
  closeMenu();
  closeColorPicker();
  const menu = el('div', { class: 'menu', id: 'menu', role: 'menu' });
  const pick = (run) => (e) => { e.stopPropagation(); closeMenu(); run(); };
  for (const it of items) {
    if (it.sep) menu.append(el('hr'));
    else if (it.heading) menu.append(el('div', { class: 'menu-head' }, it.heading));
    else if (it.swatches) {
      const row = el('div', { class: 'menu-swatches' });
      for (const c of [...COLORS, null]) {
        const b = el('button', {
          class: 'swatch' + (c ? '' : ' none') + (c && c.bg === it.current ? ' current' : ''),
          title: c ? c.name : 'No color', 'aria-label': c ? c.name : 'No color', style: c ? `--swatch:${c.bg}` : null,
        }, c ? null : '✕');
        b.addEventListener('click', pick(() => it.run(c)));
        row.append(b);
      }
      menu.append(row);
    } else {
      const b = el('button', { class: 'menu-item', role: 'menuitem' }, [el('span', { class: 'tick' }, it.checked ? '✓' : ''), it.label]);
      b.addEventListener('click', pick(it.run));
      menu.append(b);
    }
  }
  document.body.append(menu);
  placePopup(menu, anchor);
  menu.querySelector('button')?.focus();
  setTimeout(() => document.addEventListener('click', closeMenu, { once: true }));
}

function openFolderMenu(anchor, f) {
  const set = (hide) => {
    if (hide) hiddenFolders.add(f.name); else hiddenFolders.delete(f.name);
    store.set('hiddenFolders', [...hiddenFolders]);
    renderSidebar();
  };
  const hidden = hiddenFolders.has(f.name);
  openMenu(anchor, [
    { heading: 'In label list' },
    { label: 'Show', checked: !hidden, run: () => set(false) },
    { label: 'Hide', checked: hidden, run: () => set(true) },
  ]);
}

function openLabelMenu(anchor, l) {
  const list = l.labelListVisibility || 'labelShow';
  const msgs = l.messageListVisibility || 'show';
  openMenu(anchor, [
    { heading: 'Label color' },
    { swatches: true, current: l.color?.backgroundColor, run: (c) => setLabelColor(l, c) },
    { sep: true },
    { heading: 'In label list' },
    { label: 'Show', checked: list === 'labelShow', run: () => patchLabel(l, { labelListVisibility: 'labelShow' }) },
    { label: 'Show if unread', checked: list === 'labelShowIfUnread', run: () => patchLabel(l, { labelListVisibility: 'labelShowIfUnread' }) },
    { label: 'Hide', checked: list === 'labelHide', run: () => patchLabel(l, { labelListVisibility: 'labelHide' }) },
    { sep: true },
    { heading: 'In message list' },
    { label: 'Show', checked: msgs === 'show', run: () => patchLabel(l, { messageListVisibility: 'show' }) },
    { label: 'Hide', checked: msgs === 'hide', run: () => patchLabel(l, { messageListVisibility: 'hide' }) },
    { sep: true },
    ...(columnOfLabel(l) ? [
      { label: `This label is the “${columnOfLabel(l)}” column: rename or remove it there`, run: () => {} },
    ] : [
      { label: 'Edit', run: () => renameUserLabel(l) },
      { label: 'Remove label', run: () => removeUserLabel(l) },
    ]),
    { label: 'Add sublabel', run: () => createLabel(l.name + '/') },
  ]);
}

function columnOfLabel(l) {
  return settings.columns.find((c) => labelNameOf(c) === l.name) || null;
}

function storeUserLabel(updated) {
  const i = state.userLabels.findIndex((x) => x.id === updated.id);
  if (i >= 0) state.userLabels[i] = { ...state.userLabels[i], ...updated };
  else state.userLabels.push(updated);
  state.userLabels.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  renderSidebar();
}

async function patchLabel(l, body) {
  try {
    storeUserLabel(await api(`/labels/${l.id}`, { method: 'PATCH', body }));
  } catch (e) {
    if (!(e instanceof AuthError)) toast('Could not change label: ' + e.message);
  }
}

async function setLabelColor(l, c) {
  if (c) {
    const textColor = ['Orange', 'Yellow', 'Pink'].includes(c.name) ? '#000000' : '#ffffff';
    return patchLabel(l, { color: { backgroundColor: c.bg, textColor } });
  }
  // A full update without a color clears it.
  try {
    const { id, name, labelListVisibility, messageListVisibility } = l;
    const updated = await api(`/labels/${id}`, { method: 'PUT', body: { id, name, labelListVisibility, messageListVisibility } });
    state.userLabels = state.userLabels.filter((x) => x.id !== id);
    storeUserLabel(updated);
  } catch (e) {
    if (!(e instanceof AuthError)) toast('Could not change label: ' + e.message);
  }
}

async function renameUserLabel(l) {
  const name = prompt('Rename label', l.name)?.trim();
  if (!name || name === l.name) return;
  const wasShowing = state.folder === l.name;
  await patchLabel(l, { name });
  if (wasShowing) state.folder = name;
}

// ---------- Feedback: a tester's bug report or request, sent from their own Gmail ----------
// Goes to the beta address (forwarded to Paul). Shows exactly what is sent before sending; no email
// content is included, only what the tester types, the technical details listed, and any screenshot they attach.
const REPORT_TO = 'beta@stedimail.com';
const REPORT_SHOT_LIMIT = 10e6;
const SCREENSHOT_SETTLE_MS = 500;   // the browser's share window has to finish closing
const recentErrors = [];
window.addEventListener('error', (e) => { recentErrors.push(`${new Date().toISOString()} ${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`); recentErrors.splice(0, recentErrors.length - 10); });
window.addEventListener('unhandledrejection', (e) => { recentErrors.push(`${new Date().toISOString()} ${e.reason?.message || e.reason}`); recentErrors.splice(0, recentErrors.length - 10); });

function appVersion() {
  return document.querySelector('script[src^="app.js"]')?.getAttribute('src').split('v=')[1] || 'unknown';
}

function reportDetails() {
  return [
    `StediMail version: ${appVersion()}`,
    `Address: ${location.origin}`,
    `Browser: ${navigator.userAgent}`,
    `Screen: ${screen.width}×${screen.height}, window ${innerWidth}×${innerHeight}, zoom ${Math.round(devicePixelRatio * 100)}%`,
    `Columns: ${settings.columns.length} (${settings.columns.filter(isOwnLabel).length} of them your own labels)`,
    `Time: ${new Date().toString()}`,
    `Recent errors: ${recentErrors.length ? '\n  ' + recentErrors.join('\n  ') : 'none'}`,
  ].join('\n');
}

function openReport() {
  const dlg = el('dialog', { class: 'report', 'aria-label': 'Feedback' });
  let kind = null;
  const close = () => { dlg.close(); dlg.remove(); };
  const choose = () => {
    const wrong = el('button', { type: 'button', class: 'big-choice' }, 'Something’s wrong');
    const want = el('button', { type: 'button', class: 'big-choice' }, 'I have a request');
    const cancel = el('button', { type: 'button' }, 'Cancel');
    wrong.addEventListener('click', () => { kind = 'issue'; write(); });
    want.addEventListener('click', () => { kind = 'request'; write(); });
    cancel.addEventListener('click', close);
    dlg.replaceChildren(el('h2', {}, 'Feedback'), el('div', { class: 'big-choices' }, [wrong, want]),
      el('div', { class: 'ask-buttons' }, [cancel]));
  };
  const write = () => {
    const text = el('textarea', { rows: '6', 'aria-label': kind === 'issue' ? 'What went wrong' : 'What you would like',
      placeholder: kind === 'issue' ? 'What happened, and what did you expect? (Voice typing works here.)'
        : 'What would you like StediMail to do? (Voice typing works here.)' });
    const details = reportDetails();
    const show = el('details', {}, [el('summary', {}, 'What else is sent (no emails, apart from any on your screenshot)'),
      el('pre', {}, `To: ${REPORT_TO}\nFrom: your Gmail${state.me ? ' (' + state.me + ')' : ''}\n\n${details}`)]);
    // One screenshot: taken here, picked from a file or pasted. It can show emails, so it's shown here before it's sent.
    let shot = null;
    const shotBox = el('div', { class: 'report-shot' });
    const picker = el('input', { type: 'file', accept: 'image/*', hidden: '' });
    const attach = el('button', { type: 'button' }, 'Attach screenshot');
    const take = el('button', { type: 'button' }, 'Take screenshot');
    const shotButtons = el('div', { class: 'report-shot-buttons' }, [...(navigator.mediaDevices?.getDisplayMedia ? [take] : []), attach]);
    const useShot = (file) => {
      if (!file.type.startsWith('image/')) { toast('Please choose a picture.'); return; }
      if (file.size > REPORT_SHOT_LIMIT) { toast(`That picture is too big (${fileSize(file.size)}). The limit is ${fileSize(REPORT_SHOT_LIMIT)}.`); return; }
      shot = file;
      const remove = el('button', { type: 'button' }, 'Remove screenshot');
      remove.addEventListener('click', () => { shot = null; shotBox.replaceChildren(shotButtons); shotButtons.firstChild.focus(); });
      shotBox.replaceChildren(
        el('img', { src: URL.createObjectURL(file), alt: 'The screenshot you are sending' }),
        el('p', { class: 'hint' }, 'Check that it doesn\u2019t show anything private. Any emails on it are sent too.'),
        remove);
    };
    attach.addEventListener('click', () => picker.click());
    // The browser insists on asking what to share. This box steps aside first, so it isn't in the picture.
    take.addEventListener('click', async () => {
      dlg.close();
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false, preferCurrentTab: true })
          .catch((e) => { if (e.name === 'NotAllowedError') return null; throw e; });   // null: they said no
        if (stream) {
          try {
            const video = el('video');
            video.muted = true;
            video.srcObject = stream;
            await video.play();
            await new Promise((done) => setTimeout(done, SCREENSHOT_SETTLE_MS));
            const canvas = el('canvas', { width: String(video.videoWidth), height: String(video.videoHeight) });
            canvas.getContext('2d').drawImage(video, 0, 0);
            const blob = await new Promise((done) => canvas.toBlob(done, 'image/png'));
            useShot(new File([blob], 'screenshot.png', { type: 'image/png' }));
          } finally {
            stream.getTracks().forEach((t) => t.stop());
          }
        }
      } catch (e) {
        toast('Could not take the screenshot: ' + e.message);
      }
      dlg.showModal();
    });
    picker.addEventListener('change', () => { if (picker.files[0]) useShot(picker.files[0]); picker.value = ''; });
    dlg.onpaste = (e) => {
      const file = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'));
      if (file) { e.preventDefault(); useShot(file); }
    };
    shotBox.append(shotButtons);
    const back = el('button', { type: 'button' }, 'Back');
    const send = el('button', { type: 'button', class: 'primary' }, 'Send');
    back.addEventListener('click', () => { dlg.onpaste = null; choose(); });
    send.addEventListener('click', async () => {
      const said = text.value.trim();
      if (!said) { text.focus(); toast('Please say what happened first.'); return; }
      send.disabled = true; send.textContent = 'Sending…';
      const subject = `[StediMail ${kind}] ${said.split(/\s+/).slice(0, 8).join(' ')}${said.split(/\s+/).length > 8 ? '…' : ''}`;
      try {
        await sendMail({ To: REPORT_TO, Subject: subject }, `${said}\n\n---\n${details}\n`, undefined, shot ? { files: [shot] } : {});
        close();
        toast('Sent. Thank you!');
      } catch (e) {
        send.disabled = false; send.textContent = 'Send';
        if (!(e instanceof AuthError)) toast('Could not send: ' + e.message);
      }
    });
    dlg.replaceChildren(el('h2', {}, kind === 'issue' ? 'Something’s wrong' : 'I have a request'), text, shotBox, picker, show,
      el('div', { class: 'ask-buttons' }, [back, send]));
    text.focus();
  };
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  document.body.append(dlg);
  choose();
  dlg.showModal();
}

// Yes/no for things that can't be undone. Not the browser's confirm(): there OK has the focus, so a stray
// or repeated Enter/Space (a shaky key press, a voice-typing key) says yes before it's read. Here Cancel
// has the focus, the OK button only works after ARM_MS, and Esc or a click outside cancels.
const ARM_MS = 900;
function askConfirm(message, okLabel = 'OK') {
  return new Promise((resolve) => {
    const dlg = el('dialog', { class: 'ask', 'aria-label': 'Please confirm' });
    const cancel = el('button', { type: 'button' }, 'Cancel');
    const ok = el('button', { type: 'button', class: 'danger', disabled: '' }, okLabel);
    const parts = String(message).split('\n\n');
    dlg.append(...parts.map((p, i) => el('p', { class: i ? 'hint' : '' }, p)), el('div', { class: 'ask-buttons' }, [cancel, ok]));
    let done = false;
    const finish = (yes) => { if (done) return; done = true; dlg.close(); dlg.remove(); resolve(yes); };
    cancel.addEventListener('click', () => finish(false));
    ok.addEventListener('click', () => { if (!ok.disabled) finish(true); });
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(false); });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) finish(false); });   // the backdrop
    document.body.append(dlg);
    dlg.showModal();
    cancel.focus();
    setTimeout(() => ok.removeAttribute('disabled'), ARM_MS);
  });
}

// Every message with a label (not Spam/Trash), for putting them back in the Inbox before the label goes.
async function messagesWithLabel(id) {
  const ids = [];
  let page = '';
  do {
    const r = await api(`/messages?${new URLSearchParams({ labelIds: id, maxResults: '500', ...(page ? { pageToken: page } : {}) })}`);
    for (const m of r.messages || []) ids.push(m.id);
    page = r.nextPageToken || '';
  } while (page);
  return ids;
}

async function removeUserLabel(l) {
  let ids = [];
  try { ids = await messagesWithLabel(l.id); } catch (e) { if (e instanceof AuthError) return; }
  const what = ids.length ? `\n\nIts ${ids.length} email${ids.length === 1 ? '' : 's'} will go back to your Inbox.` : '\n\nIt has no emails.';
  if (!await askConfirm(`Remove the label “${l.name}”?${what}`, 'Remove label')) return;
  try {
    for (let i = 0; i < ids.length; i += 1000) {      // back to the Inbox first, so nothing ends up out of sight
      await api('/messages/batchModify', { method: 'POST', body: { ids: ids.slice(i, i + 1000), addLabelIds: ['INBOX'] } });
    }
    await api(`/labels/${l.id}`, { method: 'DELETE' });
    state.userLabels = state.userLabels.filter((x) => x.id !== l.id);
    state.spareBoardLabels = (state.spareBoardLabels || []).filter((n) => LABEL_PREFIX + n !== l.name);
    if (state.folder === l.name) clearSearch();
    renderSidebar();
    toast(ids.length ? `Removed label “${l.name}”. ${ids.length} email${ids.length === 1 ? '' : 's'} back in your Inbox.` : `Removed label “${l.name}”`);
    if (ids.length) loadBoard();
  } catch (e) {
    if (!(e instanceof AuthError)) toast('Could not remove label: ' + e.message);
  }
}

async function createLabel(prefix) {
  const name = prompt(prefix ? `New sublabel under “${prefix.slice(0, -1)}”` : 'New label name')?.trim().replace(/^\/+|\/+$/g, '');
  if (!name) return;
  try {
    storeUserLabel(await api('/labels', {
      method: 'POST',
      body: { name: prefix + name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
    }));
  } catch (e) {
    if (!(e instanceof AuthError)) toast('Could not create label: ' + e.message);
  }
}

function setSidebar(open) {
  state.sidebarOpen = open;
  store.set('sidebar', open);
  $('#sidebar').hidden = !open;
}

// Emails put back into the Inbox (woken from snooze by Gmail or Mailboard, or moved back elsewhere) sort
// by when they came back, like Gmail puts them at the top. Gmail's change history says which ones;
// they're loaded even when they're older than the newest 100 the Inbox column normally shows.
state.bumps = Object.fromEntries(Object.entries(store.get('bumps', {})).filter(([, t]) => Date.now() - t < 14 * 864e5));
const sortTime = (t) => Math.max(t.date || 0, state.bumps[t.id] || 0);

async function checkReturned() {
  let start = store.get('historyId', null);
  if (!start) { store.set('historyId', (await api('/profile')).historyId); return; }
  const back = new Set();
  let latest = start, page = '';
  try {
    do {
      const r = await api(`/history?startHistoryId=${start}&historyTypes=labelAdded&labelId=INBOX&maxResults=500${page ? '&pageToken=' + page : ''}`);
      for (const h of r.history || []) for (const a of h.labelsAdded || []) {
        if ((a.labelIds || []).includes('INBOX') && a.message?.threadId) back.add(a.message.threadId);
      }
      latest = r.historyId || latest;
      page = r.nextPageToken;
    } while (page);
  } catch (e) {
    if (e instanceof AuthError) throw e;
    latest = (await api('/profile')).historyId;       // history too old to read: start fresh from now
  }
  store.set('historyId', latest);
  const now = Date.now();
  for (const id of back) state.bumps[id] = now;
  store.set('bumps', state.bumps);
}

// A collapsed column can't show a new email, so it turns red until it's opened. New = newer than any email
// seen on the board, so moving an older card into the column doesn't set it off; Paul's own replies and drafts
// aren't new mail. The mark survives a reload, and so does what's been seen, so mail that came while
// StediMail was closed counts too.
function flagCollapsedNewMail(cols) {
  const incoming = (id) => { const t = state.threads.get(id); return t && !t.replied && !t.labels.has('DRAFT') ? t : null; };
  const seen = store.get('newestSeen', null);
  let newest = seen ?? 0;
  const marks = new Set(store.get('newMailCols', []));
  cols.forEach((col, i) => {
    const dates = (state.board[i] || []).map(incoming).filter(Boolean).map((t) => t.date);
    newest = Math.max(newest, ...dates);
    if (seen != null && settings.collapsedCols.includes(col.name) && dates.some((d) => d > seen)) marks.add(col.name);
  });
  store.set('newestSeen', newest);
  store.set('newMailCols', [...marks]);
}

// True when an email newer than any seen so far reached the Inbox column, so it can be brought into view.
// Paul's own replies also make a thread newer, but they aren't new mail. Only sorts that put it on top count.
function inboxGotNewMail(cols) {
  const inbox = cols.findIndex((c) => c.inbox);
  if (inbox < 0) return false;
  const newest = Math.max(0, ...state.board[inbox].map((id) => state.threads.get(id)).filter((t) => !t.replied).map(sortTime));
  const isNew = state.inboxNewest != null && newest > state.inboxNewest;
  state.inboxNewest = Math.max(state.inboxNewest ?? 0, newest);
  return isNew && ['newest', 'unread'].includes(sortOf(cols[inbox]).key);
}

// Jumping the column under the pointer could put a different email where Paul is aiming, so while the
// pointer is over it, wait until the mouse rests. A small shake within STILL_PX counts as resting.
const STILL_PX = 30, STILL_MS = 1000;
const pointer = { x: -1, y: -1, anchorX: -1, anchorY: -1, movedAt: 0 };
document.addEventListener('pointermove', (e) => {
  pointer.x = e.clientX; pointer.y = e.clientY;
  if (Math.hypot(e.clientX - pointer.anchorX, e.clientY - pointer.anchorY) > STILL_PX) {
    pointer.anchorX = e.clientX; pointer.anchorY = e.clientY; pointer.movedAt = Date.now();
  }
}, { passive: true, capture: true });
document.addEventListener('wheel', () => { pointer.movedAt = Date.now(); }, { passive: true, capture: true });
let inboxTopTimer = null;
function bringInboxToTop() {
  clearTimeout(inboxTopTimer);
  const cards = $('#board').querySelectorAll('.cards')[state.search ? 1 : 0];
  const aiming = cards && document.elementFromPoint(pointer.x, pointer.y)?.closest('.cards') === cards
    && Date.now() - pointer.movedAt < STILL_MS;
  if (aiming || state.dragging || state.armedDelete) { inboxTopTimer = setTimeout(bringInboxToTop, 200); return; }
  cards?.scrollTo({ top: 0 });
}

async function loadBoard() {
  if (state.loading || state.dragging || state.addingColumn || state.typingCardLabel || !state.token) return;
  state.loading = true;
  setStatus('Loading…');
  try {
    if (!settings.columnsSaved) await adoptColumns();
    if (state.pickLabels) { const l = state.pickLabels; state.pickLabels = null; setTimeout(() => showLabelPicker(l), 0); }
    const cols = columns();
    await ensureLabels(cols);
    await wakeDueSnoozes();
    await checkReturned();
    const lists = await Promise.all(cols.map((col) => {
      const p = new URLSearchParams({
        maxResults: col.archive ? '30' : '100',
        labelIds: col.inbox ? 'INBOX' : state.labelIds[col.name],
      });
      return api('/threads?' + p);
    }));
    state.more = lists.map((r) => !!r.nextPageToken);
    const listed = new Map();
    for (const t of lists.flatMap((r) => r.threads || [])) listed.set(t.id, t);
    if (state.nestFlagId) {                              // nests stay together, however old their emails are
      const nested = await api('/threads?' + new URLSearchParams({ maxResults: '500', labelIds: state.nestFlagId }));
      for (const t of nested.threads || []) if (!listed.has(t.id)) listed.set(t.id, t);
    }
    for (const id of Object.keys(state.bumps)) {         // returned emails, even if older than the newest 100
      if (!listed.has(id)) listed.set(id, { id, historyId: '' });    // '' = always re-check (few of these; catches archiving elsewhere)
    }
    const seen = await fetchSummaries([...listed.values()]);
    // Only the Inbox sorts by when an email came back. Moving a thread to a column adds INBOX to any of its
    // messages that lacked it (Paul's own replies, say), which Gmail's history reports just like a real return.
    for (const id of Object.keys(state.bumps)) {
      const t = state.threads.get(id);
      if (!t || columnOf(t, cols) !== 0) delete state.bumps[id];
    }
    store.set('bumps', state.bumps);
    for (const id of state.search?.ids || []) seen.add(id);
    for (const id of [...state.threads.keys()]) if (!seen.has(id)) state.threads.delete(id);
    assign(cols);
    flagCollapsedNewMail(cols);
    const newMail = inboxGotNewMail(cols);
    render();
    if (newMail) bringInboxToTop();
    state.lastLoad = Date.now();
    setStatus('Updated ' + dateLabel(Date.now()));
    await loadCounts();
  } catch (e) {
    if (!(e instanceof AuthError)) toast('Could not load mail: ' + e.message);
    setStatus('');
  } finally {
    state.loading = false;
  }
}

// New mail shows up by itself: Gmail's mailbox history number changes with every change, and asking for
// it is cheap, so check it often and only reload the board when it moved. Waits while a reload would get
// in the way (the change stays unseen, so the next check picks it up).
async function watchMailbox() {
  if (document.visibilityState === 'visible') renewSignIn();
  if (document.visibilityState !== 'visible' || !state.token || state.loading || state.dragging
    || state.addingColumn || state.typingCardLabel || state.armedDelete || $('#menu') || $('#color-pop')) return;
  try {
    const { historyId } = await api('/profile');
    const changed = state.watchedHistory && historyId !== state.watchedHistory;
    state.watchedHistory = historyId;
    if (changed) await loadBoard();
  } catch {} // offline or signed out: the banner and the regular refresh deal with it
}

async function moveThread(id, colIdx) {
  const cols = columns();
  const t = state.threads.get(id);
  if (!t) return false;
  const target = cols[colIdx];
  const targetLabel = state.labelIds[target.name];
  const add = [];
  const remove = cols.slice(1).map((c) => state.labelIds[c.name]).filter((l) => l !== targetLabel);
  if (!target.inbox) add.push(targetLabel);
  if (target.archive) remove.push('INBOX'); else add.push('INBOX');
  remove.push(...[...t.labels].filter((l) => state.snoozeIds?.has(l) || l === state.snoozeFlagId));   // moved = no longer snoozed
  // Dragging out of the Spam or Trash folder rescues the thread.
  for (const l of ['SPAM', 'TRASH']) if (t.labels.has(l)) remove.push(l);

  const before = new Set(t.labels);
  add.forEach((l) => t.labels.add(l));
  remove.forEach((l) => t.labels.delete(l));
  const kids = state.nestKids.get(id) || [];             // a nest moves together
  assign(cols);
  render();
  refreshReaderActions(id);
  try {
    await api(`/threads/${id}/modify`, { method: 'POST', body: { addLabelIds: add, removeLabelIds: remove } });
    await Promise.all(kids.map((k) => moveThread(k, colIdx)));
    return true;
  } catch (e) {
    t.labels = before;
    assign(cols);
    render();
    refreshReaderActions(id);
    if (!(e instanceof AuthError)) toast('Could not move: ' + e.message);
    return false;
  }
}

async function moveWithUndo(id, colIdx) {
  const cols = columns();
  const t = state.threads.get(id);
  if (!t) return;
  const prev = columnOf(t, cols);
  const parent = state.nestOf.get(id) || null;
  if (prev === colIdx) {                                 // dragged off its parent, within the column
    if (parent) await unnestWithUndo(id);
    return;
  }
  if (parent) await setNest(id, null);                   // dragged to another column: out of the nest
  if (await moveThread(id, colIdx)) {
    toast(`Moved to ${cols[colIdx].name}`, prev < 0 ? null : { label: 'Undo', run: async () => {
      await moveThread(id, prev);
      if (parent) await setNest(id, parent);
    } });
  }
}

// Archive = take the thread out of the Inbox and off the board (no column label), like Gmail's
// Archive. Dragging it to an archiving last column is the way to archive it into that column.
async function archiveThread(id) {
  const cols = columns();
  const t = state.threads.get(id);
  if (!t) return;
  // StediMail's own column labels come off; the person's own labels stay (Gmail's Archive keeps labels too).
  const all = ['INBOX', ...cols.slice(1).filter((c) => !isOwnLabel(c.name)).map((c) => state.labelIds[c.name])];
  const keptIn = cols.slice(1).find((c) => isOwnLabel(c.name) && t.labels.has(state.labelIds[c.name]));
  const kids = state.nestKids.get(id) || [];             // a nest is archived together
  const plan = [id, ...kids].map((x) => ({ x, th: state.threads.get(x), remove: all.filter((l) => state.threads.get(x).labels.has(l)) }));
  const apply = async (undoing) => {
    for (const { th, remove } of plan) {
      if (undoing) remove.forEach((l) => th.labels.add(l)); else remove.forEach((l) => th.labels.delete(l));
    }
    assign(cols);
    render();
    await Promise.all(plan.map(({ x, remove }) => api(`/threads/${x}/modify`, { method: 'POST',
      body: undoing ? { addLabelIds: remove, removeLabelIds: [] } : { addLabelIds: [], removeLabelIds: remove } })));
  };
  try {
    await apply(false);
    const said = kids.length ? `Archived, with ${kids.length} nested` : 'Archived';
    toast(keptIn ? `Archived. It keeps your “${keptIn.name}” label, so it stays in that column.` : said, { label: 'Undo', run: () => apply(true).catch((e) => toast(e.message)) });
  } catch (e) {
    if (!(e instanceof AuthError)) toast('Could not archive: ' + e.message);
  }
}

async function toggleRead(id) {
  const t = state.threads.get(id);
  if (!t) return;
  const unread = !t.unread;
  t.unread = unread;
  if (unread) t.labels.add('UNREAD'); else t.labels.delete('UNREAD');
  render();
  refreshReaderActions(id);
  try {
    await api(`/threads/${id}/modify`, {
      method: 'POST',
      body: unread ? { addLabelIds: ['UNREAD'] } : { removeLabelIds: ['UNREAD'] },
    });
  } catch (e) {
    t.unread = !unread;
    if (unread) t.labels.delete('UNREAD'); else t.labels.add('UNREAD');
    render();
    refreshReaderActions(id);
    if (!(e instanceof AuthError)) toast('Could not update: ' + e.message);
  }
}

function colorOf(t) {
  return COLORS.find((c) => state.colorIds[c.name] && t.labels.has(state.colorIds[c.name])) || null;
}

async function colorLabelId(color) {
  if (state.colorIds[color.name]) return state.colorIds[color.name];
  const name = COLOR_PREFIX + color.name;
  const base = { name, labelListVisibility: 'labelHide', messageListVisibility: 'show' };
  let made;
  try {
    made = await api('/labels', { method: 'POST', body: { ...base, color: { backgroundColor: color.bg, textColor: '#ffffff' } } });
  } catch (e) {
    if (e instanceof AuthError) throw e;
    // Already exists (e.g. made on another computer), or the color was refused.
    const { labels = [] } = await api('/labels');
    made = labels.find((l) => l.name === name) || await api('/labels', { method: 'POST', body: base });
  }
  return (state.colorIds[color.name] = made.id);
}

async function setColor(id, color) {
  const t = state.threads.get(id);
  if (!t) return;
  const before = new Set(t.labels);
  try {
    const add = color ? [await colorLabelId(color)] : [];
    const remove = Object.values(state.colorIds).filter((l) => !add.includes(l) && t.labels.has(l));
    if (add.every((l) => t.labels.has(l)) && !remove.length) return;
    add.forEach((l) => t.labels.add(l));
    remove.forEach((l) => t.labels.delete(l));
    render();
    refreshReaderActions(id);
    await api(`/threads/${id}/modify`, { method: 'POST', body: { addLabelIds: add, removeLabelIds: remove } });
  } catch (e) {
    t.labels = before;
    render();
    refreshReaderActions(id);
    if (!(e instanceof AuthError)) toast('Could not set color: ' + e.message);
  }
}

function closeColorPicker() { $('#color-pop')?.remove(); }

function openColorPicker(anchor, id, onPick = (color) => setColor(id, color)) {
  closeColorPicker();
  const t = state.threads.get(id);
  const current = t && colorOf(t);
  const swatch = (label, color, extra) => {
    const b = el('button', {
      class: 'swatch' + (extra || '') + (color && color === current ? ' current' : ''),
      title: label, 'aria-label': label, style: color ? `--swatch:${color.bg}` : null,
    }, color ? null : '✕');
    b.addEventListener('click', (e) => { e.stopPropagation(); closeColorPicker(); onPick(color); });
    return b;
  };
  const pop = el('div', { class: 'color-pop', id: 'color-pop' }, [
    ...COLORS.map((c) => swatch(c.name, c)),
    swatch('No color', null, ' none'),
  ]);
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = Math.min(r.bottom + 4, innerHeight - pop.offsetHeight - 8) + 'px';
  pop.style.left = Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8)) + 'px';
  pop.querySelector('button').focus();
  setTimeout(() => document.addEventListener('click', closeColorPicker, { once: true }));
}

async function spamThread(id) {
  const t = state.threads.get(id);
  if (!t) return;
  const wasInbox = t.labels.has('INBOX');
  const modify = (body) => api(`/threads/${id}/modify`, { method: 'POST', body });
  try {
    await modify({ addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] });
    state.threads.delete(id);
    assign(columns());
    render();
    if (state.openId === id) closeReader();
    toast('Reported as spam', {
      label: 'Undo',
      run: async () => {
        try {
          await modify({ removeLabelIds: ['SPAM'], addLabelIds: wasInbox ? ['INBOX'] : [] });
          state.threads.set(id, t);
          assign(columns());
          render();
        } catch (e) { if (!(e instanceof AuthError)) toast(e.message); }
      },
    });
  } catch (e) {
    if (!(e instanceof AuthError)) toast('Could not report spam: ' + e.message);
  }
}

async function trashThread(id, said = 'Moved to Trash') {
  const t = state.threads.get(id);
  if (t?.labels.has('TRASH')) return deleteForever([id]);
  try {
    await api(`/threads/${id}/trash`, { method: 'POST' });
    state.threads.delete(id);
    assign(columns());
    render();
    if (state.openId === id) closeReader();
    toast(said, {
      label: 'Undo',
      run: async () => {
        try {
          await api(`/threads/${id}/untrash`, { method: 'POST' });
          if (t) state.threads.set(id, t);
          assign(columns());
          render();
        } catch (e) { if (!(e instanceof AuthError)) toast(e.message); }
      },
    });
  } catch (e) {
    if (!(e instanceof AuthError)) toast('Could not delete: ' + e.message);
  }
}

// Permanently delete threads that are already in Trash. No undo.
async function deleteForever(threadIds) {
  const n = threadIds.length;
  if (!await askConfirm(`Delete ${n === 1 ? 'this conversation' : n.toLocaleString() + ' conversations'} forever? This can't be undone.`, 'Delete forever')) return false;
  try {
    setStatus(n > 1 ? 'Deleting…' : '');
    await mapLimit(threadIds, 5, (id) => api(`/threads/${id}`, { method: 'DELETE' }));
    for (const id of threadIds) {
      state.threads.delete(id);
      state.selected.delete(id);
      if (state.openId === id) closeReader();
    }
    if (state.search) state.search.ids = state.search.ids.filter((id) => state.threads.has(id));
    setStatus('');
    assign(columns());
    render();
    closeEmptiedFolder();
    toast(n === 1 ? 'Deleted forever' : `Deleted forever: ${n.toLocaleString()} conversations`);
    return true;
  } catch (e) {
    setStatus('');
    if (!(e instanceof AuthError)) toast('Could not delete: ' + e.message);
    return false;
  }
}

// ---------- sending ----------

const utf8 = (s) => new TextEncoder().encode(s);

function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const b64url = (bytes) => bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function b64urlBytes(data) {
  const s = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const encodeWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${bytesToB64(utf8(s))}?=`);

const wrap76 = (b64) => b64.replace(/.{76}/g, '$&\r\n');
const b64Part = (type, text) => [`Content-Type: ${type}; charset=UTF-8`, 'Content-Transfer-Encoding: base64', '',
  wrap76(bytesToB64(utf8(text.replace(/\r?\n/g, '\r\n'))))].join('\r\n');

// Plain text, or (with html / files) multipart: text + HTML alternatives, plus attachments.
async function sendMail(headers, body, threadId, opts = {}) {
  const mime = await buildMime(headers, body, opts);
  if (mime.length < 4.5e6) {
    const raw = b64url(mime);
    return api('/messages/send', { method: 'POST', body: threadId ? { raw, threadId } : { raw } });
  }
  return upload('/messages/send', 'POST', threadId ? { threadId } : {}, mime);   // big attachments (up to 35 MB)
}

// Save (or update) a Gmail draft on the thread; returns the draft id.
async function saveDraft(headers, body, threadId, draftId, opts = {}) {
  const mime = await buildMime(headers, body, opts);
  const meta = { message: threadId ? { threadId } : {} };
  if (draftId) meta.id = draftId;
  const path = draftId ? `/drafts/${draftId}` : '/drafts', method = draftId ? 'PUT' : 'POST';
  const r = mime.length < 4.5e6
    ? await api(path, { method, body: { ...meta, message: { ...meta.message, raw: b64url(mime) } } })
    : await upload(path, method, meta, mime);
  return r.id;
}

async function buildMime(headers, body, { html, files = [] } = {}) {
  const lines = [];
  for (const [k, v] of Object.entries(headers)) if (v) lines.push(`${k}: ${k === 'Subject' ? encodeWord(v) : v}`);
  lines.push('MIME-Version: 1.0');
  let content = b64Part('text/plain', body);
  if (html) {
    const alt = 'alt' + Math.random().toString(36).slice(2);
    content = [`Content-Type: multipart/alternative; boundary="${alt}"`, '', `--${alt}`, b64Part('text/plain', body),
      `--${alt}`, b64Part('text/html', `<div dir="ltr">${html}</div>`), `--${alt}--`].join('\r\n');
  }
  if (files.length) {
    const mix = 'mix' + Math.random().toString(36).slice(2);
    const parts = [`Content-Type: multipart/mixed; boundary="${mix}"`, '', `--${mix}`, content];
    for (const f of files) {
      const name = encodeWord(f.name).replace(/"/g, '');
      parts.push(`--${mix}`, `Content-Type: ${f.type || 'application/octet-stream'}; name="${name}"`,
        `Content-Disposition: attachment; filename="${name}"`, 'Content-Transfer-Encoding: base64', '',
        wrap76(bytesToB64(new Uint8Array(await f.arrayBuffer()))));
    }
    parts.push(`--${mix}--`);
    content = parts.join('\r\n');
  }
  return utf8(lines.join('\r\n') + '\r\n' + content);
}

// Gmail's upload endpoint, for messages too big to send as JSON.
async function upload(path, method, meta, mime) {
  if (!state.token || Date.now() > state.tokenExp) { needSignIn(); throw new AuthError('Signed out'); }
  const b = 'up' + Math.random().toString(36).slice(2);
  const head = utf8(`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${b}\r\nContent-Type: message/rfc822\r\n\r\n`);
  const res = await fetch(`https://gmail.googleapis.com/upload/gmail/v1/users/me${path}?uploadType=multipart`, {
    method,
    headers: { Authorization: 'Bearer ' + state.token, 'Content-Type': `multipart/related; boundary=${b}` },
    body: new Blob([head, mime, utf8(`\r\n--${b}--`)]),
  }).catch(() => { throw new Error('Gmail didn\'t accept it. The connection dropped, or the message is too big.'); });
  if (res.status === 401) { needSignIn(); throw new AuthError('Session expired'); }
  if (!res.ok) { let msg = res.statusText; try { msg = (await res.json()).error.message; } catch {} throw new Error(msg); }
  return res.json();
}

// ---------- big attachments: Google Drive links ----------

// Gmail refuses messages over 25 MB, and attachments grow by about a third when encoded for email.
const EMAIL_ATTACH_LIMIT = 18e6;
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';   // only files StediMail itself puts there
const DRIVE_TRIES = 3;
const driveAuth = { token: null, exp: 0, pending: null };

const fileSize = (n) => (n < 1e6 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1e6).toFixed(1)} MB`);

// Which of the picked files still fit in the email; the rest need a Drive link.
function splitForEmail(current, picked) {
  let room = EMAIL_ATTACH_LIMIT - current.reduce((sum, f) => sum + f.size, 0);
  const fit = [], big = [];
  for (const f of [...picked].sort((a, b) => a.size - b.size)) {
    if (f.size <= room) { fit.push(f); room -= f.size; } else big.push(f);
  }
  return { fit, big };
}

// Its own sign-in, asked for the first time it's needed, so nobody else ever sees a Drive permission
// and the Gmail sign-in is left alone.
function driveSignIn() {
  if (driveAuth.token && Date.now() < driveAuth.exp) return Promise.resolve(driveAuth.token);
  if (driveAuth.pending) return driveAuth.pending;
  driveAuth.pending = new Promise((resolve, reject) => {
    google.accounts.oauth2.initTokenClient({
      client_id: settings.clientId,
      scope: DRIVE_SCOPE,
      include_granted_scopes: false,
      callback: (resp) => {
        if (resp.error || !google.accounts.oauth2.hasGrantedAllScopes(resp, DRIVE_SCOPE)) {
          reject(new Error('Google Drive permission wasn\'t given'));
          return;
        }
        driveAuth.token = resp.access_token;
        driveAuth.exp = Date.now() + (Number(resp.expires_in) - 60) * 1000;
        resolve(driveAuth.token);
      },
      error_callback: (err) => reject(new Error(err.type === 'popup_closed'
        ? 'The Google window was closed' : 'Google Drive sign-in failed: ' + err.type)),
    }).requestAccessToken({ login_hint: state.me });
  }).finally(() => { driveAuth.pending = null; });
  return driveAuth.pending;
}

async function driveError(res) {
  let msg = res.statusText;
  try { msg = (await res.json()).error.message; } catch {}
  const e = new Error(msg);
  e.retry = res.status >= 500;
  return e;
}

function drivePut(url, file, onProgress, onStart) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { resolve(JSON.parse(xhr.responseText)); return; }
      const e = new Error(`Google Drive answered ${xhr.status}`);
      e.retry = xhr.status >= 500;
      reject(e);
    };
    xhr.onerror = () => { const e = new Error('The connection dropped'); e.retry = true; reject(e); };
    xhr.onabort = () => reject(new Error('Stopped'));
    onStart(() => xhr.abort());
    xhr.send(file);
  });
}

// Upload to the sender's own Drive, private to them until the email goes out; returns { id, url }.
async function shareOnDrive(file, onProgress, onStart, attempt = 1) {
  const token = await driveSignIn();
  const auth = { Authorization: 'Bearer ' + token };
  try {
    const type = file.type || 'application/octet-stream';
    const begin = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': type, 'X-Upload-Content-Length': String(file.size) },
      body: JSON.stringify({ name: file.name }),
    });
    if (!begin.ok) throw await driveError(begin);
    const made = await drivePut(begin.headers.get('Location'), file, onProgress, onStart);
    return { id: made.id, url: made.webViewLink };
  } catch (e) {
    if (e.retry && attempt < DRIVE_TRIES) {
      await sleep(1000 * attempt);
      return shareOnDrive(file, onProgress, onStart, attempt + 1);
    }
    throw e;
  }
}

// Just before an email goes out: its recipients, and only they, can open its Drive files. An address with no
// Google account can't be added quietly, so Drive emails that person a way in.
async function shareDriveFiles(ids, headers) {
  if (!ids.length) return;
  const people = [...new Set([headers.To, headers.Cc].filter(Boolean).flatMap(splitAddrs).map(addrOf))]
    .filter((a) => a.includes('@') && a !== state.me.toLowerCase());
  const token = await driveSignIn();
  const grant = (id, emailAddress, notify) => fetch(`https://www.googleapis.com/drive/v3/files/${id}/permissions?sendNotificationEmail=${notify}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'user', emailAddress }),
  });
  for (const id of ids) {
    for (const person of people) {
      let res = await grant(id, person, false);
      if (res.status === 400) res = await grant(id, person, true);
      if (!res.ok) throw new Error(`Could not give ${person} access to the Drive file: ${(await driveError(res)).message}`);
    }
  }
}

// Downloading a Drive file someone sent, inside StediMail. drive.file can only read a file the person has
// chosen, so if Drive refuses, Google's own picker (its window, showing only this file) asks them to confirm it.
const PICKER_API_KEY = 'AIzaSyDaoCSvTB0c6JNNM_OFjRC3hyW6K8k-xD8';          // restricted to StediMail's sites and the Picker API, so not a secret
const PICKER_APP_ID = '922000608082';
let pickerLoading = null;

function loadPicker() {
  pickerLoading ||= new Promise((resolve, reject) => {
    const failed = () => { pickerLoading = null; reject(new Error('Google\'s file window didn\'t load')); };
    const go = () => gapi.load('picker', { callback: resolve, onerror: failed });
    if (window.gapi) { go(); return; }
    const s = document.createElement('script');
    s.src = 'https://apis.google.com/js/api.js';
    s.onload = go;
    s.onerror = failed;
    document.head.append(s);
  });
  return pickerLoading;
}

async function confirmDriveFile(id, token) {
  await loadPicker();
  return new Promise((resolve) => {
    const P = google.picker;
    new P.PickerBuilder()
      .addView(new P.DocsView().setFileIds(id).setMode(P.DocsViewMode.LIST))
      .setOAuthToken(token).setDeveloperKey(PICKER_API_KEY).setAppId(PICKER_APP_ID)
      .setTitle('Select the file to download it')
      .setCallback((data) => {
        const action = data[P.Response.ACTION];
        if (action === P.Action.PICKED) resolve(true);
        else if (action === P.Action.CANCEL) resolve(false);
      })
      .build().setVisible(true);
  });
}

// The file as { blob, name, type }, or null if the person backed out of confirming it.
async function fetchDriveFile(id, onProgress) {
  const token = await driveSignIn();
  const auth = { Authorization: 'Bearer ' + token };
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`;
  let meta = await fetch(`${url}?fields=name,mimeType,size`, { headers: auth });
  if (meta.status === 403 || meta.status === 404) {
    if (!await confirmDriveFile(id, token)) return null;
    meta = await fetch(`${url}?fields=name,mimeType,size`, { headers: auth });
  }
  if (!meta.ok) throw await driveError(meta);
  const { name, mimeType, size } = await meta.json();
  const res = await fetch(`${url}?alt=media`, { headers: auth });
  if (!res.ok) throw await driveError(res);
  const chunks = [];
  let got = 0;
  for (const reader = res.body.getReader(); ;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (size) onProgress(got / Number(size));
  }
  return { blob: new Blob(chunks, { type: mimeType }), name, type: mimeType };
}

async function downloadDriveFile(id, msgId, threadId, onProgress = () => {}) {
  try {
    const f = await fetchDriveFile(id, onProgress);
    if (!f) return;
    saveBlob(f.blob, f.name);
    rememberDownload(msgId, threadId, f.name, id);
  } catch (e) {
    toast('Download failed: ' + e.message);
  }
}

// Drive files StediMail put in this email (their links are marked when it's sent).
function driveFilesIn(m) {
  const html = findPart(m.payload, 'text/html');
  if (!html) return [];
  const doc = new DOMParser().parseFromString(decodePart(html), 'text/html');
  return [...doc.querySelectorAll('a[data-drive-file]')].map((a) => ({ id: a.dataset.driveFile, name: a.textContent.trim() }));
}

function removeFromDrive(id) {
  fetch(`https://www.googleapis.com/drive/v3/files/${id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + driveAuth.token } }).catch(() => {});
}

const addrOf = (s) => (/<([^>]+)>/.exec(s)?.[1] || s).trim().toLowerCase();
const splitAddrs = (s) => s.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((a) => a.trim()).filter(Boolean);

function replyHeaders(m, all) {
  const from = header(m, 'from');
  const me = state.me.toLowerCase();
  const mine = addrOf(from) === me;
  const to = mine ? header(m, 'to') : (header(m, 'reply-to') || from);
  let cc = '';
  if (all) {
    const toAddrs = new Set(splitAddrs(to).map(addrOf));
    cc = splitAddrs([header(m, 'to'), header(m, 'cc')].filter(Boolean).join(','))
      .filter((a) => addrOf(a) !== me && !toAddrs.has(addrOf(a)))
      .join(', ');
  }
  let subject = header(m, 'subject');
  if (!/^re:/i.test(subject)) subject = 'Re: ' + subject;
  const msgId = header(m, 'message-id');
  return {
    To: to,
    Cc: cc,
    Subject: subject,
    'In-Reply-To': msgId,
    References: [header(m, 'references'), msgId].filter(Boolean).join(' '),
  };
}

// ---------- rendering ----------

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) node.setAttribute(k, v);
  for (const c of [].concat(children)) if (c != null) node.append(c);
  return node;
}

const ICONS = {
  play: 'M8 5v14l11-7z',
  sort: 'M3 18h6v-2H3v2zM3 6v2h18V6H3zm0 7h12v-2H3v2z',
  mic: 'M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z',
  widen: 'M4 12l4-4v3h8V8l4 4-4 4v-3H8v3z',
  person: 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
  mail: 'M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z',
  search: 'M15.5 14h-.79l-.28-.27A6.47 6.47 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
  narrow: 'M10 12L6 8v3H2v2h4v3zm4 0l4-4v3h4v2h-4v3z',
  archive: 'M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z',
  trash: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
  unread: 'M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z',
  read: 'M21.99 8c0-.72-.37-1.35-.94-1.7L12 1 2.95 6.3C2.38 6.65 2 7.28 2 8v10c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2l-.01-10zM12 13L3.74 7.84 12 3l8.26 4.84L12 13z',
  inbox: 'M19 3H4.99c-1.11 0-1.98.89-1.98 2L3 19c0 1.1.88 2 1.99 2H19c1.1 0 2-.9 2-2V5c0-1.11-.9-2-2-2zm0 12h-4c0 1.66-1.35 3-3 3s-3-1.34-3-3H4.99V5H19v10z',
  clock: 'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z',
  send: 'M4.01 6.03l7.51 3.22-7.52-1 .01-2.22m7.5 8.72L4 17.97v-2.22l7.51-1M2.01 3L2 10l15 2-15 2 .01 7L23 12 2.01 3z',
  draft: 'M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zM6 20V4h7v5h5v11H6z',
  allmail: 'M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8l8 5 8-5v10zm-8-7L4 6h16l-8 5z',
  bag: 'M18 6h-2c0-2.21-1.79-4-4-4S8 3.79 8 6H6c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-6-2c1.1 0 2 .9 2 2h-4c0-1.1.9-2 2-2zm6 16H6V8h2v2c0 .55.45 1 1 1s1-.45 1-1V8h4v2c0 .55.45 1 1 1s1-.45 1-1V8h2v12z',
  offer: 'M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58s1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41s-.23-1.06-.59-1.42zM13 20.01L4 11V4h7v-.01l9 9-7 7.02zM6.5 5C5.67 5 5 5.67 5 6.5S5.67 8 6.5 8 8 7.33 8 6.5 7.33 5 6.5 5z',
  star: 'M22 9.24l-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z',
  important: 'M15 19H3l4.5-7L3 5h12c.65 0 1.26.31 1.63.84L21 12l-4.37 6.16c-.37.52-.98.84-1.63.84zm-8.5-2H15l3.5-5L15 7H6.5l3.5 5-3.5 5z',
  label: 'M17.63 5.84C17.27 5.33 16.67 5 16 5L5 5.01C3.9 5.01 3 5.9 3 7v10c0 1.1.9 1.99 2 1.99L16 19c.67 0 1.27-.33 1.63-.84L22 12l-4.37-6.16zM16 17H5V7h11l3.55 5L16 17z',
  spam: 'M15.73 3H8.27L3 8.27v7.46L8.27 21h7.46L21 15.73V8.27L15.73 3zM12 17.3c-.72 0-1.3-.58-1.3-1.3 0-.72.58-1.3 1.3-1.3.72 0 1.3.58 1.3 1.3 0 .72-.58 1.3-1.3 1.3zm1-4.3h-2V7h2v6z',
  palette: 'M12 3a9 9 0 0 0 0 18c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z',
  clip: 'M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z',
};

function icon(name, cls) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

// What follows the pointer while a card is dragged: a see-through mail icon, just below and right of
// the pointer. It's our own element moved on dragover, with the browser's drag picture blanked,
// because a custom drag picture doesn't reliably show on every system.
const dragGhost = {
  node: null,
  blank: null,
  start(e) {
    if (!this.node) {
      this.node = el('div', { id: 'drag-ghost', 'aria-hidden': 'true' }, [icon('mail')]);
      this.blank = el('div', { id: 'drag-blank' });
      document.body.append(this.node, this.blank);
      document.addEventListener('dragover', (ev) => this.move(ev), true);
      document.addEventListener('dragleave', (ev) => { if (!ev.relatedTarget) this.node.hidden = true; }, true);
      document.addEventListener('drop', () => this.stop(), true);
      document.addEventListener('dragend', () => this.stop(), true);
    }
    e.dataTransfer.setDragImage(this.blank, 0, 0);
    this.active = true;
    this.move(e);
  },
  move(e) {
    if (!this.active) return;
    this.node.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
    this.node.hidden = false;
  },
  stop() {
    this.active = false;
    if (this.node) this.node.hidden = true;
  },
};

function iconButton(label, name, run, text) {
  const b = el('button', { class: 'icon-btn', title: label, 'aria-label': label, draggable: 'false' }, name ? icon(name) : text);
  b.addEventListener('click', (e) => { e.stopPropagation(); run(b); });
  return b;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function decodeEntities(s) {
  return new DOMParser().parseFromString(s, 'text/html').documentElement.textContent;
}

function displayName(from) {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>/.exec(from);
  return (m && (m[1].trim() || m[2])) || from || '(unknown)';
}

function dateLabel(ms, full) {
  const d = new Date(ms);
  const now = new Date();
  const time = { hour: 'numeric', minute: '2-digit' };
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], time);
  const opts = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return full ? d.toLocaleString([], { ...opts, ...time }) : d.toLocaleDateString([], opts);
}

function setStatus(text) { $('#status').textContent = text; }

let toastTimer;
// Standard undo (Paul, 2026-11-03): every change whose message offers Undo also goes on this list, so it
// can still be undone after the message has gone — Ctrl+Z or the Undo button, latest first.
const undoStack = [];
const UNDO_MAX = 30;
function renderUndo() {
  const b = $('#btn-undo');
  if (!b) return;
  const last = undoStack[undoStack.length - 1];
  b.disabled = !last;
  b.title = last ? `Undo: ${last.what} (Ctrl+Z)` : 'Nothing to undo';
  b.setAttribute('aria-label', last ? `Undo: ${last.what}` : 'Undo (nothing to undo)');
}
async function runUndo(entry) {
  const i = undoStack.indexOf(entry);
  if (i < 0) return;
  undoStack.splice(i, 1);
  renderUndo();
  try { await entry.run(); toast(`Undone: ${entry.what}`); }
  catch (e) { if (!(e instanceof AuthError)) toast('Undo failed: ' + e.message); }
}
function undoLast() {
  const last = undoStack[undoStack.length - 1];
  if (last) runUndo(last); else toast('Nothing to undo.');
}

function toast(msg, action) {
  const box = $('#toast');
  box.replaceChildren(el('span', {}, msg));
  if (action) {
    const entry = action.label === 'Undo' ? { what: msg, run: action.run } : null;
    if (entry) {
      undoStack.push(entry);
      undoStack.splice(0, Math.max(0, undoStack.length - UNDO_MAX));
      renderUndo();
    }
    const b = el('button', {}, action.label);
    b.addEventListener('click', () => { box.hidden = true; if (entry) runUndo(entry); else action.run(); });
    box.append(b);
  }
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, action ? 8000 : 5000);
}

function show(view) {
  $('#main-row').hidden = view !== 'board';
  $('#signin').hidden = view !== 'signin';
  $('#setup').hidden = view !== 'setup';
  for (const id of ['btn-undo', 'btn-downloads', 'btn-compose', 'btn-refresh', 'search-form', 'btn-menu', 'col-picker', 'btn-report']) $('#' + id).hidden = view !== 'board';
  $('#sidebar').hidden = !state.sidebarOpen;
  if (view === 'board') renderSidebar();
}

function render() {
  const cols = columns();
  const board = $('#board');
  const focusedId = document.activeElement?.closest?.('.card')?.dataset.id;
  const scrolls = [...board.querySelectorAll('.cards')].map((c) => c.scrollTop);
  board.replaceChildren(
    ...(state.search ? [renderSearchColumn()] : []),
    ...cols.map((col, i) => renderColumn(col, i)),
    renderAddColumn(),
  );
  board.querySelectorAll('.cards').forEach((c, i) => { c.scrollTop = scrolls[i] || 0; });
  if (focusedId) board.querySelector(`.card[data-id="${focusedId}"]`)?.focus({ preventScroll: true });
  renderBulk();
  showPhoneColumn();
}

// Phones show one column at a time, chosen with the full-width "Columns" button under the search box.
// (-1 = the search / folder column, shown while a search is open.)
const phone = window.matchMedia('(max-width: 640px)');
state.phoneCol = store.get('phoneCol', 0);

function showPhoneColumn() {
  const cols = columns();
  if (state.phoneCol >= cols.length) state.phoneCol = 0;
  const shown = state.search ? -1 : state.phoneCol;
  $('#board').querySelectorAll('.column').forEach((c) => c.classList.toggle('phone-shown', Number(c.dataset.col) === shown));
  const name = shown < 0 ? (state.search.title || `“${state.search.q}”`) : cols[shown].name;
  const count = shown < 0 ? state.search.ids.length : (state.board[shown] || []).length;
  $('#col-picker').textContent = `${name} · ${count}${shown >= 0 && state.more[shown] ? '+' : ''}  ▾`;
}

function openColumnPicker() {
  const cols = columns();
  openMenu($('#col-picker'), [
    { heading: 'Show column' },
    ...cols.map((c, i) => ({ label: `${c.name} · ${(state.board[i] || []).length}${state.more[i] ? '+' : ''}`, checked: !state.search && i === state.phoneCol,
      run: () => { if (state.search) clearSearch(); state.phoneCol = i; store.set('phoneCol', i); showPhoneColumn(); } })),
  ]);
}

function saveColumnList(list, reloadAfter = 0) {
  settings.columns = list;
  settings.columnsSaved = true;
  settings.columnLabels = Object.fromEntries(Object.entries(settings.columnLabels).filter(([k]) => list.includes(k)));
  store.set('columnLabels', settings.columnLabels);
  store.set('columns', list);
  assign(columns());
  render();
  setTimeout(loadBoard, reloadAfter);
}

async function removeColumn(i, afterDelete = false) {
  const before = [...settings.columns];
  const name = before[i - 1];
  const said = (normal) => afterDelete ? `Moved everything in “${name}” to Trash and closed the column.` : normal;
  const id = state.labelIds[name];
  const own = isOwnLabel(name);
  const beforeLabels = { ...settings.columnLabels };
  const undo = () => { settings.columnLabels = beforeLabels; saveColumnList(before); };
  saveColumnList(before.filter((_, k) => k !== i - 1));
  if (own) {               // one of their own labels: it stays exactly as it was in Gmail
    toast(said(`Removed the “${name}” column. Your label is unchanged.`), { label: 'Undo', run: undo });
    return;
  }
  // An empty StediMail column's label is deleted too, so nothing is left behind; one with emails keeps it.
  let empty = false;
  try { empty = id && (await api(`/labels/${id}`)).threadsTotal === 0; } catch {}
  if (empty) {
    try {
      await api(`/labels/${id}`, { method: 'DELETE' });
      delete state.labelIds[name];
      toast(said(`Removed “${name}” and its empty Gmail label.`), { label: 'Undo', run: undo });
      return;
    } catch {}
  }
  toast(said(`Removed “${name}”. Its emails keep the label in Gmail.`), { label: 'Undo', run: undo });
}

function addColumn(name) {
  const existing = [settings.inboxName, ...settings.columns].map((n) => n.toLowerCase());
  if (existing.includes(name.toLowerCase())) { toast('There is already a column with that name.'); return; }
  if (existing.length >= 9) { toast('Nine columns at most.'); return; }
  const own = (state.allUserLabels || []).find((l) => l.name.toLowerCase() === name.toLowerCase());
  if (own) settings.columnLabels[own.name] = own.name;
  const list = [...settings.columns];
  list.push(own ? own.name : name);
  saveColumnList(list);
}

function renderAddColumn() {
  const tile = el('div', { class: 'add-column' });
  const first = settings.columns.length === 0;
  const plus = el('button', { class: 'add-btn' + (first ? ' first' : ''), title: 'Add column', 'aria-label': first ? 'Add your first column' : 'Add column' },
    first ? '+ Add a column' : '+');
  plus.addEventListener('click', () => {
    state.addingColumn = true;
    const input = el('input', { placeholder: 'New column, or one of your labels', 'aria-label': 'New column name, or one of your labels',
      list: 'own-label-list' });
    const taken = new Set(settings.columns.map((n) => labelNameOf(n)));
    const options = el('datalist', { id: 'own-label-list' }, [
      ...(state.spareBoardLabels || []).map((n) => el('option', { value: n, label: 'StediMail column (has its label already)' })),
      ...(state.allUserLabels || []).filter((l) => !taken.has(l.name)).map((l) => el('option', { value: l.name, label: 'your label' })),
    ]);
    let finished = false;
    const finish = (save) => {
      if (finished) return;
      finished = true;
      state.addingColumn = false;
      const typed = input.value.trim();
      const own = (state.allUserLabels || []).some((l) => l.name.toLowerCase() === typed.toLowerCase());
      const name = own ? typed : typed.replace(/\//g, '-');
      if (save && name) addColumn(name); else render();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    tile.replaceChildren(input, options);
    input.focus();
  });
  tile.append(plus);
  if (first) tile.append(el('p', { class: 'add-hint' },
    'Columns sort your email, like To Do or Waiting. Each one is a Gmail label, made only when you add it.'));
  return tile;
}

// Gmail only matches whole words ("jace" won't find "Jacek"), so an empty search offers the names and
// words from known emails that start with what was typed, one click away.
function noMatches(q) {
  const last = (q.trim().split(/\s+/).pop() || '').toLowerCase();
  const box = el('div', { class: 'no-matches' }, [el('p', { class: 'hint' }, 'No matches.')]);
  if (last.length < 2 || /:/.test(last)) return box;
  const pool = [...state.threads.values(), ...state.suggestCache.values()];
  const people = new Map(), words = new Map();
  for (const t of pool) {
    for (const p of t.senders || []) {
      if (p.addr === state.me.toLowerCase()) continue;
      if ([p.name, ...p.name.split(/\s+/), p.addr].some((x) => x.toLowerCase().startsWith(last))) people.set(p.addr, p);
    }
    for (const w of `${t.subject} ${t.people}`.split(/[^\p{L}\p{N}'-]+/u)) {
      const lw = w.toLowerCase();
      if (lw.length > last.length && lw.startsWith(last)) words.set(lw, (words.get(lw) || 0) + 1);
    }
  }
  const prefix = q.trim().slice(0, q.trim().length - last.length);
  const tries = [
    ...[...people.values()].slice(0, 4).map((p) => [`${p.name} (${p.addr})`, `${prefix}from:${p.addr}`.trim()]),
    ...[...words].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([w]) => [w, `${prefix}${w}`]),
  ];
  if (!tries.length) return box;
  box.append(el('p', { class: 'hint' }, 'Gmail only finds whole words. Did you mean:'),
    el('div', { class: 'did-you-mean' }, tries.map(([label, query]) => {
      const b = el('button', { type: 'button' }, label);
      b.addEventListener('click', () => { $('#search').value = query; runSearch(query); });
      return b;
    })));
  return box;
}

function renderSearchColumn() {
  const { q, title, more } = state.search;
  const close = el('button', { class: 'icon-btn', title: 'Close', 'aria-label': 'Close' }, '✕');
  close.addEventListener('click', clearSearch);
  // Each folder/label remembers its own sort; all free-text searches share one.
  const col = { name: 'folder:' + (title || '') };
  const sort = sortOf(col);
  const ids = state.search.ids.filter((id) => state.threads.has(id));
  if (sort.key !== 'newest') ids.sort((a, b) => sort.cmp(state.threads.get(a), state.threads.get(b)));
  const sortBtn = iconButton(`Sort: ${sort.label}`, 'sort', (b) => openSortMenu(b, col));
  if (sort.key !== 'newest') sortBtn.classList.add('on');
  let deleteAll = null;
  const folderLabel = state.searchArgs?.folder?.label;
  if ((folderLabel === 'SPAM' || folderLabel === 'TRASH') && ids.length) {
    deleteAll = el('button', { type: 'button', class: 'delete-all' }, folderLabel === 'SPAM' ? 'Delete all spam' : 'Empty trash');
    deleteAll.addEventListener('click', deleteWholeFolder);
  }
  const node = el('section', { class: 'column search', 'data-col': '-1' }, [
    el('h2', {}, [columnCheckbox(-1), el('span', { class: 'q' }, title || `“${q}”`), el('span', { class: 'count' }, ids.length + (more ? '+' : '')), sortBtn, close]),
    deleteAll,
    el('div', { class: 'cards' }, ids.length
      ? ids.map((id) => renderCard(state.threads.get(id), -1))
      : title ? el('p', { class: 'hint' }, 'Nothing here.') : noMatches(q)),
  ]);
  node.append(...resizeHandles(node));
  return node;
}

const COLUMN_DRAG = 'application/x-mailboard-column';

// Columns other than the inbox (and the archiving column, which stays last)
// can be reordered by dragging their header.
const columnMovable = (col, i) => i > 0 && !col.archive;

function moveColumn(from, to, after) {
  const list = [...settings.columns];
  const [moved] = list.splice(from - 1, 1);
  let at = list.indexOf(settings.columns[to - 1]);
  if (after) at++;
  list.splice(at, 0, moved);
  const nodeOf = (i) => $('#board').querySelector(`.column[data-col="${i}"]`);
  const wasAt = new Map(columns().map((c, i) => [c.name, nodeOf(i)?.getBoundingClientRect().left]));
  saveColumnList(list, 250);                             // a reload would redraw the columns mid-slide
  // The columns slide to their new places, so it's clear what moved where.
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  columns().forEach((c, i) => {
    const node = nodeOf(i), dx = wasAt.get(c.name) - node?.getBoundingClientRect().left;
    if (dx) node.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 200, easing: 'ease-out' });
  });
}

// A see-through copy of a column follows the pointer while it's dragged. The browser's own drag image is
// switched off, as it is for cards, so there's one clear thing moving.
const columnGhost = {
  node: null,
  blank: null,
  listening: false,
  start(column, e) {
    if (!this.listening) {
      this.listening = true;
      this.blank = el('div', { style: 'position:fixed;left:-10px;top:-10px;width:1px;height:1px' });
      document.body.append(this.blank);
      document.addEventListener('dragover', (ev) => this.move(ev), true);
      document.addEventListener('drop', () => this.stop(), true);
      document.addEventListener('dragend', () => this.stop(), true);
    }
    const r = column.getBoundingClientRect();
    this.node = column.cloneNode(true);
    this.node.id = 'col-ghost';
    this.node.classList.remove('dragging-col');
    this.node.setAttribute('aria-hidden', 'true');
    this.node.style.width = `${r.width}px`;
    this.node.querySelectorAll('[data-id],[data-col],[draggable]').forEach((n) => {
      n.removeAttribute('data-id'); n.removeAttribute('data-col'); n.removeAttribute('draggable');
    });
    this.node.removeAttribute('data-col');
    this.dx = e.clientX - r.left; this.dy = e.clientY - r.top;
    document.body.append(this.node);
    e.dataTransfer.setDragImage(this.blank, 0, 0);
    this.move(e);
  },
  move(e) {
    if (this.node) this.node.style.transform = `translate(${e.clientX - this.dx}px, ${e.clientY - this.dy}px) rotate(1.5deg)`;
  },
  stop() { this.node?.remove(); this.node = null; },
};

// One width for every column. Dragging the handle at a column's top-left or top-right corner sets
// it for all of them; double-click a handle to go back to automatic widths. Remembered per browser.
const COL_MIN = 220, COL_MAX = 900;

function applyColumnWidth(w) {
  document.body.classList.toggle('cols-sized', !!w);
  if (w) document.body.style.setProperty('--col-w', `${w}px`);
  else document.body.style.removeProperty('--col-w');
}

function resizeHandles(node) {
  return ['left', 'right'].map((side) => {
    const h = el('div', { class: `col-resize ${side}`, title: 'Drag to resize all columns · double-click for automatic widths' });
    h.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX, startW = node.getBoundingClientRect().width, dir = side === 'right' ? 1 : -1;
      h.setPointerCapture(e.pointerId);
      document.body.classList.add('col-resizing');
      const move = (ev) => {
        const w = Math.round(Math.min(COL_MAX, Math.max(COL_MIN, startW + dir * (ev.clientX - startX))));
        applyColumnWidth(w);
        settings.colWidth = w;
      };
      const up = () => {
        h.removeEventListener('pointermove', move);
        document.body.classList.remove('col-resizing');
        store.set('colWidth', settings.colWidth);
      };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up, { once: true });
      h.addEventListener('pointercancel', up, { once: true });
    });
    h.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      settings.colWidth = null;
      store.set('colWidth', null);
      applyColumnWidth(null);
    });
    return h;
  });
}

// Double-click a column's header to minimize it to a strip with its name running down it; double-click
// the strip to bring it back. Cards can still be dropped on it. Remembered per browser; not on phones,
// which show one column at a time.
function toggleCollapsed(col, node) {
  const on = !settings.collapsedCols.includes(col.name);
  settings.collapsedCols = on
    ? [...settings.collapsedCols, col.name]
    : settings.collapsedCols.filter((name) => name !== col.name);
  store.set('collapsedCols', settings.collapsedCols);
  const from = node.offsetWidth;
  node.classList.toggle('collapsed', on);
  if (!on) {                                // opened: the new mail is in view now
    store.set('newMailCols', store.get('newMailCols', []).filter((name) => name !== col.name));
    node.classList.remove('new-mail');
  }
  // A quick fold, so it's clear what happened to the column.
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const frame = (width) => ({ flex: `0 0 ${width}px`, width: `${width}px`, minWidth: '0', maxWidth: 'none', overflow: 'hidden' });
  node.animate([frame(from), frame(node.offsetWidth)], { duration: 200, easing: 'ease-out' });
}

function renderColumn(col, i) {
  const ids = state.board[i] || [];
  const sort = sortOf(col);
  const sortBtn = iconButton(`Sort: ${sort.label}`, 'sort', (b) => openSortMenu(b, col));
  if (sort.key !== 'newest') sortBtn.classList.add('on');
  const closeBtn = i > 0 ? iconButton(`Remove column “${col.name}”`, null, () => removeColumn(i), '✕') : null;
  // Tells Stediclick's magnet to aim at this button's left end, away from the column-width handle beside it.
  (closeBtn || sortBtn).classList.add('steady-aim-left');
  const head = el('h2', {}, [columnCheckbox(i), col.name, el('span', { class: 'count' }, ids.length + (state.more[i] ? '+' : '')),
    sortBtn, closeBtn]);
  const node = el('section', { class: 'column' + (settings.collapsedCols.includes(col.name) ? ' collapsed' + (store.get('newMailCols', []).includes(col.name) ? ' new-mail' : '') : ''), 'data-col': i }, [
    head,
    el('div', { class: 'cards' }, ids.map((id) => renderCard(state.threads.get(id), i))),
  ]);
  node.append(...resizeHandles(node));
  head.title = 'Double-click to minimize or restore this column';
  head.addEventListener('dblclick', (e) => {
    if (e.target.closest('button, input') || matchMedia('(max-width: 640px)').matches) return;
    toggleCollapsed(col, node);
  });
  const clearMarks = () => node.classList.remove('drop', 'insert-before', 'insert-after');
  if (columnMovable(col, i)) {
    head.draggable = true;
    head.classList.add('grab');
    head.title = 'Drag to move this column · double-click to minimize or restore it';
    head.addEventListener('dragstart', (e) => {
      state.dragging = true;
      e.dataTransfer.setData(COLUMN_DRAG, String(i));
      e.dataTransfer.effectAllowed = 'move';
      columnGhost.start(node, e);
      node.classList.add('dragging-col');
    });
    head.addEventListener('dragend', () => { state.dragging = false; node.classList.remove('dragging-col'); });
  }
  node.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes(COLUMN_DRAG)) {
      if (!columnMovable(col, i)) return; // not a place a column can go
      e.preventDefault();
      const r = node.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      node.classList.toggle('insert-after', after);
      node.classList.toggle('insert-before', !after);
      return;
    }
    e.preventDefault();
    node.classList.add('drop');
  });
  node.addEventListener('dragleave', (e) => { if (!node.contains(e.relatedTarget)) clearMarks(); });
  node.addEventListener('drop', (e) => {
    e.preventDefault();
    const after = node.classList.contains('insert-after');
    clearMarks();
    state.dragging = false;
    const from = e.dataTransfer.getData(COLUMN_DRAG);
    if (from) {
      if (Number(from) !== i) moveColumn(Number(from), i, after);
      return;
    }
    const id = e.dataTransfer.getData('text/plain');
    if (!id) return;
    // Dragging one of several checked cards moves them all.
    if (state.selected.has(id) && state.selected.size > 1 && !state.selectAll) runBulk('move', i);
    else moveWithUndo(id, i);
  });
  return node;
}

function renderCard(t, colIdx) {
  const color = colorOf(t);
  let where = null;
  if (colIdx < 0) { // search result: show which column it lives in
    const cols = columns();
    const c = columnOf(t, cols);
    const place = c >= 0 ? cols[c].name
      : t.labels.has('TRASH') ? 'Trash' : t.labels.has('SPAM') ? 'Spam' : snoozedLabelOf(t) || t.labels.has('SNOOZED') ? 'Snoozed' : 'Archived';
    where = el('span', { class: 'where' }, place);
  }
  const card = el('article', {
    class: 'card' + (t.unread ? ' unread' : '') + (t.id === state.openId ? ' open' : '') + (color ? ' colored' : '')
      + (state.selected.has(t.id) ? ' selected' : '') + (colIdx >= 0 && state.nestOf.has(t.id) ? ' nested' : ''),
    hidden: colIdx >= 0 && NEST_COLLAPSED[state.nestOf.get(t.id)] ? '' : null,
    style: color ? `--card-color:${color.bg}` : null,
    tabindex: '0', draggable: 'true', 'data-id': t.id, 'data-col': colIdx,
    // A button to accessibility, with a name: so Stediclick's sticky buttons and magnet see each card
    // (plain <article>s weren't reported at all), and screen readers say what it is.
    role: 'button', 'aria-label': `${t.unread ? 'Unread: ' : ''}${t.subject}, from ${t.people}`,
  }, [
    el('div', { class: 'top' }, [
      checkbox('Select', state.selected.has(t.id), () => toggleSelect(t.id)),
      colIdx >= 0 && state.nestKids.has(t.id) ? nestToggle(t.id) : null,
      el('span', { class: 'people' }, t.people),
      t.count > 1 ? el('span', { class: 'num' }, String(t.count)) : null,
      where,
      // The date a card sorts by, so the column reads in order; a returned email says when it was sent on hover.
      el('time', sortTime(t) > t.date ? { title: `Sent ${dateLabel(t.date, true)}` } : {}, dateLabel(sortTime(t))),
    ]),
    el('div', { class: 'body' }, [
      el('span', { class: 'subj' }, t.subject),
      t.snippet ? ' - ' + t.snippet : '',
    ]),
    t.attachments ? el('div', { class: 'clip' }, [icon('clip'), String(t.attachments)]) : null,
    snoozedLabelOf(t) ? el('div', { class: 'snoozed' }, [icon('clock'), 'Back ' + whenLabel(snoozedLabelOf(t).due)]) : null,
    cardLabelField(t, () => card),
    el('div', { class: 'card-actions' }, [
      iconButton('Color', 'palette', (b) => openColorPicker(b, t.id)),
      iconButton('Snooze', 'clock', (b) => openSnoozeMenu(b, t.id)),
      iconButton('Archive', 'archive', () => archiveThread(t.id)),
      iconButton('Report spam', 'spam', () => spamThread(t.id)),
      iconButton('Delete', 'trash', () => trashThread(t.id)),
      t.unread
        ? iconButton('Mark as read', 'read', () => toggleRead(t.id))
        : iconButton('Mark as unread', 'unread', () => toggleRead(t.id)),
    ]),
  ]);
  card.addEventListener('dragover', (e) => {
    const target = nestTargetFor(card, t, colIdx, e);
    if (!target) { if (nestHover.id) clearNestTarget(); return; }
    if (nestHover.id !== target) {
      clearNestTarget();
      nestHover.id = target; nestHover.since = performance.now();
    }
    const sameColumn = columnOf(state.threads.get(state.dragId), columns()) === colIdx;
    if (!sameColumn && performance.now() - nestHover.since < NEST_HOLD_MS) return;   // still just passing over
    e.preventDefault(); e.stopPropagation();
    card.closest('.column')?.classList.remove('drop');
    document.querySelector(`.card[data-id="${target}"]`)?.classList.add('nest-target');
  });
  card.addEventListener('drop', (e) => {
    const target = document.querySelector('.card.nest-target')?.dataset.id;
    const id = state.dragId;
    clearNestTarget();
    if (!target || !id) return;                          // an ordinary drop: the column handles it
    e.preventDefault(); e.stopPropagation();
    state.dragging = false;
    card.closest('.column')?.classList.remove('drop');
    nestWithUndo(id, target);
  });
  card.addEventListener('dragstart', (e) => {
    state.dragging = true;
    state.dragId = t.id;
    e.dataTransfer.setData('text/plain', t.id);
    e.dataTransfer.effectAllowed = 'move';
    dragGhost.start(e);
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => { state.dragging = false; state.dragId = null; clearNestTarget(); card.classList.remove('dragging'); });
  card.addEventListener('click', () => openThread(t.id));
  return card;
}

function showCardLabel(id) {
  const text = state.cardLabels.get(id)?.text || '';
  document.querySelectorAll(`.card[data-id="${id}"] .card-label`).forEach((input) => { input.value = text; });
}

async function saveCardLabel(id, text) {
  const old = state.cardLabels.get(id);
  if ((old?.text || '') === text) return;
  const name = `${CARD_LABEL_PREFIX}${id}/${encodeCardLabel(text)}`;
  if (name.length > 225) { toast('That label is too long'); showCardLabel(id); return; }   // Gmail's limit
  const saving = text ? { id: null, text } : null;
  state.cardLabelSaves.set(id, saving);
  if (saving) state.cardLabels.set(id, saving); else state.cardLabels.delete(id);
  showCardLabel(id);
  try {
    if (saving) saving.id = (await hiddenLabel(name)).id;
    if (old?.id) await api(`/labels/${old.id}`, { method: 'DELETE' }).catch((e) => { if (!saving) throw e; });
  } catch (e) {
    if (old) state.cardLabels.set(id, old); else state.cardLabels.delete(id);
    showCardLabel(id);
    if (!(e instanceof AuthError)) toast('Could not save the label: ' + e.message);
  } finally {
    if (state.cardLabelSaves.get(id) === saving) state.cardLabelSaves.delete(id);
  }
}

// Typed in place on the card: Enter or clicking away saves, Esc cancels, and an empty field removes it.
function cardLabelField(t, card) {
  const input = el('input', { class: 'card-label', type: 'text', placeholder: 'Label', 'aria-label': 'Label', maxlength: '80' });
  input.value = state.cardLabels.get(t.id)?.text || '';
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('focus', () => {
    state.typingCardLabel = true;
    card().draggable = false;                            // so dragging in the field selects text
  });
  input.addEventListener('blur', () => {
    state.typingCardLabel = false;
    card().draggable = true;
    saveCardLabel(t.id, input.value.trim());
  });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { showCardLabel(t.id); input.blur(); }
  });
  return input;
}

// The arrow on a parent card: shows or hides the emails under it, and says how many (and how many unread).
function nestToggle(id) {
  const kids = state.nestKids.get(id);
  const closed = !!NEST_COLLAPSED[id];
  const unread = kids.filter((k) => state.threads.get(k).unread).length;
  const label = `${closed ? 'Show' : 'Hide'} ${kids.length} nested email${kids.length === 1 ? '' : 's'}`;
  const b = iconButton(label, null, () => toggleNest(id), `${closed ? '▸' : '▾'} ${kids.length}${closed && unread ? ` (${unread} unread)` : ''}`);
  b.classList.add('nest-toggle');
  return b;
}

// ---------- reader ----------

function findPart(part, mime) {
  if (!part) return null;
  if (part.mimeType === mime && part.body?.data && !part.filename) return part;
  for (const p of part.parts || []) { const hit = findPart(p, mime); if (hit) return hit; }
  return null;
}

function attachmentsOf(part, out = []) {
  if (!part) return out;
  if (part.filename && part.body?.attachmentId) out.push(part);
  for (const p of part.parts || []) attachmentsOf(p, out);
  return out;
}

function decodePart(part) {
  const ct = (part.headers || []).find((h) => h.name.toLowerCase() === 'content-type')?.value || '';
  const charset = /charset="?([^";\s]+)/i.exec(ct)?.[1] || 'utf-8';
  const bytes = b64urlBytes(part.body.data);
  try { return new TextDecoder(charset).decode(bytes); } catch { return new TextDecoder().decode(bytes); }
}

const FRAME_HEAD = '<!doctype html><meta charset="utf-8"><base target="_blank"><style>' +
  'html,body{margin:0;color-scheme:light;background:#fff;color:#111;font:15px/1.5 system-ui,sans-serif;overflow-wrap:anywhere}' +
  // The frame is always sized to fit its email, so it never needs a scrollbar of its own. One would narrow
  // the text while it's being measured, and could flicker on and off as the frame changes size.
  'html{overflow-y:hidden!important}' +
  // Breathing room round the text (Paul, 2026-11-06), even if the email sets its own margins to nothing.
  'body{padding:14px 18px!important;box-sizing:border-box}' +
  'img{max-width:100%;height:auto}table{max-width:100%}' +
  '#mb-copy{position:absolute;z-index:9;font:12px system-ui,sans-serif;padding:2px 8px;border:1px solid #bbb;' +
  'border-radius:6px;background:#fde2e2;border-color:#f3a5a5;color:#8a1c1c;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.2)}</style>';

// Emails are always shown on white, so an email's dark-mode styling (often white text) must never apply,
// even when the computer is set to dark: its dark rules are switched off and its light rules always on.
function lightOnly(html) {
  const force = (css) => css.replace(/\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/gi,
    (_, scheme) => (scheme.toLowerCase() === 'light' ? '(min-width:0)' : '(prefers-color-scheme:none)'));
  return html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, force).replace(/\bmedia\s*=\s*("[^"]*"|'[^']*')/gi, force);
}

// Pictures inside an email (logos, icons) are attached parts the HTML points at as "cid:<Content-ID>".
function partHeader(p, name) {
  return (p.headers || []).find((h) => h.name.toLowerCase() === name)?.value || '';
}
function inlineParts(part, out = []) {
  if (!part) return out;
  const cid = partHeader(part, 'content-id').replace(/^<|>$/g, '');
  if (cid && (part.body?.attachmentId || part.body?.data)) out.push({ cid, part });
  for (const p of part.parts || []) inlineParts(p, out);
  return out;
}
const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function withInlineImages(m, content) {
  for (const { cid, part } of inlineParts(m.payload)) {
    if (!content.toLowerCase().includes('cid:' + cid.toLowerCase())) continue;
    try {
      const data = part.body.data || (await api(`/messages/${m.id}/attachments/${part.body.attachmentId}`)).data;
      const url = `data:${part.mimeType || 'image/png'};base64,${data.replace(/-/g, '+').replace(/_/g, '/')}`;
      content = content.replace(new RegExp('cid:' + escapeRe(cid), 'gi'), url);
    } catch {}
  }
  return content;
}
function referencedCids(m) {
  const html = findPart(m.payload, 'text/html');
  const content = html ? decodePart(html).toLowerCase() : '';
  return new Set(inlineParts(m.payload).filter(({ cid }) => content.includes('cid:' + cid.toLowerCase())).map(({ part }) => part));
}

function bodyFrame(m) {
  const html = findPart(m.payload, 'text/html');
  const text = html ? null : findPart(m.payload, 'text/plain');
  const content = html ? lightOnly(decodePart(html))
    : text ? `<div style="white-space:pre-wrap">${escapeHtml(decodePart(text))}</div>`
    : '<p><i>(no text content)</i></p>';
  // No allow-scripts: email content can never run code. allow-same-origin
  // lets us measure the content to size the frame.
  const frame = el('iframe', {
    class: 'body', title: 'Message',
    sandbox: 'allow-same-origin allow-popups allow-popups-to-escape-sandbox',
  });
  frame.srcdoc = FRAME_HEAD + content;
  if (html && /cid:/i.test(content)) withInlineImages(m, content).then((c) => { if (c !== content) frame.srcdoc = FRAME_HEAD + c; });
  frame.addEventListener('load', () => {
    const doc = frame.contentDocument;
    if (!doc) return;
    // Keys pressed inside the email body don't reach the app; pass Esc on so it still closes the email.
    doc.addEventListener('keydown', (e) => { if (e.key === 'Escape') onKey({ key: 'Escape', target: frame }); });
    // Hovering any email address in the message (an email link, or an address typed as plain text)
    // shows a Copy button next to it.
    const btn = doc.createElement('button');
    btn.id = 'mb-copy'; btn.textContent = 'Copy'; btn.hidden = true;
    doc.body.append(btn);
    const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
    let hideTimer, lastMove = 0;
    let pointer = { x: 0, y: 0 };
    const showAt = (rect, addr) => {                    // just above the pointer; stays put for the same address
      clearTimeout(hideTimer);
      if (!btn.hidden && btn.dataset.addr === addr) return;
      btn.dataset.addr = addr;
      btn.hidden = false;
      btn.style.left = Math.max(2, pointer.x + doc.defaultView.scrollX - btn.offsetWidth / 2) + 'px';
      btn.style.top = Math.max(2, pointer.y + doc.defaultView.scrollY - btn.offsetHeight - 8) + 'px';
    };
    const hideSoon = () => { clearTimeout(hideTimer); hideTimer = setTimeout(() => { btn.hidden = true; }, 500); };
    const addressAt = (x, y) => {                         // the email address under the mouse, as {rect, addr}
      const pos = doc.caretRangeFromPoint?.(x, y);
      const node = pos?.startContainer;
      if (!node || node.nodeType !== 3) return null;
      for (const m of node.data.matchAll(EMAIL)) {
        if (pos.startOffset < m.index || pos.startOffset > m.index + m[0].length) continue;
        const r = doc.createRange();
        r.setStart(node, m.index); r.setEnd(node, m.index + m[0].length);
        const rect = r.getBoundingClientRect();
        if (x < rect.left - 2 || x > rect.right + 2 || y < rect.top - 2 || y > rect.bottom + 2) return null;
        return { rect, addr: m[0].replace(/\.$/, '') };
      }
      return null;
    };
    doc.addEventListener('mousemove', (e) => {
      if (e.timeStamp - lastMove < 40) return;          // at most ~25 checks a second
      lastMove = e.timeStamp;
      pointer = { x: e.clientX, y: e.clientY };
      if (e.target === btn) { clearTimeout(hideTimer); return; }
      const a = e.target.closest?.('a[href^="mailto:" i]');
      if (a) return showAt(a.getBoundingClientRect(), decodeURIComponent(a.getAttribute('href').slice(7).split('?')[0]));
      const hit = addressAt(e.clientX, e.clientY);
      if (hit) showAt(hit.rect, hit.addr); else hideSoon();
    });
    btn.addEventListener('click', (e) => { e.preventDefault(); copyAddress(btn.dataset.addr); btn.hidden = true; });
    // Measured with the frame collapsed: an email sized to its window ("height:100%") would otherwise get
    // taller every time the frame grew to fit it, without end. The holder keeps the reader's scroll in place.
    const fit = () => {
      const holder = frame.parentElement, de = doc.documentElement;
      if (!holder) return;
      holder.style.minHeight = holder.offsetHeight + 'px';
      frame.style.minHeight = '0';
      frame.style.height = '0';
      const height = de.scrollHeight;
      frame.style.height = height + 'px';
      // A sideways scrollbar on a wide email takes room from the text; give it back.
      frame.style.height = height + Math.max(0, de.scrollHeight - de.clientHeight) + 'px';
      frame.style.minHeight = holder.style.minHeight = '';
    };
    fit();
    new ResizeObserver(fit).observe(doc.body);
  });
  return frame;
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function downloadAttachment(msgId, part, threadId) {
  try {
    const r = await api(`/messages/${msgId}/attachments/${part.body.attachmentId}`);
    saveBlob(new Blob([b64urlBytes(r.data)], { type: part.mimeType }), part.filename);
    rememberDownload(msgId, threadId, part.filename);
  } catch (e) {
    if (!(e instanceof AuthError)) toast('Download failed: ' + e.message);
  }
}

// The Downloads button lists attachments saved through StediMail, kept in this browser. It can't see the
// computer's Downloads folder: a web page isn't allowed to, so a listed file may since have been moved.
const DOWNLOADS_KEPT = 50;
// The icon stays red from a new download until it's next clicked (Paul, 2026-11-05).
function markDownloads(unseen) {
  store.set('downloadsUnseen', unseen);
  $('#btn-downloads').classList.toggle('unseen', unseen);
}

function rememberDownload(msgId, threadId, filename, driveId) {
  const others = store.get('downloads', []).filter((d) => d.msgId !== msgId || d.filename !== filename);
  if (others.length === store.get('downloads', []).length) markDownloads(true);   // new to the list, not a repeat
  store.set('downloads', [{ msgId, threadId, filename, at: Date.now(), ...(driveId ? { driveId } : {}) }, ...others].slice(0, DOWNLOADS_KEPT));
}

// Gmail's attachment ids don't last, so find the file in its message again by name.
async function downloadedPart(d) {
  const m = await api(`/messages/${d.msgId}?format=full`);
  return attachmentsOf(m.payload).find((p) => p.filename === d.filename);
}

async function downloadAgain(d) {
  if (d.driveId) { await downloadDriveFile(d.driveId, d.msgId, d.threadId); return; }
  try {
    const part = await downloadedPart(d);
    if (part) await downloadAttachment(d.msgId, part, d.threadId);
    else toast(`“${d.filename}” is no longer in that email`);
  } catch (e) {
    if (!(e instanceof AuthError)) toast('Could not download it: that email may have been deleted');
  }
}

// What the browser can show in a tab, going by the file's extension. A page can't open the copy on the
// computer, so this shows Gmail's copy. Only these types, never HTML or SVG: a file opened this way runs
// as part of StediMail, and anything in it that could run code could reach the Gmail sign-in.
const VIEWABLE = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  txt: 'text/plain;charset=utf-8', csv: 'text/plain;charset=utf-8', log: 'text/plain;charset=utf-8',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm',
};

async function openDownload(d) {
  const type = VIEWABLE[d.filename.split('.').pop().toLowerCase()];
  if (!type) {
    toast(`A browser can't open “${d.filename}”, so it's downloading instead`);
    await downloadAgain(d);
    return;
  }
  const tab = window.open('', '_blank');         // now, while it still counts as the click: pop-up blockers
  if (d.driveId) {
    try {
      const f = await fetchDriveFile(d.driveId, () => {});
      if (!f || !tab) { tab?.close(); if (f) toast('Allow pop-ups for StediMail to open files'); return; }
      const url = URL.createObjectURL(new Blob([f.blob], { type }));
      tab.opener = null;
      tab.location = url;
      setTimeout(() => URL.revokeObjectURL(url), 300000);
    } catch (e) {
      tab?.close();
      toast('Could not open it: ' + e.message);
    }
    return;
  }
  try {
    const part = await downloadedPart(d);
    if (!part) { tab?.close(); toast(`“${d.filename}” is no longer in that email`); return; }
    if (!tab) { toast('Allow pop-ups for StediMail to open files'); return; }
    const r = await api(`/messages/${d.msgId}/attachments/${part.body.attachmentId}`);
    const url = URL.createObjectURL(new Blob([b64urlBytes(r.data)], { type }));
    tab.opener = null;
    tab.location = url;
    setTimeout(() => URL.revokeObjectURL(url), 300000);
  } catch (e) {
    tab?.close();
    if (!(e instanceof AuthError)) toast('Could not open it: that email may have been deleted');
  }
}

function openDownloads(anchor) {
  markDownloads(false);
  if ($('#menu.downloads')) { closeMenu(); return; }
  closeMenu();
  closeColorPicker();
  const list = store.get('downloads', []);
  const menu = el('div', { class: 'menu downloads', id: 'menu', role: 'menu' }, [
    el('div', { class: 'menu-head' }, list.length ? 'Downloaded from StediMail' : 'Attachments you download from StediMail will be listed here'),
  ]);
  for (const d of list) {
    const name = el('button', { type: 'button', class: 'menu-item', role: 'menuitem', title: `Open ${d.filename}` }, [
      el('span', { class: 'name' }, d.filename), el('time', {}, dateLabel(d.at)),
    ]);
    name.addEventListener('click', () => openDownload(d));
    const open = el('button', { type: 'button', class: 'open-email', title: 'Open its email', 'aria-label': `Open the email with ${d.filename}` }, icon('mail'));
    open.addEventListener('click', () => openThread(d.threadId));
    menu.append(el('div', { class: 'row' }, [name, open]));
  }
  document.body.append(menu);
  placePopup(menu, anchor);
  menu.querySelector('button')?.focus();
  setTimeout(() => document.addEventListener('click', closeMenu, { once: true }));
}

async function copyAddress(addr) {
  try { await navigator.clipboard.writeText(addr); toast(`Copied ${addr}`); }
  catch { toast('Could not copy'); }
}

// From / To / Cc with each address on its own; hovering one shows the Copy button just above the pointer.
function addrLine(fields) {
  const line = el('div', { class: 'addr' });
  fields.filter(([, v]) => v).forEach(([label, value], i) => {
    if (i) line.append(' · ');
    line.append(label + ' ');
    splitAddrs(value).forEach((a, j) => {
      if (j) line.append(', ');
      line.append(el('span', { class: 'addr-item', 'data-addr': addrOf(a) }, a));
    });
  });
  return line;
}

// One floating Copy button. It's placed just above the pointer when it arrives on an address and then
// stays put (so the mouse can reach it); it hides shortly after the pointer leaves both.
function setupCopyFloat() {
  const btn = el('button', { type: 'button', id: 'copy-float', hidden: '' }, 'Copy');
  document.body.append(btn);
  let hideTimer;
  btn.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  btn.addEventListener('mouseleave', () => { hideTimer = setTimeout(() => { btn.hidden = true; }, 400); });
  btn.addEventListener('click', () => { copyAddress(btn.dataset.addr); btn.hidden = true; });
  document.addEventListener('mousemove', (e) => {
    const item = e.target.closest?.('.addr-item');
    if (e.target === btn) return;
    if (!item) { if (!btn.hidden && !hideTimer) hideTimer = setTimeout(() => { btn.hidden = true; hideTimer = null; }, 500); return; }
    clearTimeout(hideTimer); hideTimer = null;
    if (btn.hidden || btn.dataset.addr !== item.dataset.addr) {
      btn.dataset.addr = item.dataset.addr;
      btn.hidden = false;
      btn.style.left = Math.max(4, e.clientX - btn.offsetWidth / 2) + 'px';
      btn.style.top = Math.max(4, e.clientY - btn.offsetHeight - 8) + 'px';
    }
  });
}

function renderMessage(m, expanded) {
  const from = header(m, 'from');
  const to = header(m, 'to');
  const cc = header(m, 'cc');
  const subject = header(m, 'subject');
  const details = el('details', { class: 'message' }, [
    el('summary', {}, [
      el('strong', {}, displayName(from)),
      el('time', {}, dateLabel(Number(m.internalDate), true)),
      el('div', { class: 'msg-subject' }, subject || '(no subject)'),
      el('div', { class: 'snippet' }, decodeEntities(m.snippet || '')),
    ]),
  ]);
  let loaded = false;
  const load = () => {
    if (loaded) return;
    loaded = true;
    details.append(addrLine([['From', from], ['To', to], ['Cc', cc]]));
    details.append(bodyFrame(m));
    const shownInside = referencedCids(m);           // pictures shown in the email aren't listed as files
    const files = attachmentsOf(m.payload).filter((p) => !shownInside.has(p));
    const driveFiles = driveFilesIn(m);
    if (files.length || driveFiles.length) {
      details.append(el('div', { class: 'files' }, [...files.map((p) => {
        const b = el('button', {}, '📎 ' + p.filename);
        b.addEventListener('click', () => downloadAttachment(m.id, p, m.threadId));
        return b;
      }), ...driveFiles.map((f) => {
        const label = '☁ ' + f.name;
        const b = el('button', { title: 'Download from Google Drive' }, label);
        b.addEventListener('click', async () => {
          if (b.disabled) return;
          b.disabled = true;
          await downloadDriveFile(f.id, m.id, m.threadId, (part) => { b.textContent = `${label}: ${Math.round(part * 100)}%`; });
          b.textContent = label;
          b.disabled = false;
        });
        return b;
      })]));
    }
  };
  details.open = expanded;
  if (expanded) load();
  details.addEventListener('toggle', () => { if (details.open) load(); });
  return details;
}

function refreshReaderActions(id) {
  const box = $('#reader-actions');
  if (box && state.openId === id) renderActions(box, id);
}

function renderActions(box, id) {
  const cols = columns();
  const t = state.threads.get(id);
  const current = t ? columnOf(t, cols) : -1;
  const color = t && colorOf(t);
  const colorBtn = el('button', { class: 'icon-btn color-btn', style: color ? `--swatch:${color.bg}` : null,
    title: color ? `Color: ${color.name}` : 'Color', 'aria-label': color ? `Color: ${color.name}` : 'Color' }, icon('palette'));
  colorBtn.addEventListener('click', (e) => { e.stopPropagation(); openColorPicker(colorBtn, id); });
  const gmail = el('a', {
    href: `https://mail.google.com/mail/?authuser=${encodeURIComponent(state.me)}#all/${id}`,
    target: '_blank', rel: 'noopener',
  }, 'Open in Gmail');
  box.replaceChildren(
    el('span', { class: 'label' }, 'Move to'),
    ...cols.map((c, i) => {
      const b = el('button', { class: i === current ? 'current' : null }, c.name);
      b.disabled = i === current;
      b.addEventListener('click', () => moveWithUndo(id, i));
      return b;
    }),
    el('span', { class: 'row-break' }),     // the icons always start their own line
    colorBtn,
    iconButton('Snooze', 'clock', (b) => openSnoozeMenu(b, id)),
    iconButton('Archive', 'archive', () => archiveThread(id)),
    iconButton('Report spam', 'spam', () => spamThread(id)),
    iconButton('Delete', 'trash', () => trashThread(id)),
    t?.unread
      ? iconButton('Mark as read', 'read', () => toggleRead(id))
      : iconButton('Mark as unread', 'unread', () => toggleRead(id)),
    gmail,
    // Unsubscribe sits right after "Open in Gmail" (Paul, 2026-11-03), kept when this row is redrawn.
    ...(state.unsub?.id === id ? [state.unsub.el] : []),
  );
}

const EMOJI = '😀 😂 😊 😍 🙂 😉 😎 🤔 😢 😮 👍 👎 👏 🙏 💪 👋 ❤️ 🎉 ✅ ❌ ⭐ 🔥 💡 📎'.split(' ');
const nameOf = (a) => (/^\s*"?([^"<]+?)"?\s*</.exec(a)?.[1] || addrOf(a)).trim();

// Reply box: Reply all by default (Reply only = just the sender), a formatted editor, and Gmail-style
// controls along the bottom: Send + Archive, Send, formatting, attach, link, emoji.
// Safe HTML for the editor from a saved draft (no scripts, styles, frames or event handlers).
function cleanHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,iframe,object,embed,link,meta').forEach((n) => n.remove());
  doc.querySelectorAll('*').forEach((n) => [...n.attributes].forEach((a) => {
    if (/^on/i.test(a.name) || /^\s*javascript:/i.test(a.value)) n.removeAttribute(a.name);
  }));
  return doc.body.innerHTML;
}

// Unsent reply text is kept as a Gmail draft on the thread when the email is closed (Esc, ✕, or
// opening another email), and comes back in the reply box when it's reopened.
async function flushReplyDraft() {
  const d = state.replyDraft;
  state.replyDraft = null;
  if (d) await d.save().catch((e) => { if (!(e instanceof AuthError)) toast('Could not save draft: ' + e.message); });
}

// Formatted editor with attachments, shared by the reply box and the compose window: the editor, its
// attachment chips, emoji pop-up and the formatting buttons (B I U, lists, attach, link, emoji).
function richEditor(placeholder, changed) {
  const files = [], links = [];   // links: files too big for email, on the way to Drive or already there
  const editor = el('div', { class: 'reply-editor', contenteditable: 'true', role: 'textbox', 'aria-multiline': 'true',
    'data-placeholder': placeholder });
  editor.addEventListener('input', changed);
  const chips = el('div', { class: 'reply-files' });
  const removeBtn = (name, run) => {
    const x = el('button', { type: 'button', title: 'Remove', 'aria-label': `Remove ${name}` }, '✕');
    x.addEventListener('click', run);
    return x;
  };
  const linkText = (l) => (l.status === 'uploading' ? `☁ ${l.file.name}: uploading to Drive ${l.percent}%`
    : l.status === 'ready' ? `☁ ${l.file.name} (${fileSize(l.file.size)}), Drive link`
      : `☁ ${l.file.name}: didn't upload. Remove it and attach it again.`);
  const removeLink = (l) => {
    links.splice(links.indexOf(l), 1);
    l.abort?.();
    if (l.id) removeFromDrive(l.id);     // never sent, so it needn't stay in their Drive
    changed();
    renderChips();
  };
  const renderChips = () => chips.replaceChildren(
    ...files.map((f, i) => el('span', { class: 'chip' }, [`📎 ${f.name} (${fileSize(f.size)})`,
      removeBtn(f.name, () => { files.splice(i, 1); changed(); renderChips(); })])),
    ...links.map((l) => {
      l.label = el('span', { role: 'status' }, linkText(l));
      return el('span', { class: 'chip' + (l.status === 'failed' ? ' failed' : '') }, [l.label, removeBtn(l.file.name, () => removeLink(l))]);
    }),
  );
  const startLink = (file) => {
    const l = { file, status: 'uploading', percent: 0 };
    links.push(l);
    l.done = shareOnDrive(file, (part) => {
      l.percent = Math.round(part * 100);
      if (l.label) l.label.textContent = linkText(l);       // only the words, so the ✕ stays still under the pointer
    }, (abort) => { l.abort = abort; }).then((r) => {
      l.status = 'ready';
      l.id = r.id;
      l.url = r.url;
      changed();
    }).catch((e) => {
      l.status = 'failed';
      if (links.includes(l)) toast(`Could not upload ${file.name}: ${e.message}`);
    }).finally(() => { l.abort = null; if (links.includes(l)) renderChips(); });
  };
  const addFiles = async (picked) => {
    const { fit, big } = splitForEmail(files, picked);
    files.push(...fit);
    if (fit.length) { changed(); renderChips(); }
    if (!big.length) return;
    const names = big.map((f) => `${f.name} (${fileSize(f.size)})`).join(', ');
    const yes = await askConfirm(`${names} ${big.length > 1 ? 'are' : 'is'} too big to send with the email. Upload to your Google Drive and put a link in the email?\n\nOnly the people you send the email to can open it, and they need to be signed in with that address. It stays in your Drive until you delete it.`, 'Upload to Drive');
    if (!yes) { toast('Not attached: too big for email'); return; }
    big.forEach(startLink);
    changed();
    renderChips();
  };
  const picker = el('input', { type: 'file', multiple: '', hidden: '' });
  picker.addEventListener('change', () => { const picked = [...picker.files]; picker.value = ''; addFiles(picked); });

  const fmt = (cmd, arg) => { editor.focus(); document.execCommand(cmd, false, arg); };
  const tool = (label, text, run, cls = '') => {
    const b = el('button', { type: 'button', class: 'tool ' + cls, title: label, 'aria-label': label }, text);
    b.addEventListener('mousedown', (e) => e.preventDefault());     // keep the text selection in the editor
    b.addEventListener('click', run);
    return b;
  };
  const emojiPop = el('div', { class: 'emoji-pop', hidden: '' },
    EMOJI.map((em) => tool(em, em, () => { fmt('insertText', em); emojiPop.hidden = true; })));
  const linkTool = () => {
    const url = prompt('Link address (https://…)');
    if (!url) return;
    const href = /^[a-z]+:/i.test(url) ? url : 'https://' + url;
    if (window.getSelection()?.toString()) fmt('createLink', href); else fmt('insertHTML', `<a href="${escapeHtml(href)}">${escapeHtml(url)}</a>`);
  };
  const formatTools = [
    tool('Bold', 'B', () => fmt('bold'), 'b'), tool('Italic', 'I', () => fmt('italic'), 'i'),
    tool('Underline', 'U', () => fmt('underline'), 'u'),
    tool('Bulleted list', '•', () => fmt('insertUnorderedList')), tool('Numbered list', '1.', () => fmt('insertOrderedList')),
    el('span', { class: 'sep' }),
    tool('Attach files', 'Attach file', () => picker.click(), 'word'), tool('Insert link', 'Insert link', linkTool, 'word'),
    tool('Emoji', '😊', () => { emojiPop.hidden = !emojiPop.hidden; }),
  ];
  return {
    editor, chips, emojiPop, picker, files, formatTools,
    isEmpty: () => !editor.innerText.trim() && !files.length && !links.length,
    content: () => {
      const ready = links.filter((l) => l.status === 'ready');
      return {
        text: editor.innerText + ready.map((l) => `\n\n${l.file.name} (${fileSize(l.file.size)}): ${l.url}`).join(''),
        html: editor.innerHTML + ready.map((l) => `<div><br></div><div>☁ <a data-drive-file="${escapeHtml(l.id)}" href="${escapeHtml(l.url)}">${escapeHtml(l.file.name)}</a> (${fileSize(l.file.size)}, Google Drive)</div>`).join(''),
        files,
      };
    },
    notReady() {                                    // why it can't be sent yet, if so
      const l = links.find((x) => x.status !== 'ready');
      return l && (l.status === 'uploading' ? `Still uploading ${l.file.name}` : `${l.file.name} didn't upload. Remove it first.`);
    },
    settled: () => Promise.all(links.map((l) => l.done)),
    driveIds: () => [...new Set([   // this session's uploads, and any in the text of a reopened draft
      ...links.map((l) => l.id),
      ...[...editor.querySelectorAll('a[data-drive-file]')].map((a) => a.dataset.driveFile),
    ])],
    loadDraft(message) {                            // pick up where Paul left off: text, formatting, attachments
      const html = findPart(message.payload, 'text/html'), text = findPart(message.payload, 'text/plain');
      editor.innerHTML = html ? cleanHtml(decodePart(html)) : escapeHtml(text ? decodePart(text) : '').replace(/\n/g, '<br>');
      Promise.all(attachmentsOf(message.payload).map(async (p) => {
        const r = await api(`/messages/${message.id}/attachments/${p.body.attachmentId}`);
        return new File([b64urlBytes(r.data)], p.filename, { type: p.mimeType });
      })).then((got) => { files.push(...got); renderChips(); }).catch(() => toast('Could not load the draft\'s attachments'));
    },
  };
}

// Dictation: the browser's own speech recognition types into the editor at the cursor. Listening ends on a
// click or when the browser hears silence, so the microphone never stays on unattended. Browsers without
// speech recognition (Firefox) get no buttons. There are two: a small one in the toolbar, always there, and
// a big one centered in an empty editor, which goes away at a touch anywhere else in the reply window.
function dictationTools(editor) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) return { toolbar: null, center: null, dismiss() {} };
  const label = 'Dictate (your browser sends your voice to its speech service)';
  const button = (cls) => el('button', { type: 'button', class: cls, title: label, 'aria-label': label, 'aria-pressed': 'false' }, icon('mic'));
  const toolbar = button('tool'), center = button('dictate-center');
  center.hidden = !!editor.innerText.trim();
  let rec = null;
  const showListening = (on) => [toolbar, center].forEach((b) => {
    b.classList.toggle('listening', on);
    b.setAttribute('aria-pressed', String(on));
  });
  const insert = (text) => {
    editor.focus();
    const sel = window.getSelection();
    if (!sel.rangeCount || !editor.contains(sel.anchorNode)) { sel.selectAllChildren(editor); sel.collapseToEnd(); }
    const before = sel.getRangeAt(0).cloneRange();
    before.selectNodeContents(editor);
    before.setEnd(sel.anchorNode, sel.anchorOffset);
    const after = sel.getRangeAt(0).cloneRange();
    after.selectNodeContents(editor);
    after.setStart(sel.focusNode, sel.focusOffset);
    const gap = (side, test) => (side.toString() && !test.test(side.toString()) ? ' ' : '');
    document.execCommand('insertText', false, gap(before, /\s$/) + text.trim() + gap(after, /^\s/));
  };
  const problems = {
    'not-allowed': 'Dictation needs permission to use the microphone',
    'service-not-allowed': 'This browser doesn\'t allow dictation here',
    'audio-capture': 'No microphone found',
    network: 'Dictation isn\'t available: this browser couldn\'t reach its speech service',
  };
  const toggle = () => {
    if (rec) { rec.stop(); return; }
    rec = new Recognition();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = navigator.language;
    rec.onresult = (e) => {
      if (!editor.isConnected) { rec?.abort(); return; }           // the reply was sent or closed
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) insert(e.results[i][0].transcript);
    };
    rec.onerror = (e) => { if (problems[e.error]) toast(problems[e.error]); };
    rec.onend = () => {
      rec = null;
      showListening(false);
      if (editor.innerText.trim()) center.hidden = true;           // it would sit on the words
    };
    try {
      rec.start();
      showListening(true);
    } catch (e) { rec = null; toast('Could not start dictation: ' + e.message); }
  };
  for (const b of [toolbar, center]) {
    b.addEventListener('mousedown', (e) => e.preventDefault());    // keep the cursor in the editor
    b.addEventListener('click', toggle);
  }
  editor.addEventListener('input', () => { if (!rec) center.hidden = true; });   // typed, not dictated
  // A touch anywhere else: the big button goes and the microphone goes off with it, unless the touch is on
  // the toolbar button, whose own click decides.
  const dismiss = (target) => {
    if (center.hidden || center.contains(target)) return;
    center.hidden = true;
    if (rec && !toolbar.contains(target)) rec.stop();
  };
  return { toolbar, center, dismiss };
}

function renderReplyBox(last, threadId, draft = null) {
  let replyAll = true;
  let draftId = draft?.id || null, dirty = false;
  const rich = richEditor('Click to type', () => { dirty = true; });
  const who = el('div', { class: 'reply-who' });
  const allBtn = el('button', { type: 'button' }, 'Reply all');
  const oneBtn = el('button', { type: 'button' }, 'Reply only');
  const setMode = (all) => {
    replyAll = all;
    allBtn.classList.toggle('current', all);
    oneBtn.classList.toggle('current', !all);
    const h = replyHeaders(last, all);
    who.textContent = (all ? 'REPLY ALL to: ' : 'REPLY to: ') + [h.To, h.Cc].filter(Boolean).flatMap(splitAddrs).map(nameOf).join(', ');
  };
  allBtn.addEventListener('click', () => { setMode(true); dirty = true; });
  oneBtn.addEventListener('click', () => { setMode(false); dirty = true; });
  // Reply all only makes sense (and is only the default) when it reaches more people than the sender.
  const people = (all) => { const h = replyHeaders(last, all); return [h.To, h.Cc].filter(Boolean).flatMap(splitAddrs).length; };
  const group = people(true) > people(false);
  if (!group) { allBtn.disabled = true; allBtn.title = 'Only one other person in this conversation'; }

  const sendBtn = el('button', { type: 'button', class: 'primary' }, 'Send');
  const sendArchive = el('button', { type: 'button' }, 'Send + Archive');
  const doSend = async (archiveAfter) => {
    if (rich.isEmpty()) { rich.editor.focus(); return; }
    if (rich.notReady()) { toast(rich.notReady()); return; }
    sendBtn.disabled = sendArchive.disabled = true;
    const was = archiveAfter ? sendArchive : sendBtn, label = was.textContent;
    was.textContent = 'Sending…';
    try {
      const c = rich.content(), h = replyHeaders(last, replyAll);
      await shareDriveFiles(rich.driveIds(), h);
      await sendMail(h, c.text, threadId, { html: c.html, files: c.files });
      if (state.replyDraft === me) state.replyDraft = null;      // sent: nothing to keep
      if (draftId) await api(`/drafts/${draftId}`, { method: 'DELETE' }).catch(() => {});   // gone before the reload below
      if (draft) closeDraftsFolder();
      toast('Reply sent');
      if (archiveAfter) { closeReader(); await archiveThread(threadId); } else openThread(threadId);
      loadBoard();
    } catch (e) {
      if (!(e instanceof AuthError)) toast('Send failed: ' + e.message);
      sendBtn.disabled = sendArchive.disabled = false;
      was.textContent = label;
    }
  };
  sendBtn.addEventListener('click', () => doSend(false));
  sendArchive.addEventListener('click', () => doSend(true));

  setMode(group);
  if (draft) {
    rich.loadDraft(draft.message);
    setMode(group && (!!header(draft.message, 'cc') || splitAddrs(header(draft.message, 'to')).length > 1));
  }
  const me = {
    threadId,
    async save() {
      if (!dirty) return;
      if (rich.isEmpty()) {                                    // emptied: drop the old draft
        if (draftId) await api(`/drafts/${draftId}`, { method: 'DELETE' });
        return;
      }
      await rich.settled();
      const c = rich.content();
      draftId = await saveDraft(replyHeaders(last, replyAll), c.text, threadId, draftId, { html: c.html, files: c.files });
      dirty = false;
      toast('Draft saved');
    },
  };
  state.replyDraft = me;
  const dictation = dictationTools(rich.editor);
  const box = el('div', { class: 'reply' }, [
    el('div', { class: 'reply-modes' }, [allBtn, oneBtn]), who,
    el('div', { class: 'reply-frame' }, [rich.editor, dictation.center]), rich.chips, rich.emojiPop,
    el('div', { class: 'reply-tools' }, [sendArchive, sendBtn, el('span', { class: 'sep' }), ...rich.formatTools, dictation.toolbar]), rich.picker,
  ]);
  box.addEventListener('pointerdown', (e) => dictation.dismiss(e.target));
  return box;
}

// The opened-email panel can be widened: drag its left edge, or the wider/narrower button in its
// header. Double-click the edge for the normal width. Remembered per browser.
const READER_NORMAL = 760, READER_MIN = 420;
const readerMax = () => Math.max(READER_MIN, window.innerWidth - 40);
const readerWide = () => settings.readerWidth && settings.readerWidth >= readerMax() - 10;

function applyReaderWidth(w) {
  if (w) document.body.style.setProperty('--reader-w', `${Math.min(w, readerMax())}px`);
  else document.body.style.removeProperty('--reader-w');
}

function setReaderWidth(w) {
  settings.readerWidth = w;
  store.set('readerWidth', w);
  applyReaderWidth(w);
  document.querySelectorAll('.reader-widen').forEach((b) => b.replaceWith(widenButton()));
}

function widenButton() {
  const wide = readerWide();
  const b = iconButton(wide ? 'Make narrower' : 'Make wider', wide ? 'narrow' : 'widen', () => {
    if (readerWide()) setReaderWidth(store.get('readerWidthBefore', null));
    else { store.set('readerWidthBefore', settings.readerWidth); setReaderWidth(readerMax()); }
  });
  b.classList.add('reader-widen');
  b.prepend(el('span', { class: 'widen-word' }, wide ? 'Narrow' : 'Full'));
  return b;
}

function setupReaderResize() {
  const h = $('#reader-resize');
  h.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    h.setPointerCapture(e.pointerId);
    document.body.classList.add('reader-resizing');
    const move = (ev) => {
      settings.readerWidth = Math.round(Math.min(readerMax(), Math.max(READER_MIN, window.innerWidth - ev.clientX)));
      applyReaderWidth(settings.readerWidth);
    };
    const up = () => {
      h.removeEventListener('pointermove', move);
      document.body.classList.remove('reader-resizing');
      setReaderWidth(settings.readerWidth);
    };
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', up, { once: true });
    h.addEventListener('pointercancel', up, { once: true });
  });
  h.addEventListener('dblclick', () => setReaderWidth(null));
  window.addEventListener('resize', () => applyReaderWidth(settings.readerWidth));
}

// ---- Unsubscribe (Paul, 2026-11-03): only on advertising and company-update emails (isBulk), from the
// List-Unsubscribe header, else the unsubscribe link in the email itself. ----
const UNSUB_CATEGORIES = ['CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS'];
// Sent to many people by a company: in one of Gmail's tabs, or carrying the headers only mass mail has
// (Gmail's category labels may be missing when its tabs are turned off). Personal mail has neither.
function isBulk(m) {
  return (m.labelIds || []).some((l) => UNSUB_CATEGORIES.includes(l))
    || !!header(m, 'list-unsubscribe') || !!header(m, 'list-id') || /bulk|list/i.test(header(m, 'precedence'));
}
function unsubscribeOf(msgs) {
  for (const m of [...msgs].reverse()) {
    const bulk = isBulk(m);
    const list = header(m, 'list-unsubscribe');
    const links = [...list.matchAll(/<([^>]+)>/g)].map((x) => x[1].trim());
    const web = links.find((u) => /^https:\/\//i.test(u));
    const mail = links.find((u) => /^mailto:/i.test(u));
    if (web || mail) {
      return { from: header(m, 'from'), web, mail, oneClick: !!web && /one-click/i.test(header(m, 'list-unsubscribe-post')) };
    }
    // No header: the unsubscribe link the law makes them put in the email itself (Paul: "unsubscribe at
    // the bottom of the email is required").
    // Not marked as mass mail (Gmail's tabs off, or an "account notice" like Delta's): an actual
    // "Unsubscribe" link in the email is itself the sign of a company's email (Paul, 2026-11-03).
    const inBody = unsubscribeInBody(m, !bulk);
    if (inBody) return { from: header(m, 'from'), web: inBody, oneClick: false };
  }
  return null;
}
const UNSUB_WORDS = /unsubscri|opt[\s-]?out|email preferences|manage (?:your )?(?:subscription|preferences|email)/i;
function unsubscribeInBody(m, strict = false) {
  const html = findPart(m.payload, 'text/html');
  if (html) {
    const doc = new DOMParser().parseFromString(decodePart(html), 'text/html');
    const links = [...doc.querySelectorAll('a[href^="http"]')];
    // Best: the words in the link's text; then in its address; the last such link (footers are at the end).
    const words = strict ? /unsubscri/i : UNSUB_WORDS;     // strict: the link itself says "unsubscribe"
    const byText = links.filter((a) => words.test(a.textContent || '') || words.test(a.title || ''));
    const byHref = strict ? [] : links.filter((a) => /unsub|optout|opt-out/i.test(a.getAttribute('href')));
    const a = byText.pop() || byHref.pop();
    if (a) return a.getAttribute('href');
  }
  const text = findPart(m.payload, 'text/plain');
  if (text && !strict) {
    const t = decodePart(text);
    const near = [...t.matchAll(/https?:\/\/[^\s<>")]+/g)].filter((x) =>
      UNSUB_WORDS.test(t.slice(Math.max(0, x.index - 80), x.index + x[0].length)) || /unsub|optout/i.test(x[0]));
    if (near.length) return near.pop()[0];
  }
  return null;
}
// The sender's one-click address (RFC 8058). Sent as a form to a new tab, because the page's security
// rules only let fetch() talk to Google, and that promise is worth keeping. Their reply shows in the tab.
function postOneClick(url) {
  const form = el('form', { method: 'POST', action: url, target: '_blank', rel: 'noopener', hidden: '' }, [
    el('input', { type: 'hidden', name: 'List-Unsubscribe', value: 'One-Click' }),
  ]);
  document.body.append(form);
  form.submit();
  form.remove();
}
function unsubscribedOn() {
  return store.get('unsubscribed', {});
}
function renderUnsubscribe(msgs, threadId) {
  const u = unsubscribeOf(msgs);
  if (!u) return null;
  const name = displayName(u.from);
  const addr = (u.from.match(/<([^>]+)>/)?.[1] || u.from).toLowerCase();
  const asked = unsubscribedOn()[addr];
  const btn = el('button', { type: 'button', class: 'unsub-btn' }, asked ? `Unsubscribe again (asked ${asked})` : 'Unsubscribe');
  btn.addEventListener('click', async () => {
    if (!await askConfirm(`Unsubscribe from ${name}?\n\nThey should stop sending these emails (some take a few days), and this email goes to Trash.`, 'Unsubscribe')) return;
    let done = '';
    try {
      if (u.oneClick) {
        postOneClick(u.web);
        done = `Unsubscribe request sent to ${name}: their reply opened in a new tab.`;
      } else if (u.mail) {
        const url = new URL(u.mail);
        const to = decodeURIComponent(url.pathname);
        await sendMail({ To: to, Subject: url.searchParams.get('subject') || 'unsubscribe' }, url.searchParams.get('body') || 'unsubscribe');
        done = `Unsubscribe email sent to ${name} from your Gmail.`;
      } else {
        window.open(u.web, '_blank', 'noopener');
        done = `${name}'s unsubscribe page opened in a new tab: finish there.`;
      }
      const all = unsubscribedOn();
      all[addr] = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      store.set('unsubscribed', all);
      btn.textContent = 'Unsubscribe requested';
      btn.disabled = true;
      // Unsubscribed: the email goes to Trash too (Paul, 2026-11-03); Undo brings the email back.
      if (threadId) await trashThread(threadId, `${done} The email is in Trash.`);
      else toast(done);
    } catch (e) { if (!(e instanceof AuthError)) toast('Unsubscribe failed: ' + e.message); }
  });
  return el('div', { class: 'unsub' }, [btn, el('span', { class: 'hint' }, `from ${name}`)]);
}

// The newest message first and open, right at the top; the earlier ones folded away behind a small
// "↑ N earlier messages" button above it, shown in date order (closed) when clicked (Paul, 2026-11-03).
function renderMessages(msgs) {
  const box = el('div', { class: 'messages' });
  const latest = msgs[msgs.length - 1];
  const earlier = msgs.slice(0, -1);
  if (!latest) return box;
  if (earlier.length) {
    const unread = earlier.filter((m) => (m.labelIds || []).includes('UNREAD')).length;
    const n = earlier.length;
    const more = el('button', { type: 'button', class: 'earlier-btn', 'aria-expanded': 'false' },
      `↑ ${n} earlier message${n === 1 ? '' : 's'}${unread ? ` (${unread} unread)` : ''}`);
    const list = el('div', { class: 'earlier', hidden: '' }, earlier.map((m) => renderMessage(m, false)));
    more.addEventListener('click', () => {
      const open = list.hidden;
      list.hidden = !open;
      more.setAttribute('aria-expanded', String(open));
      more.textContent = open ? `↓ Hide ${n} earlier message${n === 1 ? '' : 's'}`
        : `↑ ${n} earlier message${n === 1 ? '' : 's'}${unread ? ` (${unread} unread)` : ''}`;
    });
    box.append(more, list);
  }
  box.append(renderMessage(latest, true));
  return box;
}

// The installed app takes its account's address as its name, so a launcher with several accounts can tell
// them apart. The site is static, so this account's manifest is built here in the page.
async function nameAppForAccount(email) {
  const base = new URL('manifest.webmanifest', location.href);
  const abs = (u) => new URL(u, base).href;   // a blob: manifest has no address of its own to resolve these against
  const m = await (await fetch(base)).json();
  m.name = m.short_name = `StediMail - ${email}`;
  m.id = abs(m.id);
  m.start_url = abs(m.start_url);
  m.scope = abs(m.scope);
  m.icons = m.icons.map((i) => ({ ...i, src: abs(i.src) }));
  $('link[rel="manifest"]').href = URL.createObjectURL(new Blob([JSON.stringify(m)], { type: 'application/manifest+json' }));
}

// "Install StediMail" in the top bar, only in a normal browser tab where the browser can install it
// (Paul, 2026-11-03: testers opening stedimail.com kept Chrome's address and bookmark bars). Gone once it
// is installed or opened as an app.
function setupInstallButton() {
  if (state.me) nameAppForAccount(state.me).catch(() => {});   // no account yet, or it failed: plain "StediMail"
  const btn = $('#btn-install');
  const asApp = () => matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: window-controls-overlay)').matches
    || navigator.standalone === true;
  let offer = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();                       // keep it for our button instead of the browser's own pop-up
    offer = e;
    btn.hidden = asApp();
  });
  window.addEventListener('appinstalled', () => { offer = null; btn.hidden = true; toast('StediMail is installed: open it from your apps.'); });
  // Safari on iPhone/iPad never offers it: show how to do it by hand.
  const iosSafari = /iP(hone|ad|od)/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS/.test(navigator.userAgent);
  if (iosSafari && !asApp()) btn.hidden = false;
  btn.addEventListener('click', async () => {
    if (offer) {
      offer.prompt();
      const { outcome } = await offer.userChoice;
      if (outcome === 'accepted') btn.hidden = true;
      offer = null;
    } else if (iosSafari) {
      toast('In Safari: tap Share (the square with an arrow), then “Add to Home Screen”.');
    }
  });
}

function readerHead(title) {
  const x = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  x.setAttribute('viewBox', '0 0 24 24');
  x.setAttribute('aria-hidden', 'true');
  x.innerHTML = '<path d="M5 5l14 14M19 5L5 19"/>';
  const close = el('button', { type: 'button', class: 'reader-close', title: 'Close (Esc)', 'aria-label': 'Close' },
    [x, el('kbd', { class: 'esc-hint' }, 'ESC')]);
  close.addEventListener('click', closeReader);
  return el('div', { class: 'reader-head' }, [el('h2', {}, title), widenButton(), close]);
}

// A draft opens at the reply box, which is the last thing in the reader. The emails above it are still
// loading and growing, so this stays at the bottom until they settle or Paul scrolls himself.
function showReplyBox(reader, messages) {
  let placed = -1;
  const toBottom = () => {
    if (!messages.isConnected || reader.scrollTop < placed) { stop(); return; }   // moved on, or he scrolled up
    reader.scrollTop = reader.scrollHeight;
    placed = reader.scrollTop;
  };
  const watch = new ResizeObserver(toBottom);
  const timer = setTimeout(() => stop(), 5000);
  function stop() {
    watch.disconnect();
    clearTimeout(timer);
  }
  watch.observe(messages);
  toBottom();
}

async function openThread(id) {
  await flushReplyDraft();                 // save unsent reply text first, so reopening shows it
  state.openId = id;
  document.querySelectorAll('.card.open').forEach((c) => c.classList.remove('open'));
  document.querySelector(`.card[data-id="${id}"]`)?.classList.add('open');
  const reader = $('#reader');
  reader.hidden = false;
  reader.replaceChildren(el('p', { class: 'hint' }, 'Loading…'));
  try {
    const thread = await api(`/threads/${id}?format=full`);
    if (state.openId !== id) return;
    const all = thread.messages || [];
    const isDraft = (m) => (m.labelIds || []).includes('DRAFT');
    const msgs = all.filter((m) => !isDraft(m));
    const draftMsg = all.filter(isDraft).pop();
    let draft = null;
    if (draftMsg) {
      const { drafts = [] } = await api('/drafts?maxResults=500');
      const d = drafts.find((x) => x.message?.id === draftMsg.id);
      if (d) draft = { id: d.id, message: draftMsg };
    }
    if (state.openId !== id) return;
    if (!msgs.length && draft) { openCompose(draft); return; }   // a new-message draft, not a reply
    const actions = el('div', { class: 'actions', id: 'reader-actions' });
    const unsub = renderUnsubscribe(msgs, id);
    state.unsub = unsub ? { id, el: unsub } : null;
    renderActions(actions, id);
    const messages = renderMessages(msgs);
    reader.replaceChildren(
      el('div', { class: 'reader-top' }, [readerHead(header(msgs[0] || {}, 'subject') || '(no subject)'), actions]),
      messages,
      renderReplyBox(msgs[msgs.length - 1] || draftMsg, id, draft),
    );
    reader.scrollTop = 0;                    // the newest message starts at the top of the window
    if (draft) showReplyBox(reader, messages);
    const t = state.threads.get(id);
    if (t?.unread) {
      await api(`/threads/${id}/modify`, { method: 'POST', body: { removeLabelIds: ['UNREAD'] } });
      t.unread = false;
      t.labels.delete('UNREAD');
      render();
    }
  } catch (e) {
    if (!(e instanceof AuthError) && state.openId === id) {
      reader.replaceChildren(readerHead('Error'), el('p', { class: 'hint' }, 'Could not open: ' + e.message));
    }
  }
}

// New message, with the same editor and controls as replies. Closing it with anything typed keeps it
// as a Gmail draft; a new-message draft opened from the Drafts folder comes back here (draft = { id, message }).
// ---------- address suggestions (To field) ----------
// Google Contacts + "Other contacts" via the People API (needs it turned on in the Cloud project);
// addresses from loaded emails are always added, so suggestions work even without it.
let contactsLoad = null;
function loadContacts() {
  if (contactsLoad) return contactsLoad;
  contactsLoad = (async () => {
    const list = [];
    const grab = async (path, key) => {
      let page = '';
      do {
        const res = await fetch(`https://people.googleapis.com/v1/${path}${page ? '&pageToken=' + page : ''}`,
          { headers: { Authorization: 'Bearer ' + state.token } });
        if (!res.ok) throw new Error(res.status === 403 ? 'People API is off' : res.statusText);
        const r = await res.json();
        for (const p of r[key] || []) {
          const name = p.names?.[0]?.displayName || '';
          for (const e of p.emailAddresses || []) if (e.value) list.push({ name, addr: e.value.toLowerCase(), saved: key === 'connections' });
        }
        page = r.nextPageToken;
      } while (page);
    };
    try {
      await grab('people/me/connections?personFields=names,emailAddresses&pageSize=1000', 'connections');
      await grab('otherContacts?readMask=names,emailAddresses&pageSize=1000', 'otherContacts');
    } catch (e) {
      console.warn('Contacts unavailable:', e.message);
      contactsLoad.failed = e.message;
    }
    return list;
  })();
  return contactsLoad;
}

// Gmail ignores dots and anything after a + in its addresses, so these all reach the same mailbox.
const sameMailbox = (a, b) => {
  const plain = (addr) => {
    const [local, domain] = addr.toLowerCase().split('@');
    return /^(gmail|googlemail)\.com$/.test(domain) ? local.split('+')[0].replace(/\./g, '') + '@gmail.com' : addr.toLowerCase();
  };
  return plain(a) === plain(b);
};

let ownName = null;
function loadOwnName() {
  ownName ||= api('/settings/sendAs').then((r) => (r.sendAs || []).find((x) => x.isPrimary)?.displayName || '').catch(() => '');
  return ownName;
}

async function contactMatches(q) {
  const me = state.me.toLowerCase();
  const seen = new Map();
  const add = (c) => { if (c.addr && !sameMailbox(c.addr, me) && !seen.has(c.addr)) seen.set(c.addr, c); };   // their own comes once, below
  seen.set(me, { name: await loadOwnName(), addr: me, saved: true });
  (await loadContacts()).forEach(add);
  for (const t of [...state.threads.values(), ...state.suggestCache.values()]) (t.senders || []).forEach((p) => add({ name: p.name, addr: p.addr }));
  const lq = q.toLowerCase();
  const score = (c) => {
    const words = c.name.toLowerCase().split(/\s+/);
    if (c.addr.startsWith(lq) || words.some((w) => w.startsWith(lq)) || c.name.toLowerCase().startsWith(lq)) return c.saved ? 0 : 1;
    if (c.addr.includes(lq) || c.name.toLowerCase().includes(lq)) return 2;
    return 9;
  };
  return [...seen.values()].map((c) => [score(c), c]).filter(([n]) => n < 9)
    .sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name)).slice(0, 8).map(([, c]) => c);
}

// Suggest contacts for the address being typed (after the last comma); picking one adds "Name <addr>, ".
function attachContactSuggest(input) {
  const wrap = el('div', { class: 'to-wrap' });
  input.replaceWith(wrap);
  const panel = el('div', { class: 'suggest', role: 'listbox', hidden: '' });
  wrap.append(input, panel);
  let items = [], active = 0, seq = 0;
  const close = () => { panel.hidden = true; items = []; };
  const current = () => { const parts = input.value.split(','); return parts[parts.length - 1].trim(); };
  const pick = (c) => {
    const parts = input.value.split(',').slice(0, -1).map((x) => x.trim()).filter(Boolean);
    parts.push(c.name ? `${c.name} <${c.addr}>` : c.addr);
    input.value = parts.join(', ') + ', ';
    input.dispatchEvent(new Event('input'));
    close(); input.focus();
  };
  input.addEventListener('input', async () => {
    const q = current(), mine = ++seq;
    if (q.length < 1) { close(); return; }
    const found = await contactMatches(q);
    if (mine !== seq) return;
    items = found; active = 0;
    if (!items.length) { close(); return; }
    panel.replaceChildren(...items.map((c, i) => {
      const r = el('div', { class: 'suggest-item' + (i === active ? ' active' : ''), role: 'option' }, [
        el('span', { class: 'suggest-icon' }, icon('person')),
        el('span', { class: 'suggest-text' }, [el('span', { class: 'suggest-label' }, c.name || c.addr), c.name ? el('span', { class: 'suggest-sub' }, c.addr) : null]),
      ]);
      r.addEventListener('mousedown', (e) => { e.preventDefault(); pick(c); });
      return r;
    }));
    panel.hidden = false;
  });
  input.addEventListener('keydown', (e) => {
    if (panel.hidden || !items.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      [...panel.children].forEach((r, i) => r.classList.toggle('active', i === active));
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault(); pick(items[active]);
    } else if (e.key === 'Escape') {
      e.stopPropagation(); close();
    }
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('focus', () => loadContacts());       // start loading early
}

function openCompose(draft = null) {
  flushReplyDraft();
  state.openId = null;
  document.querySelectorAll('.card.open').forEach((c) => c.classList.remove('open'));
  let draftId = draft?.id || null, dirty = false;
  const changed = () => { dirty = true; };
  const to = el('input', { placeholder: 'To', autocomplete: 'off' });
  const subject = el('input', { placeholder: 'Subject' });
  for (const f of [to, subject]) f.addEventListener('input', changed);
  const toBox = el('div', {}, to);                     // attachContactSuggest wraps the field in place
  const rich = richEditor('Message', changed);
  if (draft) {
    to.value = header(draft.message, 'to');
    subject.value = header(draft.message, 'subject');
    rich.loadDraft(draft.message);
  }
  const headers = () => ({ To: to.value.trim(), Subject: subject.value });
  const me = {
    threadId: null,
    async save() {
      if (!dirty) return;
      if (!to.value.trim() && !subject.value.trim() && rich.isEmpty()) {   // emptied: drop the old draft
        if (draftId) await api(`/drafts/${draftId}`, { method: 'DELETE' });
        return;
      }
      await rich.settled();
      const c = rich.content();
      draftId = await saveDraft(headers(), c.text, null, draftId, { html: c.html, files: c.files });
      dirty = false;
      toast('Draft saved');
    },
  };
  const send = el('button', { type: 'button', class: 'primary' }, 'Send');
  send.addEventListener('click', async () => {
    if (!to.value.trim()) { to.focus(); return; }
    if (rich.notReady()) { toast(rich.notReady()); return; }
    send.disabled = true;
    send.textContent = 'Sending…';
    try {
      const c = rich.content();
      await shareDriveFiles(rich.driveIds(), headers());
      await sendMail(headers(), c.text, null, { html: c.html, files: c.files });
      if (state.replyDraft === me) state.replyDraft = null;      // sent: nothing to keep
      if (draftId) await api(`/drafts/${draftId}`, { method: 'DELETE' }).catch(() => {});   // gone before the reload below
      if (draft) closeDraftsFolder();
      toast('Sent');
      closeReader();
      loadBoard();
    } catch (e) {
      if (!(e instanceof AuthError)) toast('Send failed: ' + e.message);
      send.disabled = false;
      send.textContent = 'Send';
    }
  });
  const reader = $('#reader');
  const dictation = dictationTools(rich.editor);
  const box = el('div', { class: 'compose' }, [
    toBox, subject, el('div', { class: 'reply-frame' }, [rich.editor, dictation.center]), rich.chips, rich.emojiPop,
    el('div', { class: 'reply-tools' }, [send, el('span', { class: 'sep' }), ...rich.formatTools, dictation.toolbar]), rich.picker,
  ]);
  // Filling in To (with its suggestions) and Subject comes first here, so those leave the big microphone in place.
  box.addEventListener('pointerdown', (e) => { if (!e.target.closest('input, .to-wrap')) dictation.dismiss(e.target); });
  reader.replaceChildren(readerHead(draft ? 'Draft' : 'New message'), box);
  reader.hidden = false;
  attachContactSuggest(to);
  state.replyDraft = me;
  (draft && to.value ? rich.editor : to).focus();
}

function closeReader() {
  flushReplyDraft();
  const id = state.openId;
  state.openId = null;
  $('#reader').hidden = true;
  $('#reader').replaceChildren();
  document.querySelectorAll('.card.open').forEach((c) => c.classList.remove('open'));
  if (id) document.querySelector(`.card[data-id="${id}"]`)?.focus();
}

// ---------- settings & wiring ----------

// One editable row per column. data-orig remembers the name the column had
// when Settings opened, so a changed name is a rename (label carries over)
// rather than a brand-new column.
function columnRow(name, orig, isInbox) {
  const input = el('input', { 'aria-label': 'Column name', 'data-orig': orig || '' });
  input.value = name;
  const row = el('div', { class: 'col-row' }, [input]);
  if (isInbox) {
    row.classList.add('inbox');
    row.append(el('span', { class: 'hint' }, 'your inbox'));
    return row;
  }
  const btn = (label, text, fn) => {
    const b = el('button', { type: 'button', class: 'icon-btn', title: label, 'aria-label': label }, text);
    b.addEventListener('click', fn);
    return b;
  };
  row.append(
    btn('Move up', '↑', () => {
      const prev = row.previousElementSibling;
      if (prev && !prev.classList.contains('inbox')) prev.before(row);
    }),
    btn('Move down', '↓', () => row.nextElementSibling?.after(row)),
    btn('Remove column', '✕', () => row.remove()),
  );
  return row;
}

// Apps Script helper (runs in the user's own Google account every 5 minutes): wakes Mailboard-snoozed
// emails on time even when Mailboard is closed. Same label format as snoozeName()/snoozeDue().
const SNOOZE_SCRIPT = `// StediMail snooze helper: brings snoozed emails back to the Inbox on time.
// Run "install" once (allow access when asked). It then checks every 5 minutes.
const PREFIX = 'Mailboard/Snooze/';
const FLAG = 'Mailboard Snoozed';

function wakeSnoozed() {
  const now = new Date();
  const flag = GmailApp.getUserLabelByName(FLAG);
  GmailApp.getUserLabels().forEach(function (label) {
    const name = label.getName();
    if (name.indexOf(PREFIX) !== 0) return;
    const m = /^(\\d{4})(\\d{2})(\\d{2})-(\\d{2})(\\d{2})Z$/.exec(name.slice(PREFIX.length));
    if (!m) return;
    const due = new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]));
    if (due > now) return;
    let threads;
    while ((threads = label.getThreads(0, 100)).length) {
      GmailApp.moveThreadsToInbox(threads);
      GmailApp.markThreadsUnread(threads);
      if (flag) flag.removeFromThreads(threads);
      label.removeFromThreads(threads);
    }
    label.deleteLabel();
  });
}

function install() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('wakeSnoozed').timeBased().everyMinutes(5).create();
  wakeSnoozed();
}
`;

const DEFAULT_BAR = '#373a2b';

// Color the top bar and column headers (and the window's title bar on Windows/Mac via theme-color),
// with light or dark text so it stays readable.
function applyBarColor(hex) {
  const c = /^#[0-9a-f]{6}$/i.test(hex || '') ? hex : DEFAULT_BAR;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const light = 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.35;     // bright color: dark text
  const root = document.documentElement.style;
  root.setProperty('--bar-bg', c);
  root.setProperty('--bar-text', light ? '#1b1d21' : '#eef0e4');
  root.setProperty('--bar-muted', light ? '#3f444c' : '#c3c7b2');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', c);
}

function openSettings() {
  $('#set-barcolor').value = settings.barColor || DEFAULT_BAR;
  $('#set-columns').replaceChildren(
    columnRow(settings.inboxName, null, true),
    ...settings.columns.map((n) => columnRow(n, n)),
  );
  $('#set-client').value = settings.clientId;
  $('#set-error').textContent = '';
  $('#settings').showModal();
}

// Read and check the form; returns { error } or the new settings.
function readSettingsForm() {
  const rows = [...$('#set-columns').querySelectorAll('input')].map((i) => ({
    name: isOwnLabel(i.dataset.orig) ? i.value.trim() : i.value.replace(/\//g, '-').trim(),
    orig: i.dataset.orig,
  }));
  const [inbox, ...rest] = rows;
  const cols = rest.filter((r) => r.name);
  const names = [inbox.name || settings.inboxName, ...cols.map((r) => r.name)];
  if (names.length > 9) return { error: 'Nine columns at most.' };
  if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) return { error: 'Two columns have the same name.' };
  return {
    inboxName: names[0],
    cols,
    clientId: $('#set-client').value.trim(),
  };
}

async function renameLabel(oldName, newName) {
  if (columnSorts[oldName]) {
    columnSorts[newName] = columnSorts[oldName];
    delete columnSorts[oldName];
    store.set('sorts', columnSorts);
  }
  let id = state.labelIds[oldName];
  if (!id) {
    const { labels = [] } = await api('/labels');
    id = labels.find((l) => l.name === labelNameOf(oldName))?.id;
  }
  const own = isOwnLabel(oldName);
  if (id) await api(`/labels/${id}`, { method: 'PATCH', body: { name: own ? newName : LABEL_PREFIX + newName } });
  if (own) {
    delete settings.columnLabels[oldName];
    settings.columnLabels[newName] = newName;
    store.set('columnLabels', settings.columnLabels);
  }
  if (!id) return; // label was never created, so there is nothing to carry over
  delete state.labelIds[oldName];
  state.labelIds[newName] = id;
}

// Gmail's rules are its filters; they live in Gmail's own settings (opened for the signed-in account).
function openGmailRules() {
  // Default signed-in account. Tried: ?authuser=<email> lands on the Inbox (drops #settings/filters);
  // /mail/u/<email>/ gives Gmail's "Temporary Error (404)".
  window.open('https://mail.google.com/mail/#settings/filters', '_blank', 'noopener');
}

async function applySettings({ inboxName, cols, clientId }) {
  for (const c of cols) {
    if (!c.orig || c.orig === c.name) continue;
    try {
      await renameLabel(c.orig, c.name);
    } catch (e) {
      if (!(e instanceof AuthError)) toast(`Could not rename “${c.orig}”: ${e.message}`);
      c.name = c.orig;
    }
  }
  settings.inboxName = inboxName;
  settings.columns = cols.map((c) => c.name);
  store.set('inboxName', settings.inboxName);
  store.set('columns', settings.columns);
  if (clientId && clientId !== settings.clientId) {
    store.set('clientId', clientId);
    location.reload();
    return;
  }
  assign(columns());
  render();
  loadBoard();
}

function disarmDelete() {
  if (!state.armedDelete) return;
  clearTimeout(state.armedDelete.timer);
  const card = document.querySelector(`.card[data-id="${state.armedDelete.id}"]`);
  card?.classList.remove('delete-armed');
  card?.querySelector('.delete-hint')?.remove();
  state.armedDelete = null;
}

function onKey(e) {
  // Ctrl+Z: undo the last change (in a text field or while writing, the field's own undo instead).
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z'
      && !e.target.closest?.('input, textarea, [contenteditable], #reader')) {
    e.preventDefault();
    undoLast();
    return;
  }
  // Typing in a field ignores shortcuts, except Esc inside the email window: it closes it (drafts are kept).
  const escInReader = e.key === 'Escape' && e.target.closest?.('#reader');
  if (e.target.closest?.('input, textarea, dialog') && !escInReader) return;
  if (e.key === 'Escape' && state.armedDelete) { disarmDelete(); return; }
  if (e.key === 'Escape' && $('#color-pop')) { closeColorPicker(); return; }
  if (e.key === 'Escape' && $('#menu')) { closeMenu(); return; }
  if (e.key === 'Escape' && !$('#reader').hidden) { closeReader(); return; }
  if (e.key === 'Escape' && state.selected.size) { clearSelection(); return; }
  // Delete / Backspace: the card under the mouse (highlighted) goes to Trash; else the focused card.
  if ((e.key === 'Delete' || e.key === 'Backspace') && !e.ctrlKey && !e.metaKey && !e.altKey
      && !e.target.closest?.('#reader, [contenteditable]')) {        // never while typing a reply or message
    // The card under the pointer right now (":hover" lags after the board redraws, e.g. right after
    // the previous delete moved the next card up under the mouse), else the focused card.
    const under = state.pointer && document.elementFromPoint(state.pointer.x, state.pointer.y)?.closest('.card');
    const target = under || document.activeElement?.closest?.('.card');
    if (target) {
      e.preventDefault();
      // Two presses on purpose: the first marks the card, a second within 3 s moves it to Trash.
      const id = target.dataset.id;
      if (state.armedDelete?.id === id && Date.now() - state.armedDelete.at < 3000) {
        disarmDelete(); trashThread(id);
      } else {
        disarmDelete();
        target.classList.add('delete-armed');
        target.append(el('div', { class: 'delete-hint' }, 'Press Delete again to trash'));
        state.armedDelete = { id, at: Date.now(), timer: setTimeout(disarmDelete, 3000) };
      }
      return;
    }
  }
  const card = document.activeElement?.closest?.('.card');
  if (!card || e.ctrlKey || e.metaKey || e.altKey) return;
  const id = card.dataset.id;
  const col = Number(card.dataset.col);
  if (/^[1-9]$/.test(e.key) && Number(e.key) <= columns().length) {
    e.preventDefault();
    moveWithUndo(id, Number(e.key) - 1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    openThread(id);
  } else if (e.key === 'e') {
    archiveThread(id);
  } else if (e.key === 'u') {
    toggleRead(id);
  } else if (e.key === 'x') {
    toggleSelect(id);
  } else if (e.key === 'c') {
    e.preventDefault();
    openColorPicker(card, id);
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 'nextElementSibling' : 'previousElementSibling';
    let next = card[step];
    while (next?.hidden) next = next[step];              // past the emails inside a closed nest
    next?.focus();
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    const target = document.querySelector(`.column[data-col="${col + (e.key === 'ArrowRight' ? 1 : -1)}"] .cards`);
    if (target?.children.length) {
      const idx = [...card.parentNode.children].indexOf(card);
      target.children[Math.min(idx, target.children.length - 1)].focus();
    }
  }
}

// Search suggestions, like Gmail's: with the box empty, recent searches and quick filters (Has attachment,
// Last 7 days, From me); while typing, a grey completion from recent searches (Tab accepts), matching
// emails (loaded ones at once, then Gmail's own search), and "All search results" (Enter).
state.suggestCache = new Map();
const QUICK_FILTERS = [['Has attachment', 'has:attachment'], ['Last 7 days', 'newer_than:7d'], ['From me', 'from:me']];
// Where to look (Paul, 2026-11-05). One at a time, so choosing another replaces it.
const SEARCH_PLACES = [['Search all mail', 'in:anywhere', 'Everything, including Spam and Trash'], ['Search sent', 'in:sent', 'Sent mail'], ['Search trash', 'in:trash', 'Trash']];
const SEARCH_PLACE = /(^|\s)in:(anywhere|sent|trash)(?=\s|$)/gi;

function rememberSearch(q) {
  q = (q || '').trim();
  if (!q) return;
  store.set('recentSearches', [q, ...store.get('recentSearches', []).filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 12));
}

function setupSearchSuggest() {
  const input = $('#search');
  const form = $('#search-form');
  const panel = el('div', { id: 'suggest', class: 'suggest', role: 'listbox', hidden: '' });
  const ghost = el('div', { class: 'search-ghost', 'aria-hidden': 'true' });
  form.append(panel, ghost);
  const cache = state.suggestCache;           // id -> summary for emails found by Gmail search
  let rows = [], active = -1, seq = 0, timer, completion = '';

  const close = () => { panel.hidden = true; rows = []; active = -1; setGhost(''); };
  const go = (q) => { close(); input.value = q; runSearch(q); };
  const setGhost = (rest) => {                // grey completion drawn right after what was typed
    completion = rest;
    if (!rest) { ghost.replaceChildren(); return; }
    const cs = getComputedStyle(input), r = input.getBoundingClientRect(), f = form.getBoundingClientRect();
    Object.assign(ghost.style, { left: r.left - f.left + 'px', top: r.top - f.top + 'px', width: r.width + 'px', height: r.height + 'px',
      font: cs.font, padding: cs.padding, borderWidth: cs.borderWidth, letterSpacing: cs.letterSpacing });
    ghost.replaceChildren(el('span', { class: 'typed' }, input.value), el('span', { class: 'rest' }, rest),
      el('kbd', { class: 'tab-hint' }, 'tab'));
  };
  const highlight = (text, q) => {            // bold the typed words, like Gmail
    const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
    return i < 0 ? text : [text.slice(0, i), el('b', {}, text.slice(i, i + q.length)), text.slice(i + q.length)];
  };
  const row = (iconName, main, extra, run) => {
    const r = el('div', { class: 'suggest-item', role: 'option' }, [el('span', { class: 'suggest-icon' }, icon(iconName)), ...[].concat(main), extra]);
    r.addEventListener('mousedown', (e) => { e.preventDefault(); run(); });   // before the box loses focus
    r.run = run;
    rows.push(r);
    return r;
  };
  const draw = (parts) => {
    rows = []; active = -1;
    panel.replaceChildren(...parts());
    panel.hidden = false;
  };
  const chips = () => el('div', { class: 'suggest-chips' }, [...SEARCH_PLACES.map(([label, op, title]) => {
    const b = el('button', { type: 'button', class: 'chip', title }, label);
    b.addEventListener('mousedown', (e) => { e.preventDefault(); go(`${input.value.replace(SEARCH_PLACE, ' ').trim()} ${op}`.trim()); });
    return b;
  }), ...QUICK_FILTERS.map(([label, op]) => {
    const b = el('button', { type: 'button', class: 'chip' }, label);
    b.addEventListener('mousedown', (e) => { e.preventDefault(); go(`${input.value.trim()} ${op}`.trim()); });
    return b;
  })]);
  const recents = () => store.get('recentSearches', []);
  const emailRow = (t, q) => row('mail',
    el('span', { class: 'suggest-text' }, [el('span', { class: 'suggest-label' }, highlight(t.subject, q)),
      el('span', { class: 'suggest-sub' }, highlight(t.people, q))]),
    el('span', { class: 'suggest-meta' }, [t.attachments ? icon('clip') : null, dateLabel(t.date)]),
    () => { close(); openThread(t.id); });
  const matches = (t, q) => [t.subject, t.people, t.snippet].some((x) => (x || '').toLowerCase().includes(q));
  const localEmails = (q) => [...state.threads.values(), ...cache.values()].filter((t) => matches(t, q))
    .sort((a, b) => b.date - a.date).filter((t, i, a) => a.findIndex((x) => x.id === t.id) === i).slice(0, 5);

  const showEmpty = () => draw(() => [chips(), ...recents().slice(0, 6).map((r) =>
    row('clock', el('span', { class: 'suggest-label' }, r), null, () => go(r)))]);
  const showTyping = (q, emails) => {
    const lq = q.toLowerCase();
    const recentHits = recents().filter((r) => r.toLowerCase().startsWith(lq) && r.toLowerCase() !== lq).slice(0, 3);
    setGhost(recentHits[0] ? recentHits[0].slice(q.length) : '');
    draw(() => [chips(),
      ...recentHits.map((r) => row('clock', el('span', { class: 'suggest-label' }, [el('b', {}, r.slice(0, q.length)), r.slice(q.length)]), null, () => go(r))),
      ...(emails.length ? [el('div', { class: 'suggest-sep' })] : []), ...emails.map((t) => emailRow(t, q)),
      el('div', { class: 'suggest-sep' }),
      row('search', el('span', { class: 'suggest-label' }, `All search results for “${q}”`), el('span', { class: 'suggest-meta' }, 'Press ENTER'), () => go(q))]);
  };

  input.addEventListener('focus', () => { if (!input.value.trim()) showEmpty(); });
  input.addEventListener('input', () => {
    const q = input.value.trim();
    clearTimeout(timer);
    if (!q) { setGhost(''); showEmpty(); return; }
    const mine = ++seq;
    showTyping(q, localEmails(q.toLowerCase()));
    timer = setTimeout(async () => {                         // then ask Gmail, once typing pauses
      try {
        const r = await api(`/threads?q=${encodeURIComponent(q)}&maxResults=5${searchesSpamTrash(q) ? '&includeSpamTrash=true' : ''}`);
        if (mine !== seq) return;
        const found = [];
        await mapLimit(r.threads || [], 3, async (x) => {
          const t = state.threads.get(x.id) || cache.get(x.id) || summarize(await api(metadataPath(x.id)));
          cache.set(t.id, t); found.push(t);
        });
        if (mine !== seq || input.value.trim() !== q) return;
        const order = (r.threads || []).map((x) => x.id);
        found.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
        showTyping(q, [...found, ...localEmails(q.toLowerCase())].filter((t, i, a) => a.findIndex((x) => x.id === t.id) === i).slice(0, 5));
      } catch (e) { if (e instanceof AuthError) close(); }
    }, 300);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && completion) {                     // accept the grey completion
      e.preventDefault();
      input.value += completion;
      input.dispatchEvent(new Event('input'));
      return;
    }
    if (panel.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = rows.length;
      active = e.key === 'ArrowDown' ? (active + 1 >= n ? -1 : active + 1) : (active - 1 < -1 ? n - 1 : active - 1);
      rows.forEach((r, i) => r.classList.toggle('active', i === active));
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault(); rows[active].run();
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopImmediatePropagation(); close();
    }
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
  form.addEventListener('submit', close);
}

function wireUi() {
  setupSearchSuggest();
  $('#col-picker').addEventListener('click', (e) => { e.stopPropagation(); openColumnPicker(); });
  new ResizeObserver(() => document.body.style.setProperty('--bar-h', $('.bar').offsetHeight + 'px')).observe($('.bar'));   // phones: folders open below the bar
  document.addEventListener('mousemove', (e) => { state.pointer = { x: e.clientX, y: e.clientY }; }, { passive: true });
  $('#btn-signin').addEventListener('click', signIn);
  $('#banner-btn').addEventListener('click', signIn);
  $('#btn-refresh').addEventListener('click', loadBoard);
  $('#btn-compose').addEventListener('click', () => openCompose());
  $('#btn-report').addEventListener('click', openReport);
  $('#btn-menu').addEventListener('click', () => setSidebar(!state.sidebarOpen));
  $('#search-form').addEventListener('submit', (e) => { e.preventDefault(); runSearch($('#search').value); });
  $('#search').addEventListener('keydown', (e) => { if (e.key === 'Escape') clearSearch(); });
  // The browser's built-in ✕ in the search box empties it without submitting.
  $('#search').addEventListener('search', () => { if (!$('#search').value) clearSearch(); });
  $('#btn-settings').addEventListener('click', openSettings);
  $('#settings form').addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'save') return;
    const result = readSettingsForm();
    if (result.error) {
      e.preventDefault();
      $('#set-error').textContent = result.error;
      return;
    }
    settings.barColor = $('#set-barcolor').value.toLowerCase() === DEFAULT_BAR ? null : $('#set-barcolor').value;
    store.set('barColor', settings.barColor);
    applySettings(result);
  });
  // The color previews live; Cancel (or Esc) puts the saved one back.
  $('#set-barcolor').addEventListener('input', () => applyBarColor($('#set-barcolor').value));
  $('#set-barcolor-reset').addEventListener('click', () => { $('#set-barcolor').value = DEFAULT_BAR; applyBarColor(DEFAULT_BAR); });
  $('#settings').addEventListener('close', () => applyBarColor(settings.barColor));
  // Enter in a column name would otherwise trigger the form's first button (Cancel).
  $('#set-columns').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
  $('#set-add').addEventListener('click', () => {
    const row = columnRow('', null);
    $('#set-columns').append(row);
    row.querySelector('input').focus();
  });
  $('#set-signout').addEventListener('click', () => { $('#settings').close(); signOut(); });
  $('#set-rules').addEventListener('click', openGmailRules);
  $('#set-snooze-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(SNOOZE_SCRIPT); toast('Helper script copied — paste it into a new Apps Script project'); }
    catch { toast('Could not copy'); }
  });
  $('#btn-setup-save').addEventListener('click', () => {
    const id = $('#setup-client').value.trim();
    if (!id) return;
    store.set('clientId', id);
    location.reload();
  });
  document.addEventListener('keydown', onKey);
  $('#btn-undo').addEventListener('click', undoLast);
  $('#btn-downloads').addEventListener('click', (e) => { e.stopPropagation(); openDownloads(e.currentTarget); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - state.lastLoad > 60000) loadBoard();
    else watchMailbox();
  });
  addEventListener('focus', watchMailbox);
  for (const type of ['keydown', 'pointerdown', 'pointermove', 'wheel']) {
    addEventListener(type, () => { state.lastInput = Date.now(); }, { capture: true, passive: true });
  }
  setInterval(() => { if (document.visibilityState === 'visible') loadBoard(); }, REFRESH_MS);
  setInterval(watchMailbox, WATCH_MS);
}

async function start() {
  // Who actually signed in? A different account than the settings just loaded: load theirs instead, before
  // anything can touch their Gmail. (The sign-in is kept for this tab, so the reload doesn't ask again.)
  let email;
  try {
    email = (await api('/profile')).emailAddress;
  } catch (e) {
    if (!(e instanceof AuthError)) toast(e.message);
    return;
  }
  if (email !== state.me) {
    store.set('email', email);
    if (store.get('email', '') === email) { location.reload(); return; }
    state.me = email;           // this browser isn't saving anything: carry on with an empty board
    settings.columns = [];
    settings.columnLabels = {};
    settings.columnsSaved = false;
  }
  document.title = `StediMail - ${email}`;   // installed windows show this in their title bar
  applyColumnWidth(settings.colWidth);
  applyReaderWidth(settings.readerWidth);
  markDownloads(store.get('downloadsUnseen', false));
  setupReaderResize();
  setupCopyFloat();
  show('board');
  await loadBoard();
}

// ---------- auto-update ----------

// deploy.sh stamps index.html with ?v=<version>. Poll for a newer stamp and
// reload when it won't disrupt anything; otherwise offer a Reload button.
const VERSION = /[?&]v=(\d+)/.exec(document.querySelector('script[src*="app.js"]')?.src || '')?.[1];
let updateReady = false;

function canReloadQuietly() {
  if (state.dragging || state.addingColumn || state.typingCardLabel || state.selected.size || state.search) return false;
  if (!$('#reader').hidden || $('#menu') || $('#color-pop') || $('#status').textContent) return false;
  return ![...document.querySelectorAll('input, textarea')].some((f) =>
    (f.type !== 'checkbox' && f.value && f === document.activeElement) || (f.tagName === 'TEXTAREA' && f.value.trim()));
}

async function checkForUpdate() {
  if (!VERSION) return;
  try {
    // cache: 'reload' also refreshes the browser's cached page, so reload() gets the new one.
    const html = await (await fetch('./', { cache: 'reload' })).text();
    const live = /app\.js\?v=(\d+)/.exec(html)?.[1];
    if (!live || live <= VERSION) return;
    if (canReloadQuietly()) { location.reload(); return; }
    if (!updateReady) {
      updateReady = true;
      showUpdateButton();
      setInterval(showUpdateButton, 2000);
    }
  } catch {} // offline or Pages hiccup: try again next time
}

// Stays in the top bar until used, rather than a message that goes away (Paul, 2026-11-05). It waits while
// an email is being written, so a click can't throw away what's in the box.
function isWritingEmail() {
  const reader = $('#reader');
  return [...reader.querySelectorAll('.reply-editor')].some((e) => e.innerText.trim())
    || [...reader.querySelectorAll('.compose input')].some((f) => f.value.trim())
    || !!reader.querySelector('.reply-files .chip');
}

function showUpdateButton() {
  $('#btn-update').hidden = !updateReady || isWritingEmail();
}

function watchForUpdates() {
  // The service worker is what lets the browser offer "Install StediMail".
  navigator.serviceWorker?.register('sw.js').catch(() => {});
  setupInstallButton();
  $('#btn-update').addEventListener('click', () => location.reload());
  if (!VERSION) return;
  setInterval(checkForUpdate, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdate(); });
  addEventListener('focus', checkForUpdate);
}

async function boot() {
  wireUi();
  watchForUpdates();
  if (!settings.clientId) { show('setup'); return; }
  try { await waitForGis(); } catch (e) { toast(e.message); return; }
  applyBarColor(settings.barColor);
  initAuth();
  if (restoreToken()) start(); else show('signin');
}

boot();
