'use strict';

/* LiteNotes for the web: the same app as the iOS version.
   Everything is stored on this device in IndexedDB: one record with all notes,
   and one record per dithered photo. */

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
const bar = $('.bar');
const [fLeft, fCenter, fRight] = [$('#f-left'), $('#f-center'), $('#f-right')];
const confirmBox = $('#confirm');
const confirmDeleteBtn = $('#confirm-delete');
const confirmCancelBtn = $('#confirm-cancel');

const SLIDE_MS = 350;

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
      if (!this.db) return resolve(undefined);
      const req = this.db.transaction('kv').objectStore('kv').get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  set(key, value) {
    return new Promise((resolve, reject) => {
      if (!this.db) return resolve();
      const tx = this.db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
  del(key) {
    return new Promise((resolve) => {
      if (!this.db) return resolve();
      const tx = this.db.transaction('kv', 'readwrite');
      tx.objectStore('kv').delete(key);
      tx.oncomplete = tx.onerror = () => resolve();
    });
  },
};

let notes = []; // { id, title, body, highlights: [[start, length]], photos: [photoId], created, flagged }
let saveTimer = null;

/** Typing saves after a short pause; anything that ends an action saves right away. */
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 250);
}
function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  DB.set('notes', notes).catch(console.error);
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });
window.addEventListener('pagehide', flushSave);

const photoCache = new Map();
async function loadPhotos(ids) {
  await Promise.all(ids.filter((id) => !photoCache.has(id)).map(async (id) => {
    photoCache.set(id, await DB.get('photo:' + id).catch(() => undefined));
  }));
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

function blurAll() {
  const a = document.activeElement;
  if (a && a !== document.body) a.blur();
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
  btn._action = action;
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
    left = ['Delete', () => askDelete([openId])];
    center = ['CLOSE X', closeNote, true];
    right = ['Edit', startEditing];
  } else if (selecting) {
    const none = selection.size === 0;
    const unflag = !none && [...selection].every((id) => byId(id)?.flagged);
    left = [none ? 'Delete' : `Delete (${selection.size})`, () => { if (!none) askDelete([...selection]); }, false, none];
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

/* Footer buttons act on touchend with touchstart's default prevented. That keeps the
   keyboard up and the text selection intact (Highlight needs it), while the touch still
   counts as a user gesture for focusing fields and opening the photo picker. */
let pressed = null;
let lastTouch = 0;
bar.addEventListener('touchstart', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  e.preventDefault();
  pressed = b;
  b.classList.add('pressed');
}, { passive: false });
bar.addEventListener('touchmove', (e) => {
  if (!pressed) return;
  const t = e.touches[0];
  const r = pressed.getBoundingClientRect();
  const inside = t.clientX >= r.left - 20 && t.clientX <= r.right + 20 && t.clientY >= r.top - 20 && t.clientY <= r.bottom + 20;
  pressed.classList.toggle('pressed', inside);
}, { passive: true });
bar.addEventListener('touchend', (e) => {
  const b = pressed;
  pressed = null;
  if (!b) return;
  e.preventDefault();
  lastTouch = Date.now();
  const hit = b.classList.contains('pressed');
  b.classList.remove('pressed');
  if (hit) b._action?.();
});
bar.addEventListener('touchcancel', () => { pressed?.classList.remove('pressed'); pressed = null; });
bar.addEventListener('mousedown', (e) => e.preventDefault());
bar.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || Date.now() - lastTouch < 700) return;
  b._action?.();
});

// ---------- Sheet ----------

function current() { return byId(openId); }

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
  titleEl.tabIndex = editing ? 0 : -1;
  titleEl.placeholder = editing ? 'Title' : 'Untitled';
  editor.contentEditable = editing ? editableMode : 'false';
  layoutSheet();
  if (openId) renderPhotos();
  renderFooter();
}

function fillSheet(note) {
  titleEl.value = note.title;
  renderEditor(note.body, note.highlights);
  updatePlaceholder(note);
  lastSelection = null;
  noteScroll.scrollTop = 0;
  noteShadow.classList.remove('on');
}

async function openNote(id, edit) {
  const note = byId(id);
  if (!note) return;
  if (!edit) blurAll();
  if (note.photos.some((p) => !photoCache.has(p))) await loadPhotos(note.photos); // photos are in place before the slide
  openId = id;
  editing = edit;
  fillSheet(note);
  renderPhotos();
  sheet.getBoundingClientRect(); // start the slide from below
  applySheetState();
}

