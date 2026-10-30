'use strict';

// Mailboard: Gmail as Kanban columns. Runs entirely in the browser; each
// column (other than Inbox) is a Gmail label named "Board/<column>".

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const LABEL_PREFIX = 'Board/';
const COLOR_PREFIX = 'Board/Color/';
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

const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
};

const settings = {
  clientId: store.get('clientId', ''),
  inboxName: store.get('inboxName', 'Inbox'),
  columns: store.get('columns', ['To Do', 'Waiting', 'Done']),
  lastArchives: store.get('lastArchives', true),
};

function columns() {
  const cols = [{ name: settings.inboxName, inbox: true }];
  settings.columns.forEach((name, i) =>
    cols.push({ name, archive: settings.lastArchives && i === settings.columns.length - 1 }));
  return cols;
}

const state = {
  token: null,
  tokenExp: 0,
  me: store.get('email', ''),
  labelIds: {},        // column name -> Gmail label id
  colorIds: {},        // color name -> Gmail label id (created on first use)
  threads: new Map(),  // thread id -> summary
  board: [],           // per column: sorted thread ids
  more: [],            // per column: Gmail has more than we fetched
  search: null,        // { q, ids, more } while search results are shown
  openId: null,
  dragging: false,
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
      if (resp.error) { toast('Sign-in failed: ' + resp.error); return; }
      setToken(resp.access_token, resp.expires_in);
      $('#banner').hidden = true;
      start();
    },
    error_callback: (err) =>
      toast(err.type === 'popup_closed' ? 'Sign-in window was closed.' : 'Sign-in failed: ' + err.type),
  });
}

function setToken(token, expiresIn) {
  state.token = token;
  state.tokenExp = Date.now() + (Number(expiresIn) - 60) * 1000;
  try { sessionStorage.setItem('token', JSON.stringify({ token, exp: state.tokenExp })); } catch {}
}

function restoreToken() {
  try {
    const saved = JSON.parse(sessionStorage.getItem('token'));
    if (saved && saved.exp > Date.now()) {
      state.token = saved.token;
      state.tokenExp = saved.exp;
      return true;
    }
  } catch {}
  return false;
}

function signIn() {
  tokenClient.requestAccessToken(state.me ? { login_hint: state.me } : {});
}

function needSignIn() {
  state.token = null;
  try { sessionStorage.removeItem('token'); } catch {}
  if ($('#board').hidden) show('signin');
  else $('#banner').hidden = false;
}

