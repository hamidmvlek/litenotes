'use strict';

/* LiteNotes for the web. Same behaviour as the iOS app; everything is stored on this device
   in IndexedDB: one record with all notes, and one record per dithered photo. */

const $ = (s) => document.querySelector(s);
const root = document.documentElement;
const app = $('#app');
const listEl = $('#list');
const heading = $('#heading');
const searchEl = $('#search');
const themeBtn = $('#theme');
const dim = $('#dim');
const sheet = $('#sheet');
const titleEl = $('#note-title');
const editor = $('#note-body');
const placeholder = $('#note-placeholder');
const noteScroll = $('#note-scroll');
const noteShadow = $('#note-shadow');
const photosEl = $('#note-photos');
const tail = $('#note-tail');
const photoInput = $('#photo-input');
const [fLeft, fCenter, fRight] = [$('#f-left'), $('#f-center'), $('#f-right')];

// ---------- Storage ----------

const DB = {
  db: null,
  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('litenotes', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => { this.db = req.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  },
  get(key) {
    return new Promise((resolve, reject) => {
      const req = this.db.transaction('kv').objectStore('kv').get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  set(key, value) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
  del(key) {
    return new Promise((resolve) => {
      const tx = this.db.transaction('kv', 'readwrite');
      tx.objectStore('kv').delete(key);
      tx.oncomplete = tx.onerror = () => resolve();
    });
  },
};

let notes = []; // { id, title, body, highlights: [[start, length]], photos: [photoId], created, flagged }
let saveTimer = null;

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => DB.set('notes', notes).catch(console.error), 250);
}
// Don't lose the last keystrokes when the app is backgrounded or closed.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && saveTimer) { clearTimeout(saveTimer); DB.set('notes', notes); }
});

const photoCache = new Map();
async function photoURL(id) {
  if (!photoCache.has(id)) photoCache.set(id, await DB.get('photo:' + id));
  return photoCache.get(id);
}
function removePhoto(id) {
  photoCache.delete(id);
  DB.del('photo:' + id);
}

const byId = (id) => notes.find((n) => n.id === id);
const isEmpty = (n) => !n.title.trim() && !n.body.trim() && n.photos.length === 0;
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

// ---------- Dates (numbers only, e.g. 19.10.26 14:32) ----------