function closeNote() {
  if (!openId) return;
  const id = openId;
  blurAll();
  openId = null;
  editing = false;
  applySheetState();
  flushSave();
  // Notes that were added but never written in disappear once the sheet has slid away.
  setTimeout(() => {
    const n = byId(id);
    if (n && isEmpty(n) && openId !== id) deleteNotes([id]);
  }, SLIDE_MS);
}

function startEditing() {
  editing = true;
  applySheetState();
}

function finishEditing() {
  blurAll();
  const n = current();
  if (!n || isEmpty(n)) return closeNote();
  editing = false;
  applySheetState();
  flushSave();
}

function addNote() {
  endSearch();
  selecting = false;
  selection.clear();
  const note = { id: uuid(), title: '', body: '', highlights: [], photos: [], created: Date.now(), flagged: false };
  notes.push(note);
  renderList();
  openNote(note.id, true);
  titleEl.focus({ preventScroll: true }); // inside the tap, so the iPhone keyboard opens
  flushSave();
}

dim.addEventListener('click', closeNote);

titleEl.addEventListener('input', () => {
  const n = current();
  if (!n) return;
  n.title = titleEl.value;
  save();
  renderList();
});
titleEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); focusEditorEnd(); }
});

noteScroll.addEventListener('scroll', () => noteShadow.classList.toggle('on', noteScroll.scrollTop > 1), { passive: true });
tail.addEventListener('click', () => { if (editing) focusEditorEnd(); });

// ---------- Note text with highlights ----------
// A note is plain text plus highlight ranges, exactly like the iOS app. The editor shows
// highlights as <mark>; new text never inherits a highlight.

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
    if (s < pos || s + len > text.length) continue;
    if (s > pos) frag.append(text.slice(pos, s));
    frag.append(el('mark', '', text.slice(s, s + len)));
    pos = s + len;
  }
  if (pos < text.length) frag.append(text.slice(pos));
  // A trailing newline only shows as an empty line if something follows it.
  if (text.endsWith('\n')) {
    const end = document.createElement('br');
    end.dataset.end = '';
    frag.append(end);
  }
  editor.replaceChildren(frag);
}

function lastLeaf(node) {
  while (node.lastChild) node = node.lastChild;
  return node;
}

/** Reads the editor back into text + ranges; also converts DOM positions to text offsets. */
function scan(points = []) {
  let text = '';
  const ranges = [];
  const found = points.map(() => null);
  const final = lastLeaf(editor);
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
        // Our own end marker, or the placeholder <br> WebKit leaves in an emptied editor.
        if (c.dataset.end === undefined && c !== final) text += '\n';
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
  const end = editor.lastChild;
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let node;
  let lastText = null;
  while ((node = walker.nextNode())) {
    if (offset < pos + node.data.length || (offset === pos + node.data.length && !node.data.endsWith('\n'))) {
      return [node, Math.max(0, offset - pos)];
    }
    pos += node.data.length;
    lastText = node;
  }
  if (end && end.nodeName === 'BR' && end.dataset.end !== undefined) return [editor, editor.childNodes.length - 1];
  return lastText ? [lastText, lastText.data.length] : [editor, 0];
}

function setCaret(a, b = a) {
  const [n1, o1] = offsetToDom(a);
  const [n2, o2] = offsetToDom(b);
  getSelection().setBaseAndExtent(n1, o1, n2, o2);
}

function editorSelection() {
  const sel = getSelection();
  if (!sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!editor.contains(r.startContainer) || !editor.contains(r.endContainer)) return null;
  const { found } = scan([{ node: r.startContainer, offset: r.startOffset }, { node: r.endContainer, offset: r.endOffset }]);
  return found[0] === null || found[1] === null ? null : [Math.min(found[0], found[1]), Math.max(found[0], found[1])];
}

// The last real (non-empty) selection, in case a tap collapses it before Highlight runs.
let lastSelection = null;
document.addEventListener('selectionchange', () => {
  if (!editing) return;
  const s = editorSelection();
  if (s && s[0] !== s[1]) lastSelection = s;
  else if (s) lastSelection = null;
});

function commitEditor() {
  const n = current();
  if (!n) return;
  const { text, ranges } = scan();
  n.body = text;
  n.highlights = ranges;
  updatePlaceholder(n);
  save();
}