function signOut() {
  if (state.token) google.accounts.oauth2.revoke(state.token, () => {});
  state.token = null;
  state.threads.clear();
  try { sessionStorage.removeItem('token'); } catch {}
  closeReader();
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

async function ensureLabels(cols) {
  const { labels = [] } = await api('/labels');
  const byName = Object.fromEntries(labels.map((l) => [l.name, l.id]));
  for (const c of COLORS) if (byName[COLOR_PREFIX + c.name]) state.colorIds[c.name] = byName[COLOR_PREFIX + c.name];
  for (const col of cols) {
    if (col.inbox) continue;
    const name = LABEL_PREFIX + col.name;
    if (!byName[name]) {
      const made = await api('/labels', {
        method: 'POST',
        body: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
      });
      byName[name] = made.id;
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
  const people = [];
  for (const m of msgs) {
    const from = header(m, 'from');
    const name = addrOf(from) === state.me.toLowerCase() ? 'me' : displayName(from);
    if (!people.includes(name)) people.push(name);
  }
  return {
    id: t.id,
    historyId: t.historyId,
    subject: header(msgs[0] || {}, 'subject') || '(no subject)',
    people: people.join(', '),
    snippet: decodeEntities(last.snippet || ''),
    date: Number(last.internalDate || 0),
    count: msgs.length,
    replied: (last.labelIds || []).includes('SENT'),
    attachments: msgs.filter((m) => /multipart\/mixed/i.test(header(m, 'content-type'))).length,
    unread: labels.has('UNREAD'),
    labels,
  };
}

// Which column a thread belongs in, or -1 if none.
function columnOf(t, cols) {
  for (let i = 1; i < cols.length; i++) {
    if (!t.labels.has(state.labelIds[cols[i].name])) continue;
    // A new reply to an archived ("Done") thread lands back in the Inbox.
    if (cols[i].archive && t.labels.has('INBOX')) return 0;
    return i;
  }
  return t.labels.has('INBOX') ? 0 : -1;
}

function assign(cols) {
  state.board = cols.map(() => []);
  for (const t of state.threads.values()) {
    const c = columnOf(t, cols);
    if (c >= 0) state.board[c].push(t.id);
  }
  for (const list of state.board) list.sort((a, b) => state.threads.get(b).date - state.threads.get(a).date);
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

async function runSearch(q) {
  q = q.trim();
  if (!q) { clearSearch(); return; }
  setStatus('Searching…');
  try {
    const r = await api('/threads?' + new URLSearchParams({ q, maxResults: '50' }));
    const listed = r.threads || [];
    const ok = await fetchSummaries(listed);
    state.search = { q, ids: listed.map((t) => t.id).filter((id) => ok.has(id)), more: !!r.nextPageToken };
    assign(columns());
    render();
    $('#board').scrollLeft = 0;
    setStatus('');
  } catch (e) {
    if (!(e instanceof AuthError)) toast('Search failed: ' + e.message);
    setStatus('');
  }
}

function clearSearch() {
  state.search = null;
  $('#search').value = '';
  render();
}

async function loadBoard() {
  if (state.loading || state.dragging || !state.token) return;
  state.loading = true;
  setStatus('Loading…');
  try {
    const cols = columns();
    await ensureLabels(cols);
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
    const seen = await fetchSummaries([...listed.values()]);
    for (const id of state.search?.ids || []) seen.add(id);
    for (const id of [...state.threads.keys()]) if (!seen.has(id)) state.threads.delete(id);
    assign(cols);
    render();
    state.lastLoad = Date.now();
    setStatus('Updated ' + dateLabel(Date.now()));
  } catch (e) {
    if (!(e instanceof AuthError)) toast('Could not load mail: ' + e.message);
    setStatus('');
  } finally {
    state.loading = false;
  }
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

  const before = new Set(t.labels);
  add.forEach((l) => t.labels.add(l));
  remove.forEach((l) => t.labels.delete(l));
  assign(cols);
  render();
  refreshReaderActions(id);
  try {
    await api(`/threads/${id}/modify`, { method: 'POST', body: { addLabelIds: add, removeLabelIds: remove } });
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
  if (prev === colIdx) return;
  if (await moveThread(id, colIdx)) {
    toast(`Moved to ${cols[colIdx].name}`, prev < 0 ? null : { label: 'Undo', run: () => moveThread(id, prev) });
  }
}

// Archive = drop into the archiving column (Done) when there is one,
// otherwise take the thread out of the Inbox and off the board.
async function archiveThread(id) {
  const cols = columns();
  const doneIdx = cols.findIndex((c) => c.archive);
  if (doneIdx >= 0) return moveWithUndo(id, doneIdx);
  const t = state.threads.get(id);
  if (!t) return;
  const remove = ['INBOX', ...cols.slice(1).map((c) => state.labelIds[c.name])].filter((l) => t.labels.has(l));
  const apply = async (add, rem) => {
    add.forEach((l) => t.labels.add(l));
    rem.forEach((l) => t.labels.delete(l));
    assign(cols);
    render();
    await api(`/threads/${id}/modify`, { method: 'POST', body: { addLabelIds: add, removeLabelIds: rem } });
  };
  try {
    await apply([], remove);
    toast('Archived', { label: 'Undo', run: () => apply(remove, []).catch((e) => toast(e.message)) });
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
  try {
    await api(`/threads/${id}/modify`, {
      method: 'POST',
      body: unread ? { addLabelIds: ['UNREAD'] } : { removeLabelIds: ['UNREAD'] },
    });
  } catch (e) {
    t.unread = !unread;
    if (unread) t.labels.delete('UNREAD'); else t.labels.add('UNREAD');
    render();
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

function openColorPicker(anchor, id) {
  closeColorPicker();
  const t = state.threads.get(id);
  const current = t && colorOf(t);
  const swatch = (label, color, extra) => {
    const b = el('button', {
      class: 'swatch' + (extra || '') + (color && color === current ? ' current' : ''),
      title: label, 'aria-label': label, style: color ? `--swatch:${color.bg}` : null,
    }, color ? null : '✕');
    b.addEventListener('click', (e) => { e.stopPropagation(); closeColorPicker(); setColor(id, color); });
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

async function trashThread(id) {
  const t = state.threads.get(id);
  try {
    await api(`/threads/${id}/trash`, { method: 'POST' });
    state.threads.delete(id);
    assign(columns());
    render();
    if (state.openId === id) closeReader();
    toast('Moved to Trash', {
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

async function sendMail(headers, body, threadId) {
  const lines = [];
  for (const [k, v] of Object.entries(headers)) if (v) lines.push(`${k}: ${k === 'Subject' ? encodeWord(v) : v}`);
  const encoded = bytesToB64(utf8(body.replace(/\r?\n/g, '\r\n'))).replace(/.{76}/g, '$&\r\n');
  lines.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', encoded);
  const raw = b64url(utf8(lines.join('\r\n')));
  return api('/messages/send', { method: 'POST', body: threadId ? { raw, threadId } : { raw } });
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
  archive: 'M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z',
  trash: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
  unread: 'M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z',
  read: 'M21.99 8c0-.72-.37-1.35-.94-1.7L12 1 2.95 6.3C2.38 6.65 2 7.28 2 8v10c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2l-.01-10zM12 13L3.74 7.84 12 3l8.26 4.84L12 13z',
  replied: 'M18 7l-1.41-1.41-6.34 6.34 1.41 1.41L18 7zm4.24-1.41L11.66 16.17 7.48 12l-1.41 1.41L11.66 19l12-12-1.42-1.41zM.41 13.41L6 19l1.41-1.41L1.83 12 .41 13.41z',
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

function iconButton(label, name, run) {
  const b = el('button', { class: 'icon-btn', title: label, 'aria-label': label, draggable: 'false' }, icon(name));
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
function toast(msg, action) {
  const box = $('#toast');
  box.replaceChildren(el('span', {}, msg));
  if (action) {
    const b = el('button', {}, action.label);
    b.addEventListener('click', () => { box.hidden = true; action.run(); });
    box.append(b);
  }
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, action ? 8000 : 5000);
}

function show(view) {
  for (const id of ['board', 'signin', 'setup']) $('#' + id).hidden = id !== view;
  $('#btn-compose').hidden = $('#btn-refresh').hidden = $('#search-form').hidden = view !== 'board';
}

function render() {
  const cols = columns();
  const board = $('#board');
  const focusedId = document.activeElement?.closest?.('.card')?.dataset.id;
  const scrolls = [...board.querySelectorAll('.cards')].map((c) => c.scrollTop);
  board.replaceChildren(
    ...(state.search ? [renderSearchColumn()] : []),
    ...cols.map((col, i) => renderColumn(col, i)),
  );
  board.querySelectorAll('.cards').forEach((c, i) => { c.scrollTop = scrolls[i] || 0; });
  if (focusedId) board.querySelector(`.card[data-id="${focusedId}"]`)?.focus({ preventScroll: true });
}

function renderSearchColumn() {
  const { q, ids, more } = state.search;
  const close = el('button', { class: 'icon-btn', title: 'Close search', 'aria-label': 'Close search' }, '✕');
  close.addEventListener('click', clearSearch);
  return el('section', { class: 'column search', 'data-col': '-1' }, [
    el('h2', {}, [el('span', { class: 'q' }, `“${q}”`), el('span', { class: 'count' }, ids.length + (more ? '+' : '')), close]),
    el('div', { class: 'cards' }, ids.length
      ? ids.map((id) => renderCard(state.threads.get(id), -1))
      : el('p', { class: 'hint' }, 'No matches.')),
  ]);
}

function renderColumn(col, i) {
  const ids = state.board[i] || [];
  const node = el('section', { class: 'column', 'data-col': i }, [
    el('h2', {}, [el('span', { class: 'key', title: `Press ${i + 1} to move the selected card here` }, String(i + 1)),
      col.name, el('span', { class: 'count' }, ids.length + (state.more[i] ? '+' : ''))]),
    el('div', { class: 'cards' }, ids.map((id) => renderCard(state.threads.get(id), i))),
  ]);
  node.addEventListener('dragover', (e) => { e.preventDefault(); node.classList.add('drop'); });
  node.addEventListener('dragleave', (e) => { if (!node.contains(e.relatedTarget)) node.classList.remove('drop'); });
  node.addEventListener('drop', (e) => {
    e.preventDefault();
    node.classList.remove('drop');
    state.dragging = false;
    const id = e.dataTransfer.getData('text/plain');
    if (id) moveWithUndo(id, i);
  });
  return node;
}

function renderCard(t, colIdx) {
  const color = colorOf(t);
  let where = null;
  if (colIdx < 0) { // search result: show which column it lives in
    const cols = columns();
    const c = columnOf(t, cols);
    where = el('span', { class: 'where' }, c >= 0 ? cols[c].name : 'Archived');
  }
  const card = el('article', {
    class: 'card' + (t.unread ? ' unread' : '') + (t.id === state.openId ? ' open' : '') + (color ? ' colored' : ''),
    style: color ? `--card-color:${color.bg}` : null,
    tabindex: '0', draggable: 'true', 'data-id': t.id, 'data-col': colIdx,
  }, [
    el('div', { class: 'top' }, [
      el('span', { class: 'people' }, t.people),
      t.count > 1 ? el('span', { class: 'num' }, String(t.count)) : null,
      where,
      el('time', {}, dateLabel(t.date)),
    ]),
    el('div', { class: 'body' }, [
      t.replied ? icon('replied', 'replied') : null,
      el('span', { class: 'subj' }, t.subject),
      t.snippet ? ' - ' + t.snippet : '',
    ]),
    t.attachments ? el('div', { class: 'clip' }, [icon('clip'), String(t.attachments)]) : null,
    el('div', { class: 'card-actions' }, [
      iconButton('Color', 'palette', (b) => openColorPicker(b, t.id)),
      iconButton('Archive', 'archive', () => archiveThread(t.id)),
      iconButton('Delete', 'trash', () => trashThread(t.id)),
      t.unread
        ? iconButton('Mark as read', 'read', () => toggleRead(t.id))
        : iconButton('Mark as unread', 'unread', () => toggleRead(t.id)),
    ]),
  ]);
  card.addEventListener('dragstart', (e) => {
    state.dragging = true;
    e.dataTransfer.setData('text/plain', t.id);
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => { state.dragging = false; card.classList.remove('dragging'); });
  card.addEventListener('click', () => openThread(t.id));
  return card;
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
  'html,body{margin:0;background:#fff;color:#111;font:15px/1.5 system-ui,sans-serif;overflow-wrap:anywhere}' +
  'img{max-width:100%;height:auto}table{max-width:100%}</style>';

function bodyFrame(m) {
  const html = findPart(m.payload, 'text/html');
  const text = html ? null : findPart(m.payload, 'text/plain');
  const content = html ? decodePart(html)
    : text ? `<div style="white-space:pre-wrap">${escapeHtml(decodePart(text))}</div>`
    : '<p><i>(no text content)</i></p>';
  // No allow-scripts: email content can never run code. allow-same-origin
  // lets us measure the content to size the frame.
  const frame = el('iframe', {
    class: 'body', title: 'Message',
    sandbox: 'allow-same-origin allow-popups allow-popups-to-escape-sandbox',
  });
  frame.srcdoc = FRAME_HEAD + content;
  frame.addEventListener('load', () => {
    const doc = frame.contentDocument;
    if (!doc) return;
    const fit = () => { frame.style.height = doc.documentElement.scrollHeight + 'px'; };
    fit();
    new ResizeObserver(fit).observe(doc.body);
  });
  return frame;
}

async function downloadAttachment(msgId, part) {
  try {
    const r = await api(`/messages/${msgId}/attachments/${part.body.attachmentId}`);
    const url = URL.createObjectURL(new Blob([b64urlBytes(r.data)], { type: part.mimeType }));
    const a = el('a', { href: url, download: part.filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (e) {
    if (!(e instanceof AuthError)) toast('Download failed: ' + e.message);
  }
}

function renderMessage(m, expanded) {
  const from = header(m, 'from');
  const to = header(m, 'to');
  const cc = header(m, 'cc');
  const details = el('details', { class: 'message' }, [
    el('summary', {}, [
      el('strong', {}, displayName(from)),
      el('time', {}, dateLabel(Number(m.internalDate), true)),
      el('div', { class: 'snippet' }, decodeEntities(m.snippet || '')),
    ]),
  ]);
  let loaded = false;
  const load = () => {
    if (loaded) return;
    loaded = true;
    details.append(el('div', { class: 'addr' }, `From ${from}` + (to ? ` · To ${to}` : '') + (cc ? ` · Cc ${cc}` : '')));
    details.append(bodyFrame(m));
    const files = attachmentsOf(m.payload);
    if (files.length) {
      details.append(el('div', { class: 'files' }, files.map((p) => {
        const b = el('button', {}, '📎 ' + p.filename);
        b.addEventListener('click', () => downloadAttachment(m.id, p));
        return b;
      })));
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
  const del = el('button', {}, 'Delete');
  del.addEventListener('click', () => trashThread(id));
  const color = t && colorOf(t);
  const colorBtn = el('button', { class: 'color-btn', style: color ? `--swatch:${color.bg}` : null },
    [icon('palette'), color ? color.name : 'Color']);
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
    colorBtn,
    del,
    gmail,
  );
}

function renderReplyBox(last, threadId) {
  const ta = el('textarea', { rows: '6', placeholder: 'Write a reply…' });
  const all = el('input', { type: 'checkbox' });
  const send = el('button', { class: 'primary' }, 'Send reply');
  send.addEventListener('click', async () => {
    if (!ta.value.trim()) { ta.focus(); return; }
    send.disabled = true;
    send.textContent = 'Sending…';
    try {
      await sendMail(replyHeaders(last, all.checked), ta.value, threadId);
      toast('Reply sent');
      openThread(threadId);
      loadBoard();
    } catch (e) {
      if (!(e instanceof AuthError)) toast('Send failed: ' + e.message);
      send.disabled = false;
      send.textContent = 'Send reply';
    }
  });
  return el('div', { class: 'reply' }, [ta, el('div', { class: 'row' }, [el('label', { class: 'check' }, [all, 'Reply all']), send])]);
}

function readerHead(title) {
  const close = el('button', { 'aria-label': 'Close' }, '✕');
  close.addEventListener('click', closeReader);
  return el('div', { class: 'reader-head' }, [el('h2', {}, title), close]);
}

async function openThread(id) {
  state.openId = id;
  document.querySelectorAll('.card.open').forEach((c) => c.classList.remove('open'));
  document.querySelector(`.card[data-id="${id}"]`)?.classList.add('open');
  const reader = $('#reader');
  reader.hidden = false;
  reader.replaceChildren(el('p', { class: 'hint' }, 'Loading…'));
  try {
    const thread = await api(`/threads/${id}?format=full`);
    if (state.openId !== id) return;
    const msgs = thread.messages || [];
    const actions = el('div', { class: 'actions', id: 'reader-actions' });
    renderActions(actions, id);
    reader.replaceChildren(
      readerHead(header(msgs[0] || {}, 'subject') || '(no subject)'),
      actions,
      el('div', { class: 'messages' }, msgs.map((m, i) =>
        renderMessage(m, i === msgs.length - 1 || (m.labelIds || []).includes('UNREAD')))),
      renderReplyBox(msgs[msgs.length - 1], id),
    );
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

function openCompose() {
  state.openId = null;
  document.querySelectorAll('.card.open').forEach((c) => c.classList.remove('open'));
  const to = el('input', { placeholder: 'To', autocomplete: 'email' });
  const subject = el('input', { placeholder: 'Subject' });
  const body = el('textarea', { rows: '12', placeholder: 'Message' });
  const send = el('button', { class: 'primary' }, 'Send');
  send.addEventListener('click', async () => {
    if (!to.value.trim()) { to.focus(); return; }
    send.disabled = true;
    send.textContent = 'Sending…';
    try {
      await sendMail({ To: to.value.trim(), Subject: subject.value }, body.value);
      toast('Sent');
      closeReader();
    } catch (e) {
      if (!(e instanceof AuthError)) toast('Send failed: ' + e.message);
      send.disabled = false;
      send.textContent = 'Send';
    }
  });
  const reader = $('#reader');
  reader.replaceChildren(readerHead('New message'), el('div', { class: 'compose' }, [to, subject, body, el('div', { class: 'row' }, [send])]));
  reader.hidden = false;
  to.focus();
}

function closeReader() {
  const id = state.openId;
  state.openId = null;
  $('#reader').hidden = true;
  $('#reader').replaceChildren();
  document.querySelectorAll('.card.open').forEach((c) => c.classList.remove('open'));
  if (id) document.querySelector(`.card[data-id="${id}"]`)?.focus();
}

// ---------- settings & wiring ----------

function openSettings() {
  $('#set-columns').value = [settings.inboxName, ...settings.columns].join('\n');
  $('#set-archive').checked = settings.lastArchives;
  $('#set-client').value = settings.clientId;
  $('#settings').showModal();
}

function saveSettings() {
  const names = [...new Set($('#set-columns').value.split('\n')
    .map((s) => s.replace(/\//g, '-').trim())
    .filter(Boolean))].slice(0, 9);
  if (names.length < 2) { toast('Keep at least two columns.'); return; }
  [settings.inboxName, ...settings.columns] = names;
  settings.lastArchives = $('#set-archive').checked;
  store.set('inboxName', settings.inboxName);
  store.set('columns', settings.columns);
  store.set('lastArchives', settings.lastArchives);
  const clientId = $('#set-client').value.trim();
  if (clientId && clientId !== settings.clientId) {
    store.set('clientId', clientId);
    location.reload();
    return;
  }
  assign(columns());
  render();
  loadBoard();
}

function onKey(e) {
  if (e.target.closest?.('input, textarea, dialog')) return;
  if (e.key === 'Escape' && $('#color-pop')) { closeColorPicker(); return; }
  if (e.key === 'Escape' && !$('#reader').hidden) { closeReader(); return; }
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
  } else if (e.key === 'c') {
    e.preventDefault();
    openColorPicker(card, id);
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    (e.key === 'ArrowDown' ? card.nextElementSibling : card.previousElementSibling)?.focus();
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    const target = document.querySelector(`.column[data-col="${col + (e.key === 'ArrowRight' ? 1 : -1)}"] .cards`);
    if (target?.children.length) {
      const idx = [...card.parentNode.children].indexOf(card);
      target.children[Math.min(idx, target.children.length - 1)].focus();
    }
  }
}

function wireUi() {
  $('#btn-signin').addEventListener('click', signIn);
  $('#banner-btn').addEventListener('click', signIn);
  $('#btn-refresh').addEventListener('click', loadBoard);
  $('#btn-compose').addEventListener('click', openCompose);
  $('#search-form').addEventListener('submit', (e) => { e.preventDefault(); runSearch($('#search').value); });
  $('#search').addEventListener('keydown', (e) => { if (e.key === 'Escape') clearSearch(); });
  // The browser's built-in ✕ in the search box empties it without submitting.
  $('#search').addEventListener('search', () => { if (!$('#search').value) clearSearch(); });
  $('#btn-settings').addEventListener('click', openSettings);
  $('#settings').addEventListener('close', () => { if ($('#settings').returnValue === 'save') saveSettings(); });
  $('#set-signout').addEventListener('click', () => { $('#settings').close(); signOut(); });
  $('#btn-setup-save').addEventListener('click', () => {
    const id = $('#setup-client').value.trim();
    if (!id) return;
    store.set('clientId', id);
    location.reload();
  });
  document.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - state.lastLoad > 60000) loadBoard();
  });
  setInterval(() => { if (document.visibilityState === 'visible') loadBoard(); }, REFRESH_MS);
}

async function start() {
  show('board');
  if (!state.me) {
    try {
      state.me = (await api('/profile')).emailAddress;
      store.set('email', state.me);
    } catch (e) {
      if (!(e instanceof AuthError)) toast(e.message);
      return;
    }
  }
  await loadBoard();
}

async function boot() {
  wireUi();
  if (!settings.clientId) { show('setup'); return; }
  try { await waitForGis(); } catch (e) { toast(e.message); return; }
  initAuth();
  if (restoreToken()) start(); else show('signin');
}

boot();