const pad = (n) => String(n).padStart(2, '0');
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function stamp(t) {
  const d = new Date(t);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** Several spellings of a date so "19.10", "19/10/2026", "2026-10" or "october" all match. */
function searchText(t) {
  const d = new Date(t);
  const dd = pad(d.getDate()), mm = pad(d.getMonth() + 1), y = d.getFullYear(), yy = String(y).slice(2);
  return [stamp(t), `${dd}.${mm}.${y}`, `${dd}/${mm}/${yy}`, `${dd}/${mm}/${y}`, `${y}-${mm}-${dd}`,
    `${d.getDate()} ${MONTHS[d.getMonth()]} ${y}`].join(' ');
}

// ---------- State ----------

let openId = null;
let editing = false;
let selecting = false;
const selection = new Set();
let searching = false;
let query = '';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const FLAG_SVG = '<svg class="flag" viewBox="0 0 12 12" aria-label="Flagged"><path d="M1.8 0.6h1.2v10.8H1.8z M3 1.2c1.6-0.8 2.9 0.6 4.4 0 0.9-0.4 1.8-0.4 2.6 0v5.2c-0.8-0.4-1.7-0.4-2.6 0-1.5 0.6-2.8-0.8-4.4 0z" fill="currentColor"/></svg>';

// ---------- List ----------

function renderList() {
  const q = query.trim().toLowerCase();
  listEl.style.setProperty('--numw', String(Math.max(notes.length, 1)).length * 9 + 5 + 'px');
  const rows = [];
  notes.forEach((n, i) => {
    if (q && !n.title.toLowerCase().includes(q) && !searchText(n.created).includes(q)) return;
    const li = el('li', 'row');
    li.dataset.id = n.id;
    li.append(el('span', 'stamp', stamp(n.created)), el('span', 'num', i + 1 + '.'));
    const name = el('span', 'name');
    name.append(el('span', selection.has(n.id) ? 'sel' : '', n.title || 'Untitled'));
    li.append(name);
    if (n.flagged) li.insertAdjacentHTML('beforeend', FLAG_SVG);
    rows.push(li);
  });
  listEl.replaceChildren(...rows);
}

listEl.addEventListener('click', (e) => {
  const li = e.target.closest('.row');
  if (!li) return;
  const id = li.dataset.id;
  if (selecting) {
    selection.has(id) ? selection.delete(id) : selection.add(id);
    renderList();
    renderFooter();
  } else {
    openNote(id, false);
  }
});

// ---------- Footer ----------

function setButton(btn, [label, action, strong = false, off = false]) {
  btn.textContent = label;
  btn.onclick = action;
  btn.classList.toggle('strong', strong);
  btn.classList.toggle('off', off);
}

function renderFooter() {
  let left, center, right;
  if (openId && editing) {
    left = ['Photo', () => photoInput.click()];
    center = ['DONE', finishEditing, true];
    right = ['Highlight', toggleHighlight];
  } else if (openId) {
    left = ['Delete', () => confirmDelete([openId])];
    center = ['CLOSE X', closeNote, true];
    right = ['Edit', startEditing];
  } else if (selecting) {
    const none = selection.size === 0;
    const unflag = !none && [...selection].every((id) => byId(id)?.flagged);
    left = [none ? 'Delete' : `Delete (${selection.size})`, () => { if (!none) confirmDelete([...selection]); }, false, none];
    center = ['CANCEL', () => { selecting = false; selection.clear(); renderList(); renderFooter(); }, true];
    right = [unflag ? 'Unflag' : 'Flag', () => { if (!none) toggleFlag(); }, false, none];
  } else if (searching) {
    left = ['Search', endSearch, true];
    center = ['Add', addNote];
    right = ['Select', startSelecting];
  } else {
    left = ['Search', startSearch];
    center = ['Add', addNote];
    right = ['Select', startSelecting];
  }
  setButton(fLeft, left);
  setButton(fCenter, center);
  setButton(fRight, right);
}

// Footer taps must not steal focus or the text selection from the note (Highlight needs it).
$('.bar').addEventListener('mousedown', (e) => e.preventDefault());

// ---------- Sheet ----------

function noteBody() { return byId(openId); }

/** Reading mode pushes the sheet down; pad the scroll area so its end stays reachable. */
function layoutSheet() {
  noteScroll.style.paddingBottom = openId && !editing ? Math.max(0, sheet.offsetHeight * 0.42 - 7) + 'px' : '0px';
}

function applySheetState() {
  sheet.classList.toggle('reading', !!openId && !editing);
  sheet.classList.toggle('editing', !!openId && editing);
  sheet.setAttribute('aria-hidden', openId ? 'false' : 'true');
  dim.classList.toggle('on', !!openId);
  titleEl.readOnly = !editing;
  titleEl.placeholder = editing ? 'Title' : 'Untitled';
  editor.contentEditable = editing ? editableMode : 'false';
  layoutSheet();
  renderPhotos();
  renderFooter();
}

function fillSheet(note) {
  titleEl.value = note.title;
  photosEl.replaceChildren();
  renderEditor(note.body, note.highlights);
  updatePlaceholder();
  noteScroll.scrollTop = 0;
  noteShadow.classList.remove('on');
}

function openNote(id, edit) {
  const note = byId(id);
  if (!note) return;
  openId = id;
  editing = edit;
  fillSheet(note);
  sheet.getBoundingClientRect(); // start the slide from below
  applySheetState();
}

function closeNote() {
  if (!openId) return;
  const id = openId;
  document.activeElement?.blur();
  openId = null;
  editing = false;
  applySheetState();
  // Notes that were added but never written in disappear once the sheet has slid away.
  setTimeout(() => {
    const n = byId(id);
    if (n && isEmpty(n) && openId !== id) deleteNotes([id]);
  }, 350);
}

function startEditing() {
  editing = true;
  applySheetState();
}

function finishEditing() {
  document.activeElement?.blur();
  const n = noteBody();
  if (!n || isEmpty(n)) return closeNote();
  editing = false;
  applySheetState();
}

function addNote() {
  endSearch();
  selecting = false;
  selection.clear();
  const note = { id: uuid(), title: '', body: '', highlights: [], photos: [], created: Date.now(), flagged: false };
  notes.push(note);
  save();
  renderList();
  openNote(note.id, true);
  titleEl.focus({ preventScroll: true }); // must happen inside the tap for the iPhone keyboard to appear
}

dim.addEventListener('click', closeNote);

titleEl.addEventListener('input', () => {
  const n = noteBody();
  if (!n) return;
  n.title = titleEl.value;
  save();
  renderList();
});
titleEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); focusEditorEnd(); }
});