/** Replace the selection with plain text through the model, so it never joins a highlight. */
function insertPlain(str) {
  const sel = editorSelection();
  if (!sel) return;
  const [a, b] = sel;
  const { text, ranges } = scan();
  const shifted = [];
  for (const [s, l] of ranges) {
    const map = (p) => (p <= a ? p : p >= b ? p - (b - a) : a);
    const s2 = map(s), e2 = map(s + l);
    if (e2 <= a) shifted.push([s2, e2 - s2]);
    else if (s2 >= a) shifted.push([s2 + str.length, e2 - s2]);
    else { shifted.push([s2, a - s2]); shifted.push([a + str.length, e2 - a]); }
  }
  renderEditor(text.slice(0, a) + str + text.slice(b), mergeRanges(shifted));
  setCaret(a + str.length);
  commitEditor();
}

editor.addEventListener('beforeinput', (e) => {
  if (!editing || e.isComposing) return;
  if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') {
    e.preventDefault();
    insertPlain('\n');
    return;
  }
  if (e.inputType === 'insertText' && e.data) {
    const sel = editorSelection();
    if (!sel) return;
    const { ranges } = scan();
    // Typing at the end of / inside a highlight would extend it; insert plain text instead.
    if (ranges.some(([s, l]) => s < sel[0] && s + l >= sel[0])) {
      e.preventDefault();
      insertPlain(e.data);
    }
  }
});
editor.addEventListener('input', commitEditor);
editor.addEventListener('paste', (e) => {
  e.preventDefault();
  if (editing) insertPlain(e.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n'));
});
editor.addEventListener('drop', (e) => e.preventDefault());

function updatePlaceholder(n) {
  placeholder.classList.toggle('show', !n.body);
}

function focusEditorEnd() {
  if (!editing) return;
  editor.focus({ preventScroll: true });
  setCaret(scan().text.length);
}

/** Highlights the selection, or removes the highlight if it is already fully highlighted. */
function toggleHighlight() {
  let sel = editorSelection();
  if (!sel || sel[0] === sel[1]) sel = lastSelection;
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
  setCaret(a, b);
  lastSelection = [a, b];
  commitEditor();
}

// ---------- Photos (1-bit Atkinson dithering, like the iOS app) ----------

function renderPhotos() {
  const n = current();
  if (!n) return; // closing: keep the photos on the sheet while it slides away
  const nodes = [];
  for (const id of n.photos) {
    const url = photoCache.get(id);
    if (!url) continue;
    const wrap = el('div', 'photo');
    const img = el('img');
    img.src = url;
    img.alt = '';
    img.draggable = false;
    const remove = el('button', '', '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', 'Remove photo');
    remove.addEventListener('click', () => {
      const note = current();
      if (!note || !editing) return;
      note.photos = note.photos.filter((p) => p !== id);
      removePhoto(id);
      flushSave();
      renderPhotos();
    });
    wrap.append(img, remove);
    nodes.push(wrap);
  }
  photosEl.replaceChildren(...nodes);
}

function decodeImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
    img.src = url;
  });
}

async function dither(file, maxWidth = 400) {
  const img = await decodeImage(file); // applies the photo's orientation
  const scale = Math.min(1, maxWidth / img.naturalWidth);
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  const d = data.data;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  // Atkinson: spread 6/8 of the error to nearby pixels; same as the iOS app.
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
  ctx.putImageData(data, 0, 0);
  return canvas.toDataURL('image/png');
}

