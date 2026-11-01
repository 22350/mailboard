'use strict';

// Mailboard: Gmail as Kanban columns. Runs entirely in the browser; each
// column (other than Inbox) is a Gmail label named "Board/<column>".

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
// Full access: gmail.modify can move mail to Trash but not delete it forever.
const SCOPE = 'https://mail.google.com/';
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
  colWidth: store.get('colWidth', null),   // px shared by all columns; null = automatic
  readerWidth: store.get('readerWidth', null),   // px for the opened-email panel; null = normal (760)
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
  tokenClient.requestAccessToken(state.me ? { login_hint: state.me } : {});
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
  state.userLabels = labels
    .filter((l) => l.type === 'user' && !l.name.startsWith(LABEL_PREFIX))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
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

const byText = (f) => (a, b) => f(a).localeCompare(f(b), undefined, { sensitivity: 'base' }) || b.date - a.date;
const SORTS = [
  { key: 'newest', label: 'Newest first', cmp: (a, b) => b.date - a.date },
  { key: 'oldest', label: 'Oldest first', cmp: (a, b) => a.date - b.date },
  { key: 'unread', label: 'Unread first', cmp: (a, b) => b.unread - a.unread || b.date - a.date },
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
async function runSearch(q, folder) {
  q = (q || '').trim();
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
    if (folder?.spamTrash) p.set('includeSpamTrash', 'true');
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
    return { q: folder?.q || q || '', labelIds: folder?.label, spamTrash: folder?.spamTrash, name: state.search.title || `“${q}”` };
  }
  const cols = columns();
  const col = cols[key];
  if (col.inbox) {
    const others = cols.slice(1).map((c) => `-label:${searchLabel(LABEL_PREFIX + c.name)}`).join(' ');
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
      remove: [...boardLabels.filter((l) => l !== tl), ...(target.archive ? ['INBOX'] : []),
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
  try {
    const change = await bulkChange(action, arg);
    let count;
    let undo;
    if (all) {
      const t = all.total;
      const howMany = t ? `${t.exact ? '' : 'about '}${t.n.toLocaleString()}` : 'all';
      if (!confirm(`${change.verb}: ${howMany} conversations in ${all.scope.name}. Continue?`)) return;
      const ids = await listAllMessageIds(all.scope);
      await batchModify(ids, change.add, change.remove);
      count = t ? t.n : ids.length;
      undo = () => batchModify(ids, change.remove, change.add);
    } else {
      const ids = [...state.selected];
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
  } catch (e) {
    setStatus('');
    if (!(e instanceof AuthError)) toast('Could not update: ' + e.message);
  }
}

async function bulkDeleteForever(all) {
  if (!all) {
    if (await deleteForever([...state.selected])) clearSelection();
    return;
  }
  const t = all.total;
  const howMany = t ? `${t.exact ? '' : 'about '}${t.n.toLocaleString()}` : 'all';
  if (!confirm(`Delete ${howMany} conversations in ${all.scope.name} forever? This can't be undone.`)) return;
  try {
    const ids = await listAllMessageIds(all.scope);
    for (let i = 0; i < ids.length; i += 1000) {
      setStatus(`Deleting… ${Math.min(i + 1000, ids.length).toLocaleString()} of ${ids.length.toLocaleString()}`);
      await api('/messages/batchDelete', { method: 'POST', body: { ids: ids.slice(i, i + 1000) } });
    }
    clearSelection();
    setStatus('');
    await refreshAfterBulk();
    toast(`Deleted forever: ${ids.length.toLocaleString()} messages`);
  } catch (e) {
    setStatus('');
    if (!(e instanceof AuthError)) toast('Could not delete: ' + e.message);
  }
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
  { name: 'Snoozed', icon: 'clock', q: 'in:snoozed' },
  { name: 'Sent', icon: 'send', label: 'SENT' },
  { name: 'Drafts', icon: 'draft', label: 'DRAFT', count: 'total' },
  { name: 'All Mail', icon: 'allmail' },
  { name: 'Spam', icon: 'spam', label: 'SPAM', count: 'unread', spamTrash: true },
  { name: 'Trash', icon: 'trash', label: 'TRASH', spamTrash: true },
  { name: 'Purchases', icon: 'bag', q: 'category:purchases' },
  { name: 'Promotions', icon: 'offer', label: 'CATEGORY_PROMOTIONS', count: 'unread' },
  { name: 'Starred', icon: 'star', label: 'STARRED' },
  { name: 'Important', icon: 'important', label: 'IMPORTANT' },
  { name: 'Scheduled', icon: 'clock', q: 'in:scheduled' },
];

async function loadCounts() {
  const ids = [
    ...FOLDERS.filter((f) => f.count).map((f) => f.label),
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
    const offBoard = () => ['INBOX', ...columns().slice(1).map((c) => state.labelIds[c.name])];
    return pick(
      (id) => {
        const t = state.threads.get(id);
        const remove = move && t ? offBoard().filter((l) => t.labels.has(l)) : [];
        return labelThread(id, [labelId], remove, verb);
      },
      ['labels', { add: [labelId], remove: move ? offBoard() : [], verb }],
    );
  };
  if (target.userLabel) return addLabel(target.userLabel.id, `Moved to ${target.userLabel.name}`, true);
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
    const c = f.label && counts[f.label];
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
    { label: 'Edit', run: () => renameUserLabel(l) },
    { label: 'Remove label', run: () => removeUserLabel(l) },
    { label: 'Add sublabel', run: () => createLabel(l.name + '/') },
  ]);
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

async function removeUserLabel(l) {
  if (!confirm(`Remove the label “${l.name}”?\n\nThe emails stay in Gmail; they just lose this label.`)) return;
  try {
    await api(`/labels/${l.id}`, { method: 'DELETE' });
    state.userLabels = state.userLabels.filter((x) => x.id !== l.id);
    if (state.folder === l.name) clearSearch();
    renderSidebar();
    toast(`Removed label “${l.name}”`);
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

async function loadBoard() {
  if (state.loading || state.dragging || state.addingColumn || !state.token) return;
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
    await loadCounts();
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
  // Dragging out of the Spam or Trash folder rescues the thread.
  for (const l of ['SPAM', 'TRASH']) if (t.labels.has(l)) remove.push(l);

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

// Archive = take the thread out of the Inbox and off the board (no column label), like Gmail's
// Archive. Dragging it to an archiving last column is the way to archive it into that column.
async function archiveThread(id) {
  const cols = columns();
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

async function trashThread(id) {
  const t = state.threads.get(id);
  if (t?.labels.has('TRASH')) return deleteForever([id]);
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

// Permanently delete threads that are already in Trash. No undo.
async function deleteForever(threadIds) {
  const n = threadIds.length;
  if (!confirm(`Delete ${n === 1 ? 'this conversation' : n.toLocaleString() + ' conversations'} forever? This can't be undone.`)) return false;
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
  sort: 'M3 18h6v-2H3v2zM3 6v2h18V6H3zm0 7h12v-2H3v2z',
  widen: 'M4 12l4-4v3h8V8l4 4-4 4v-3H8v3z',
  narrow: 'M10 12L6 8v3H2v2h4v3zm4 0l4-4v3h4v2h-4v3z',
  archive: 'M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z',
  trash: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
  unread: 'M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z',
  read: 'M21.99 8c0-.72-.37-1.35-.94-1.7L12 1 2.95 6.3C2.38 6.65 2 7.28 2 8v10c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2l-.01-10zM12 13L3.74 7.84 12 3l8.26 4.84L12 13z',
  replied: 'M18 7l-1.41-1.41-6.34 6.34 1.41 1.41L18 7zm4.24-1.41L11.66 16.17 7.48 12l-1.41 1.41L11.66 19l12-12-1.42-1.41zM.41 13.41L6 19l1.41-1.41L1.83 12 .41 13.41z',
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
  $('#main-row').hidden = view !== 'board';
  $('#signin').hidden = view !== 'signin';
  $('#setup').hidden = view !== 'setup';
  for (const id of ['btn-compose', 'btn-refresh', 'search-form', 'btn-menu']) $('#' + id).hidden = view !== 'board';
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
}

function saveColumnList(list) {
  settings.columns = list;
  store.set('columns', list);
  assign(columns());
  render();
  loadBoard();
}

function removeColumn(i) {
  if (settings.columns.length <= 1) { toast('Keep at least one column besides your inbox.'); return; }
  const before = [...settings.columns];
  const name = before[i - 1];
  saveColumnList(before.filter((_, k) => k !== i - 1));
  toast(`Removed “${name}”. Its emails keep the label in Gmail.`, { label: 'Undo', run: () => saveColumnList(before) });
}

function addColumn(name) {
  const existing = [settings.inboxName, ...settings.columns].map((n) => n.toLowerCase());
  if (existing.includes(name.toLowerCase())) { toast('There is already a column with that name.'); return; }
  if (existing.length >= 9) { toast('Nine columns at most.'); return; }
  const list = [...settings.columns];
  // Keep the archiving column last, if there is one.
  if (settings.lastArchives) list.splice(list.length - 1, 0, name); else list.push(name);
  saveColumnList(list);
}

function renderAddColumn() {
  const tile = el('div', { class: 'add-column' });
  const plus = el('button', { class: 'add-btn', title: 'Add column', 'aria-label': 'Add column' }, '+');
  plus.addEventListener('click', () => {
    state.addingColumn = true;
    const input = el('input', { placeholder: 'New column name', 'aria-label': 'New column name' });
    let finished = false;
    const finish = (save) => {
      if (finished) return;
      finished = true;
      state.addingColumn = false;
      const name = input.value.replace(/\//g, '-').trim();
      if (save && name) addColumn(name); else render();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    tile.replaceChildren(input);
    input.focus();
  });
  tile.append(plus);
  return tile;
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
  const node = el('section', { class: 'column search', 'data-col': '-1' }, [
    el('h2', {}, [columnCheckbox(-1), el('span', { class: 'q' }, title || `“${q}”`), el('span', { class: 'count' }, ids.length + (more ? '+' : '')), sortBtn, close]),
    el('div', { class: 'cards' }, ids.length
      ? ids.map((id) => renderCard(state.threads.get(id), -1))
      : el('p', { class: 'hint' }, title ? 'Nothing here.' : 'No matches.')),
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
  saveColumnList(list);
}

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

function renderColumn(col, i) {
  const ids = state.board[i] || [];
  const sort = sortOf(col);
  const sortBtn = iconButton(`Sort: ${sort.label}`, 'sort', (b) => openSortMenu(b, col));
  if (sort.key !== 'newest') sortBtn.classList.add('on');
  const head = el('h2', {}, [columnCheckbox(i), col.name, el('span', { class: 'count' }, ids.length + (state.more[i] ? '+' : '')),
    sortBtn,
    i > 0 ? iconButton(`Remove column “${col.name}”`, null, () => removeColumn(i), '✕') : null]);
  const node = el('section', { class: 'column', 'data-col': i }, [
    head,
    el('div', { class: 'cards' }, ids.map((id) => renderCard(state.threads.get(id), i))),
  ]);
  node.append(...resizeHandles(node));
  const clearMarks = () => node.classList.remove('drop', 'insert-before', 'insert-after');
  if (columnMovable(col, i)) {
    head.draggable = true;
    head.classList.add('grab');
    head.title = 'Drag to move this column';
    head.addEventListener('dragstart', (e) => {
      state.dragging = true;
      e.dataTransfer.setData(COLUMN_DRAG, String(i));
      e.dataTransfer.effectAllowed = 'move';
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
      : t.labels.has('TRASH') ? 'Trash' : t.labels.has('SPAM') ? 'Spam' : 'Archived';
    where = el('span', { class: 'where' }, place);
  }
  const card = el('article', {
    class: 'card' + (t.unread ? ' unread' : '') + (t.id === state.openId ? ' open' : '') + (color ? ' colored' : '')
      + (state.selected.has(t.id) ? ' selected' : ''),
    style: color ? `--card-color:${color.bg}` : null,
    tabindex: '0', draggable: 'true', 'data-id': t.id, 'data-col': colIdx,
  }, [
    el('div', { class: 'top' }, [
      checkbox('Select', state.selected.has(t.id), () => toggleSelect(t.id)),
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
      iconButton('Report spam', 'spam', () => spamThread(t.id)),
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
    iconButton('Archive', 'archive', () => archiveThread(id)),
    iconButton('Report spam', 'spam', () => spamThread(id)),
    iconButton('Delete', 'trash', () => trashThread(id)),
    t?.unread
      ? iconButton('Mark as read', 'read', () => toggleRead(id))
      : iconButton('Mark as unread', 'unread', () => toggleRead(id)),
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

function readerHead(title) {
  const close = el('button', { 'aria-label': 'Close' }, '✕');
  close.addEventListener('click', closeReader);
  return el('div', { class: 'reader-head' }, [el('h2', {}, title), widenButton(), close]);
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

function openSettings() {
  $('#set-columns').replaceChildren(
    columnRow(settings.inboxName, null, true),
    ...settings.columns.map((n) => columnRow(n, n)),
  );
  $('#set-archive').checked = settings.lastArchives;
  $('#set-client').value = settings.clientId;
  $('#set-error').textContent = '';
  $('#settings').showModal();
}

// Read and check the form; returns { error } or the new settings.
function readSettingsForm() {
  const rows = [...$('#set-columns').querySelectorAll('input')].map((i) => ({
    name: i.value.replace(/\//g, '-').trim(),
    orig: i.dataset.orig,
  }));
  const [inbox, ...rest] = rows;
  const cols = rest.filter((r) => r.name);
  const names = [inbox.name || settings.inboxName, ...cols.map((r) => r.name)];
  if (!cols.length) return { error: 'Keep at least one column besides your inbox.' };
  if (names.length > 9) return { error: 'Nine columns at most.' };
  if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) return { error: 'Two columns have the same name.' };
  return {
    inboxName: names[0],
    cols,
    lastArchives: $('#set-archive').checked,
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
    id = labels.find((l) => l.name === LABEL_PREFIX + oldName)?.id;
  }
  if (!id) return; // label was never created, so there is nothing to carry over
  await api(`/labels/${id}`, { method: 'PATCH', body: { name: LABEL_PREFIX + newName } });
  delete state.labelIds[oldName];
  state.labelIds[newName] = id;
}

async function applySettings({ inboxName, cols, lastArchives, clientId }) {
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
  settings.lastArchives = lastArchives;
  store.set('inboxName', settings.inboxName);
  store.set('columns', settings.columns);
  store.set('lastArchives', settings.lastArchives);
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
  if (e.key === 'Escape' && $('#menu')) { closeMenu(); return; }
  if (e.key === 'Escape' && !$('#reader').hidden) { closeReader(); return; }
  if (e.key === 'Escape' && state.selected.size) { clearSelection(); return; }
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
    applySettings(result);
  });
  // Enter in a column name would otherwise trigger the form's first button (Cancel).
  $('#set-columns').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
  $('#set-add').addEventListener('click', () => {
    const row = columnRow('', null);
    $('#set-columns').append(row);
    row.querySelector('input').focus();
  });
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
  applyColumnWidth(settings.colWidth);
  applyReaderWidth(settings.readerWidth);
  setupReaderResize();
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

// ---------- auto-update ----------

// deploy.sh stamps index.html with ?v=<version>. Poll for a newer stamp and
// reload when it won't disrupt anything; otherwise offer a Reload button.
const VERSION = /[?&]v=(\d+)/.exec(document.querySelector('script[src*="app.js"]')?.src || '')?.[1];
let updateOffered = false;

function canReloadQuietly() {
  if (state.dragging || state.addingColumn || state.selected.size || state.search) return false;
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
    if (!updateOffered) {
      updateOffered = true;
      toast('Mailboard was updated.', { label: 'Reload', run: () => location.reload() });
    }
  } catch {} // offline or Pages hiccup: try again next time
}

function watchForUpdates() {
  // The service worker is what lets the browser offer "Install Mailboard".
  navigator.serviceWorker?.register('sw.js').catch(() => {});
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
  initAuth();
  if (restoreToken()) start(); else show('signin');
}

boot();