noteScroll.addEventListener('scroll', () => noteShadow.classList.toggle('on', noteScroll.scrollTop > 1), { passive: true });
tail.addEventListener('click', () => { if (editing) focusEditorEnd(); });

// ---------- Note text with highlights ----------
// The note is plain text plus highlight ranges; the editor shows highlights as <mark>.

const editableMode = (() => {
  const probe = document.createElement('div');
  probe.contentEditable = 'plaintext-only';
  return probe.contentEditable === 'plaintext-only' ? 'plaintext-only' : 'true';
})();

function mergeRanges(ranges) {
  const sorted = ranges.filter(([, l]) => l > 0).map(([s, l]) => [s, s + l]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out.map(([s, e]) => [s, e - s]);
}

function renderEditor(text, ranges) {
  const frag = document.createDocumentFragment();
  let pos = 0;
  for (const [s, len] of ranges) {
    if (s + len > text.length) continue;
    if (s > pos) frag.append(text.slice(pos, s));
    frag.append(el('mark', '', text.slice(s, s + len)));
    pos = s + len;
  }
  if (pos < text.length) frag.append(text.slice(pos));
  editor.replaceChildren(frag);
}

/** Reads the editor back into text + ranges; also converts DOM positions to text offsets. */
function scan(points = []) {
  let text = '';
  const ranges = [];
  const found = points.map(() => null);
  const hit = (node, index) => points.forEach((p, k) => {
    if (found[k] === null && p.node === node && p.offset === index) found[k] = text.length;
  });
  const walk = (node, inMark) => {
    const kids = node.childNodes;
    for (let i = 0; i < kids.length; i++) {
      hit(node, i);
      const c = kids[i];
      if (c.nodeType === Node.TEXT_NODE) {
        points.forEach((p, k) => {
          if (found[k] === null && p.node === c) found[k] = text.length + Math.min(p.offset, c.data.length);
        });
        if (inMark && c.data) ranges.push([text.length, c.data.length]);
        text += c.data;
      } else if (c.nodeName === 'BR') {
        text += '\n';
      } else if (c.nodeType === Node.ELEMENT_NODE) {
        if ((c.nodeName === 'DIV' || c.nodeName === 'P') && text && !text.endsWith('\n')) text += '\n';
        walk(c, inMark || c.nodeName === 'MARK');
      }
    }
    hit(node, kids.length);
  };
  walk(editor, false);
  return { text, ranges: mergeRanges(ranges), found };
}

function offsetToDom(offset) {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let node;
  while ((node = walker.nextNode())) {
    if (pos + node.data.length >= offset) return [node, offset - pos];
    pos += node.data.length;
  }
  return [editor, editor.childNodes.length];
}

function editorSelection() {
  const sel = getSelection();
  if (!sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!editor.contains(r.startContainer) || !editor.contains(r.endContainer)) return null;
  const { found } = scan([{ node: r.startContainer, offset: r.startOffset }, { node: r.endContainer, offset: r.endOffset }]);
  return found[0] === null || found[1] === null ? null : [Math.min(found[0], found[1]), Math.max(found[0], found[1])];
}

let lastSelection = null;
document.addEventListener('selectionchange', () => {
  if (!editing) return;
  const s = editorSelection();
  if (s) lastSelection = s;
});

function commitEditor() {
  const n = noteBody();
  if (!n) return;
  const { text, ranges } = scan();
  n.body = text;
  n.highlights = ranges;
  updatePlaceholder();
  save();
}

editor.addEventListener('input', commitEditor);
editor.addEventListener('paste', (e) => {
  e.preventDefault();
  document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
});

function updatePlaceholder() {
  placeholder.classList.toggle('show', !noteBody()?.body);
}

function focusEditorEnd() {
  if (!editing) return;
  editor.focus({ preventScroll: true });
  const [node, off] = offsetToDom(Infinity);
  getSelection().setBaseAndExtent(node, off, node, off);
}

/** Highlights the selection, or removes the highlight if it is already fully highlighted. */
function toggleHighlight() {
  const sel = editorSelection() || lastSelection;
  if (!sel || sel[0] === sel[1]) return;
  const [a, b] = sel;
  const { text, ranges } = scan();
  const covered = ranges.some(([s, l]) => s <= a && s + l >= b);
  let next;
  if (covered) {
    next = [];
    for (const [s, l] of ranges) {
      const e = s + l;
      if (e <= a || s >= b) { next.push([s, l]); continue; }
      if (s < a) next.push([s, a - s]);
      if (e > b) next.push([b, e - b]);
    }
  } else {
    next = mergeRanges([...ranges, [a, b - a]]);
  }
  renderEditor(text, next);
  const [n1, o1] = offsetToDom(a);
  const [n2, o2] = offsetToDom(b);
  getSelection().setBaseAndExtent(n1, o1, n2, o2);
  commitEditor();
}

// ---------- Photos (1-bit Atkinson dithering, like the iOS app) ----------

async function renderPhotos() {
  const n = noteBody();
  if (!n) return; // closing: keep the photos on the sheet while it slides away
  const ids = n.photos.slice();
  const nodes = [];
  for (const id of ids) {
    const url = await photoURL(id);
    if (!url) continue;
    const wrap = el('div', 'photo');
    const img = el('img');
    img.src = url;
    img.alt = '';
    const remove = el('button', '', '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', 'Remove photo');
    remove.onclick = () => {
      const note = noteBody();
      if (!note) return;
      note.photos = note.photos.filter((p) => p !== id);
      removePhoto(id);
      save();
      renderPhotos();
    };
    wrap.append(img, remove);
    nodes.push(wrap);
  }
  if (noteBody() === n) photosEl.replaceChildren(...nodes);
}

async function dither(file, maxWidth = 400) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxWidth / bitmap.width);
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  // Atkinson: spread 6/8 of the error to nearby pixels.
  const spread = [[1, 0], [2, 0], [-1, 1], [0, 1], [1, 1], [0, 2]];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const old = lum[i];
      const v = old < 128 ? 0 : 255;
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
      d[i * 4 + 3] = 255;
      const err = (old - v) / 8;
      for (const [dx, dy] of spread) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < w && ny < h) lum[ny * w + nx] += err;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}