photoInput.addEventListener('change', async () => {
  const file = photoInput.files[0];
  photoInput.value = '';
  const id = openId;
  if (!file || !id) return;
  try {
    const url = await dither(file);
    const n = byId(id);
    if (!n) return;
    const pid = uuid();
    await DB.set('photo:' + pid, url);
    photoCache.set(pid, url);
    n.photos.push(pid);
    flushSave();
    if (openId === id) renderPhotos();
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
  if (document.activeElement === searchEl) searchEl.blur();
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
  flushSave();
  renderList();
  renderFooter();
}

function deleteNotes(ids) {
  const set = new Set(ids);
  notes.filter((n) => set.has(n.id)).forEach((n) => n.photos.forEach(removePhoto));
  notes = notes.filter((n) => !set.has(n.id));
  ids.forEach((id) => selection.delete(id));
  flushSave();
  renderList();
  renderFooter();
}

/** Bottom action sheet with one red Delete button, like the iOS confirmation dialog. */
function confirmSheet(label) {
  return new Promise((resolve) => {
    confirmDeleteBtn.textContent = label;
    confirmBox.hidden = false;
    confirmBox.getBoundingClientRect();
    confirmBox.classList.add('on');
    const done = (ok) => {
      confirmBox.classList.remove('on');
      confirmDeleteBtn.onclick = confirmCancelBtn.onclick = confirmBox.onclick = null;
      setTimeout(() => { confirmBox.hidden = true; }, 250);
      resolve(ok);
    };
    confirmDeleteBtn.onclick = (e) => { e.stopPropagation(); done(true); };
    confirmCancelBtn.onclick = (e) => { e.stopPropagation(); done(false); };
    confirmBox.onclick = (e) => { if (e.target === confirmBox) done(false); };
  });
}

async function askDelete(ids) {
  const ok = await confirmSheet(ids.length === 1 ? 'Delete note' : `Delete ${ids.length} notes`);
  if (!ok) return;
  if (openId && ids.includes(openId)) {
    blurAll();
    openId = null;
    editing = false;
    applySheetState();
    setTimeout(() => deleteNotes(ids), SLIDE_MS);
  } else {
    selecting = false;
    deleteNotes(ids);
  }
}

// ---------- Light / dark ----------

function applyThemeLabel() {
  const dark = root.dataset.theme === 'dark';
  themeBtn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  $('meta[name="theme-color"]').content = dark ? '#121212' : '#f6f6f6';
}

themeBtn.addEventListener('click', () => {
  const dark = root.dataset.theme !== 'dark';
  if (dark) root.dataset.theme = 'dark';
  else delete root.dataset.theme;
  try { localStorage.setItem('darkMode', dark ? '1' : '0'); } catch (e) {}
  applyThemeLabel();
});

// ---------- Keyboard-aware layout ----------
// iPhone Safari doesn't shrink the page for the keyboard; size the app to the visible area
// so the footer sits on the keyboard like in the iOS app, and undo Safari's page panning.

const vv = window.visualViewport;
function fitViewport() {
  const h = vv ? vv.height : window.innerHeight;
  app.style.height = h + 'px';
  app.style.top = (vv ? vv.offsetTop : 0) + 'px';
  app.classList.toggle('kb', window.innerHeight - h > 120);
  layoutSheet();
}
vv?.addEventListener('resize', fitViewport);
vv?.addEventListener('scroll', fitViewport);
window.addEventListener('resize', fitViewport);
window.addEventListener('pageshow', fitViewport);
document.addEventListener('focusin', () => requestAnimationFrame(() => { window.scrollTo(0, 0); fitViewport(); }));
document.addEventListener('focusout', () => setTimeout(() => { window.scrollTo(0, 0); fitViewport(); }, 60));

// ---------- Start ----------

function demoNotes() {
  const titles = ['First snow', 'Things to remember', 'Books for winter', 'Studio ideas', 'Grocery list',
    'Letter I never sent', 'Night train', 'Sunday walk', 'Questions for class', 'Gift ideas', 'Song lyrics',
    'Dream from Tuesday', 'Morning pages', 'Packing list'];
  const body = 'The first snow came early this year. I walked home the long way, past the bakery and the closed bookshop, and wrote this down so I would not forget how quiet everything was. The streets were empty and the lamps came on one by one. Some days are worth keeping, even the small ones.';
  const start = Date.now() - titles.length * 86400000 * 2.3;
  const hl = body.indexOf('how quiet everything was');
  return titles.map((title, i) => ({
    id: uuid(), title, body: i === 0 ? body : '', highlights: i === 0 ? [[hl, 24]] : [], photos: [],
    created: start + i * 86400000 * 2.3 + i * 2351000, flagged: [1, 6, 8].includes(i),
  }));
}

fitViewport();
applyThemeLabel();
renderFooter();

(async function start() {
  try {
    await DB.open();
    notes = (await DB.get('notes')) || [];
    navigator.storage?.persist?.();
  } catch (err) {
    console.error(err);
    alert('LiteNotes could not open its storage. Notes will not be saved in this browser mode.');
  }
  // Screenshot helpers, only when running on this computer.
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  const params = new URLSearchParams(location.search);
  if (local && params.has('demo') && notes.length === 0) { notes = demoNotes(); flushSave(); }
  renderList();
  renderFooter();
  if (local && params.has('open')) openNote(notes[Number(params.get('open')) - 1]?.id, params.has('edit'));
})();

// Offline support. When an update is installed, reload once so old and new files never mix.
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded) return;
    reloaded = true;
    flushSave();
    location.reload();
  });
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