photoInput.addEventListener('change', async () => {
  const file = photoInput.files[0];
  photoInput.value = '';
  const n = noteBody();
  if (!file || !n) return;
  try {
    const url = await dither(file);
    const id = uuid();
    await DB.set('photo:' + id, url);
    photoCache.set(id, url);
    n.photos.push(id);
    save();
    renderPhotos();
  } catch (err) {
    console.error(err);
    alert("That photo couldn't be opened.");
  }
});

// ---------- Search, select, flag, delete ----------

function startSearch() {
  searching = true;
  heading.hidden = true;
  searchEl.hidden = false;
  searchEl.focus({ preventScroll: true });
  renderFooter();
}

function endSearch() {
  if (!searching) return;
  searching = false;
  query = '';
  searchEl.value = '';
  searchEl.blur();
  searchEl.hidden = true;
  heading.hidden = false;
  renderList();
  renderFooter();
}

searchEl.addEventListener('input', () => { query = searchEl.value; renderList(); });
searchEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') searchEl.blur(); });

function startSelecting() {
  endSearch();
  selecting = true;
  renderFooter();
}

function toggleFlag() {
  const chosen = notes.filter((n) => selection.has(n.id));
  const flag = !chosen.every((n) => n.flagged);
  chosen.forEach((n) => { n.flagged = flag; });
  selection.clear();
  selecting = false;
  save();
  renderList();
  renderFooter();
}

function deleteNotes(ids) {
  const set = new Set(ids);
  notes.filter((n) => set.has(n.id)).forEach((n) => n.photos.forEach(removePhoto));
  notes = notes.filter((n) => !set.has(n.id));
  ids.forEach((id) => selection.delete(id));
  save();
  renderList();
  renderFooter();
}

function confirmDelete(ids) {
  if (!confirm(ids.length === 1 ? 'Delete this note?' : `Delete ${ids.length} notes?`)) return;
  if (openId && ids.includes(openId)) {
    document.activeElement?.blur();
    openId = null;
    editing = false;
    applySheetState();
    setTimeout(() => deleteNotes(ids), 350);
  } else {
    deleteNotes(ids);
    selecting = false;
    renderFooter();
  }
}

// ---------- Light / dark ----------

function applyThemeLabel() {
  const dark = root.dataset.theme === 'dark';
  themeBtn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  document.querySelector('meta[name="theme-color"]').content = dark ? '#121212' : '#f6f6f6';
}

themeBtn.addEventListener('click', () => {
  const dark = root.dataset.theme !== 'dark';
  if (dark) root.dataset.theme = 'dark';
  else delete root.dataset.theme;
  try { localStorage.setItem('darkMode', dark ? '1' : '0'); } catch (e) {}
  applyThemeLabel();
});

// ---------- Keyboard-aware height (keeps the footer above the iPhone keyboard) ----------

const vv = window.visualViewport;
function fitViewport() {
  if (!vv) return;
  app.style.height = vv.height + 'px';
  app.style.top = vv.offsetTop + 'px';
  layoutSheet();
}
vv?.addEventListener('resize', fitViewport);
vv?.addEventListener('scroll', fitViewport);
window.addEventListener('resize', layoutSheet);

// ---------- Start ----------

function demoNotes() {
  const titles = ['First snow', 'Things to remember', 'Books for winter', 'Studio ideas', 'Grocery list',
    'Letter I never sent', 'Night train', 'Sunday walk', 'Questions for class', 'Gift ideas', 'Song lyrics',
    'Dream from Tuesday', 'Morning pages', 'Packing list'];
  const body = 'The first snow came early this year. I walked home the long way, past the bakery and the closed bookshop, and wrote this down so I would not forget how quiet everything was. The streets were empty and the lamps came on one by one. Some days are worth keeping, even the small ones.';
  const start = Date.now() - titles.length * 86400000 * 2.3;
  return titles.map((title, i) => {
    const hl = body.indexOf('how quiet everything was');
    return {
      id: uuid(), title, body: i === 0 ? body : '', highlights: i === 0 ? [[hl, 24]] : [], photos: [],
      created: start + i * 86400000 * 2.3 + i * 2351000, flagged: [1, 6, 8].includes(i),
    };
  });
}

(async function start() {
  applyThemeLabel();
  try {
    await DB.open();
    notes = (await DB.get('notes')) || [];
    navigator.storage?.persist?.();
  } catch (err) {
    console.error(err);
    alert('LiteNotes could not open its storage. Notes will not be saved in this browser mode.');
  }
  const params = new URLSearchParams(location.search);
  if (params.has('demo') && notes.length === 0) { notes = demoNotes(); save(); }
  renderList();
  renderFooter();
  if (params.has('open')) openNote(notes[Number(params.get('open')) - 1]?.id, params.has('edit'));
  fitViewport();
})();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
