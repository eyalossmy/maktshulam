// מקטשולם — ניהול מק״טים. Data lives in IndexedDB on this device.
// Duplicates are blocked in two layers: live checks in the UI, and unique
// indexes on the normalized name and SKU keys inside the database itself.

const DB_NAME = 'maktshulam';
const STORE = 'items';
const PHOTO_MAX = 1000;          // longest edge of stored photos, px
const PHOTO_HAMMING_MAX = 4;     // dHash distance at or below which two photos count as the same
const NAME_SIMILAR_MAX = 1;      // edit distance that triggers a "very similar name" warning

const $ = (sel, root = document) => root.querySelector(sel);
const el = {
  grid: $('#grid'), empty: $('#empty'), noResults: $('#noResults'),
  count: $('#count'), photoCount: $('#photoCount'), search: $('#search'),
  editor: $('#editor'), form: $('#form'), formTitle: $('#formTitle'),
  drop: $('#drop'), photo: $('#photo'), preview: $('#preview'), clearPhoto: $('#clearPhoto'),
  dropBusy: $('.drop-busy'), photoMsg: $('#photoMsg'),
  name: $('#name'), nameField: $('#nameField'), nameMsg: $('#nameMsg'),
  sku: $('#sku'), skuField: $('#skuField'), skuMsg: $('#skuMsg'), genSku: $('#genSku'),
  save: $('#saveBtn'), del: $('#deleteBtn'),
  menuBtn: $('#menuBtn'), menu: $('#menu'), importFile: $('#importFile'), toasts: $('#toasts'),
};

let db;
let items = [];                   // sorted newest first
const urls = new Map();           // id -> object URL for its photo
let editing = null;               // item being edited, or null when adding
let draft = { photo: null, hash: null, url: null, dirty: false };
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('maktshulam') : null;

/* ---------------- Normalization & comparison ---------------- */

const stripMarks = s => s.normalize('NFKD').replace(/[֑-ׇ̀-ͯ]/g, '');
const clean = s => s.replace(/\s+/g, ' ').trim();

// "כוס  זכוכית" / "כוס-זכוכית" / "כּוֹס זכוכית" all map to the same key
function nameKey(name) {
  return stripMarks(name).toLowerCase()
    .replace(/[״"'`׳\-_.,:;/\\()[\]{}|+*!?]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// "mk-100 24" / "MK10024" / "Mk.10024" all map to the same key
function skuKey(sku) {
  return stripMarks(sku).toUpperCase().replace(/[\s\-_./\\|]/g, '');
}

function levenshtein(a, b, cap) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

function popcount(n) { let c = 0; while (n) { c += Number(n & 1n); n >>= 1n; } return c; }
const hamming = (a, b) => popcount(BigInt('0x' + a) ^ BigInt('0x' + b));

// Photo fingerprints are either a 16-char perceptual hash (compared loosely)
// or "x" + SHA-256 for low-detail images (compared exactly).
function samePhoto(a, b) {
  if (a.length === 16 && b.length === 16) return hamming(a, b) <= PHOTO_HAMMING_MAX;
  return a === b;
}

function findConflicts({ name, sku, hash }, selfId) {
  const nk = nameKey(name || ''), sk = skuKey(sku || '');
  const out = { name: null, similar: null, sku: null, photo: null };
  for (const it of items) {
    if (it.id === selfId) continue;
    if (nk && it.nameKey === nk) out.name = it;
    else if (nk.length >= 4 && !out.similar && levenshtein(nk, it.nameKey, NAME_SIMILAR_MAX) <= NAME_SIMILAR_MAX) out.similar = it;
    if (sk && it.skuKey === sk) out.sku = it;
    if (hash && it.photoHash && !out.photo && samePhoto(hash, it.photoHash)) out.photo = it;
  }
  return out;
}

/* ---------------- IndexedDB ---------------- */

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'id' });
      store.createIndex('nameKey', 'nameKey', { unique: true });
      store.createIndex('skuKey', 'skuKey', { unique: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run(mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    let result;
    if (req) req.onsuccess = () => { result = req.result; };
    t.oncomplete = () => resolve(result);
    t.onabort = () => reject(t.error || req?.error);
  });
}

const getAll = () => run('readonly', s => s.getAll());
const putItem = item => run('readwrite', s => s.put(item));
const deleteItem = id => run('readwrite', s => s.delete(id));

async function reload() {
  items = (await getAll()).sort((a, b) => b.createdAt - a.createdAt);
  const live = new Set(items.map(i => i.id));
  for (const [id, url] of urls) if (!live.has(id)) { URL.revokeObjectURL(url); urls.delete(id); }
  for (const it of items) {
    if (it.photo && !urls.has(it.id)) urls.set(it.id, URL.createObjectURL(it.photo));
  }
  render();
}

function photoUrl(it) { return it.photo ? urls.get(it.id) : null; }

/* ---------------- Images ---------------- */

async function processImage(file) {
  if (!file || !file.type.startsWith('image/')) throw new Error('הקובץ שנבחר אינו תמונה');
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { throw new Error('לא ניתן לקרוא את התמונה. נסו JPG, PNG או WEBP'); }
  const scale = Math.min(1, PHOTO_MAX / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  let blob = await new Promise(r => c.toBlob(r, 'image/webp', 0.86));
  if (!blob || blob.type !== 'image/webp') blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.88));
  const hash = dhash(bmp) || await sha(blob);
  bmp.close?.();
  return { blob, hash };
}

async function sha(blob) {
  const buf = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return 'x' + [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// 64-bit difference hash: survives resizing and re-compression, so the same
// photo uploaded twice is caught even if it was saved at a different size.
function dhash(source) {
  const c = document.createElement('canvas');
  c.width = 9; c.height = 8;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, 9, 8);
  const d = ctx.getImageData(0, 0, 9, 8).data;
  const g = i => d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
  let h = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    h = (h << 1n) | (g(y * 9 + x) > g(y * 9 + x + 1) ? 1n : 0n);
  }
  const bits = popcount(h);
  if (bits < 4 || bits > 60) return null; // near-flat image: too little detail to compare
  return h.toString(16).padStart(16, '0');
}

async function hashBlob(blob) {
  try { const bmp = await createImageBitmap(blob); const h = dhash(bmp); bmp.close?.(); return h || await sha(blob); }
  catch { return null; }
}

/* ---------------- Rendering ---------------- */

const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COPY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="3"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>';

function highlight(text, q) {
  if (!q) return esc(text);
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return esc(text);
  return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
}

function render() {
  const q = clean(el.search.value);
  const nq = nameKey(q), sq = skuKey(q);
  const shown = !q ? items : items.filter(it =>
    (nq && it.nameKey.includes(nq)) || (sq && it.skuKey.includes(sq)));

  el.count.textContent = items.length.toLocaleString('he-IL');
  el.photoCount.textContent = items.filter(i => i.photo).length.toLocaleString('he-IL');
  el.empty.hidden = items.length > 0;
  el.noResults.hidden = !(items.length > 0 && shown.length === 0);

  el.grid.innerHTML = shown.map((it, i) => {
    const url = photoUrl(it);
    const ph = url
      ? `<img src="${url}" alt="" loading="lazy" decoding="async">`
      : `<span class="initial" aria-hidden="true">${esc([...it.name][0] || '')}</span>`;
    return `<article class="card" data-id="${it.id}" tabindex="0" style="animation-delay:${Math.min(i, 12) * 25}ms" aria-label="${esc(it.name)}, מק״ט ${esc(it.sku)}">
      <div class="ph">${ph}</div>
      <div class="meta">
        <h3>${highlight(it.name, q)}</h3>
        <button type="button" class="sku" data-copy="${esc(it.sku)}" title="העתקת מק״ט"><span class="t">${highlight(it.sku, q)}</span>${COPY_ICON}</button>
      </div>
    </article>`;
  }).join('');
}

/* ---------------- Editor ---------------- */

function openEditor(item = null) {
  editing = item;
  el.form.reset();
  el.formTitle.textContent = item ? 'עריכת פריט' : 'פריט חדש';
  el.del.hidden = !item;
  disarmDelete();
  el.name.value = item?.name || '';
  el.sku.value = item?.sku || '';
  setDraftPhoto(item?.photo || null, item?.photoHash || null, false);
  el.editor.showModal();
  validate();
  if (!item) el.name.focus();
}

function closeEditor() {
  el.editor.close();
}

el.editor.addEventListener('close', () => {
  if (draft.url && draft.dirty) URL.revokeObjectURL(draft.url);
  draft = { photo: null, hash: null, url: null, dirty: false };
  editing = null;
});

function setDraftPhoto(blob, hash, dirty) {
  if (draft.url && draft.dirty) URL.revokeObjectURL(draft.url);
  const url = blob ? (dirty ? URL.createObjectURL(blob) : urls.get(editing?.id)) : null;
  draft = { photo: blob, hash, url, dirty };
  el.preview.hidden = !url;
  if (url) el.preview.src = url; else el.preview.removeAttribute('src');
  el.drop.classList.toggle('has-photo', !!url);
  el.clearPhoto.hidden = !url;
}

async function acceptFile(file) {
  if (!file) return;
  el.dropBusy.hidden = false;
  try {
    const { blob, hash } = await processImage(file);
    setDraftPhoto(blob, hash, true);
    validate();
  } catch (err) {
    toast(err.message, { bad: true });
  } finally {
    el.dropBusy.hidden = true;
  }
}

function conflictLine(prefix, it, { jump = true } = {}) {
  const url = photoUrl(it);
  const thumb = url ? `<img class="thumb" src="${url}" alt="">` : '';
  const btn = jump ? ` <button type="button" class="link" data-jump="${it.id}">פתיחה</button>` : '';
  return `${thumb}<span>${prefix} <b>${esc(it.name)}</b> · <span class="code">${esc(it.sku)}</span>${btn}</span>`;
}

function setField(field, msgEl, state, html = '') {
  field.classList.remove('ok', 'bad', 'warn');
  if (state) field.classList.add(state);
  msgEl.className = 'msg' + (state ? ' ' + state : '');
  msgEl.innerHTML = html;
}

// Returns true when the form can be saved.
function validate() {
  const name = clean(el.name.value), sku = clean(el.sku.value);
  const c = findConflicts({ name, sku, hash: draft.hash }, editing?.id);

  if (!name) setField(el.nameField, el.nameMsg, null);
  else if (c.name) setField(el.nameField, el.nameMsg, 'bad', conflictLine('השם כבר קיים:', c.name));
  else if (c.similar) setField(el.nameField, el.nameMsg, 'warn', conflictLine('שם דומה מאוד קיים:', c.similar));
  else setField(el.nameField, el.nameMsg, 'ok');

  if (!sku) setField(el.skuField, el.skuMsg, null);
  else if (!skuKey(sku)) setField(el.skuField, el.skuMsg, 'bad', 'מק״ט חייב לכלול אותיות או ספרות');
  else if (c.sku) setField(el.skuField, el.skuMsg, 'bad', conflictLine('המק״ט כבר בשימוש:', c.sku));
  else setField(el.skuField, el.skuMsg, 'ok', 'מק״ט פנוי');

  el.drop.classList.toggle('bad', !!c.photo);
  el.photoMsg.className = 'msg' + (c.photo ? ' bad' : '');
  el.photoMsg.innerHTML = c.photo ? conflictLine('התמונה כבר משויכת לפריט:', c.photo) : '';

  const ok = !!name && !!skuKey(sku) && !c.name && !c.sku && !c.photo;
  el.save.disabled = !ok;
  return ok;
}

function shake(field) {
  field.classList.remove('shake');
  void field.offsetWidth;
  field.classList.add('shake');
}

async function save(e) {
  e.preventDefault();
  const name = clean(el.name.value), sku = clean(el.sku.value).toUpperCase();
  if (!validate()) {
    if (!name || el.nameField.classList.contains('bad')) { shake(el.nameField); el.name.focus(); }
    else { shake(el.skuField); el.sku.focus(); }
    return;
  }
  const now = Date.now();
  const record = {
    id: editing?.id || crypto.randomUUID(),
    name, sku,
    nameKey: nameKey(name), skuKey: skuKey(sku),
    photo: draft.photo, photoHash: draft.photo ? draft.hash : null,
    createdAt: editing?.createdAt || now, updatedAt: now,
  };
  el.save.disabled = true;
  try {
    await putItem(record);
  } catch (err) {
    if (err?.name === 'ConstraintError') {
      // Another tab saved a conflicting item in the meantime; the database refused it.
      await reload();
      validate();
      toast('נחסם: פריט עם אותו שם או מק״ט נוסף זה עתה', { bad: true });
      return;
    }
    toast('השמירה נכשלה: ' + (err?.message || err), { bad: true });
    validate();
    return;
  }
  if (draft.dirty && draft.url) { URL.revokeObjectURL(draft.url); draft.url = null; }
  if (urls.has(record.id)) { URL.revokeObjectURL(urls.get(record.id)); urls.delete(record.id); }
  const wasEditing = !!editing;
  closeEditor();
  await reload();
  broadcast();
  flashCard(record.id);
  toast(wasEditing ? 'הפריט עודכן' : 'הפריט נוסף');
}

let deleteTimer;
function disarmDelete() {
  clearTimeout(deleteTimer);
  el.del.classList.remove('armed');
  el.del.textContent = 'מחיקה';
}

async function onDelete() {
  if (!editing) return;
  if (!el.del.classList.contains('armed')) {
    el.del.classList.add('armed');
    el.del.textContent = 'לאישור לחצו שוב';
    deleteTimer = setTimeout(disarmDelete, 3500);
    return;
  }
  const item = editing;
  closeEditor();
  await deleteItem(item.id);
  await reload();
  broadcast();
  toast(`"${item.name}" נמחק`, {
    action: 'ביטול',
    onAction: async () => {
      try { await putItem(item); await reload(); broadcast(); flashCard(item.id); }
      catch { toast('לא ניתן לשחזר: השם או המק״ט כבר בשימוש', { bad: true }); }
    },
  });
}

function nextSku() {
  const taken = new Set(items.map(i => i.skuKey));
  let max = 10000;
  for (const it of items) {
    const m = /^MK(\d+)$/.exec(it.skuKey);
    if (m) max = Math.max(max, Number(m[1]));
  }
  let n = max + 1;
  while (taken.has('MK' + n)) n++;
  return 'MK-' + n;
}

/* ---------------- Toasts & misc ---------------- */

function toast(text, { bad = false, action, onAction, ms = 4200 } = {}) {
  const t = document.createElement('div');
  t.className = 'toast' + (bad ? ' bad' : '');
  t.setAttribute('role', bad ? 'alert' : 'status');
  t.innerHTML = `<span>${esc(text)}</span>`;
  const dismiss = () => { t.classList.add('out'); setTimeout(() => t.remove(), 200); };
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = action;
    b.onclick = () => { dismiss(); onAction(); };
    t.append(b);
  }
  el.toasts.append(t);
  setTimeout(dismiss, action ? ms + 2000 : ms);
}

function flashCard(id) {
  const card = el.grid.querySelector(`[data-id="${id}"]`);
  if (!card) return;
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  card.classList.add('flash');
  setTimeout(() => card.classList.remove('flash'), 1400);
}

function broadcast() { channel?.postMessage('changed'); }

/* ---------------- Backup ---------------- */

const blobToDataUrl = blob => new Promise((res, rej) => {
  const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob);
});

async function exportBackup() {
  const out = [];
  for (const it of items) {
    out.push({ name: it.name, sku: it.sku, photo: it.photo ? await blobToDataUrl(it.photo) : null, photoHash: it.photoHash, createdAt: it.createdAt });
  }
  const blob = new Blob([JSON.stringify({ app: 'maktshulam', version: 1, exportedAt: new Date().toISOString(), items: out })], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `maktshulam-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`יוצאו ${items.length} פריטים`);
}

async function importBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { return toast('קובץ הגיבוי אינו תקין', { bad: true }); }
  const list = Array.isArray(data?.items) ? data.items : null;
  if (!list) return toast('קובץ הגיבוי אינו תקין', { bad: true });
  let added = 0, blocked = 0;
  for (const raw of list) {
    const name = clean(String(raw?.name || '')), sku = clean(String(raw?.sku || '')).toUpperCase();
    if (!name || !skuKey(sku)) { blocked++; continue; }
    let photo = null, photoHash = null;
    if (typeof raw.photo === 'string' && raw.photo.startsWith('data:image/')) {
      photo = await (await fetch(raw.photo)).blob();
      photoHash = await hashBlob(photo);
    }
    const c = findConflicts({ name, sku, hash: photoHash });
    if (c.name || c.sku || c.photo) { blocked++; continue; }
    const now = Date.now();
    const rec = { id: crypto.randomUUID(), name, sku, nameKey: nameKey(name), skuKey: skuKey(sku), photo, photoHash, createdAt: Number(raw.createdAt) || now, updatedAt: now };
    try { await putItem(rec); items.push(rec); added++; } catch { blocked++; }
  }
  await reload();
  broadcast();
  toast(blocked ? `יובאו ${added} פריטים · ${blocked} כפולים או פגומים נחסמו` : `יובאו ${added} פריטים`);
}

/* ---------------- Events ---------------- */

function toggleMenu(open = el.menu.hidden) {
  el.menu.hidden = !open;
  el.menuBtn.setAttribute('aria-expanded', String(open));
}

function bind() {
  $('#addBtn').addEventListener('click', () => openEditor());
  document.addEventListener('click', e => {
    if (e.target.closest('[data-action="add"]')) openEditor();
    if (!e.target.closest('.menu-wrap')) toggleMenu(false);
  });

  el.menuBtn.addEventListener('click', () => toggleMenu());
  el.menu.addEventListener('click', e => {
    const a = e.target.closest('[data-action]')?.dataset.action;
    toggleMenu(false);
    if (a === 'export') exportBackup();
    if (a === 'import') el.importFile.click();
  });
  el.importFile.addEventListener('change', () => {
    const f = el.importFile.files[0];
    el.importFile.value = '';
    if (f) importBackup(f);
  });

  el.search.addEventListener('input', render);

  el.grid.addEventListener('click', async e => {
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      e.stopPropagation();
      try { await navigator.clipboard.writeText(copy.dataset.copy); } catch { return; }
      copy.classList.add('copied');
      setTimeout(() => copy.classList.remove('copied'), 1100);
      return;
    }
    const card = e.target.closest('.card');
    if (card) openEditor(items.find(i => i.id === card.dataset.id));
  });
  el.grid.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.classList.contains('card')) openEditor(items.find(i => i.id === e.target.dataset.id));
  });

  el.form.addEventListener('submit', save);
  el.form.addEventListener('click', e => {
    if (e.target.closest('[data-close]')) closeEditor();
    const jump = e.target.closest('[data-jump]');
    if (jump) {
      const target = items.find(i => i.id === jump.dataset.jump);
      closeEditor();
      if (target) openEditor(target);
    }
  });
  el.editor.addEventListener('click', e => { if (e.target === el.editor) closeEditor(); });

  el.name.addEventListener('input', validate);
  el.sku.addEventListener('input', validate);
  el.genSku.addEventListener('click', () => { el.sku.value = nextSku(); validate(); el.sku.focus(); });
  el.del.addEventListener('click', onDelete);

  el.drop.addEventListener('click', e => {
    if (e.target === el.clearPhoto) return;
    el.photo.click();
  });
  el.drop.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.photo.click(); }
  });
  el.clearPhoto.addEventListener('click', e => {
    e.stopPropagation();
    setDraftPhoto(null, null, true);
    validate();
  });
  el.photo.addEventListener('change', () => { acceptFile(el.photo.files[0]); el.photo.value = ''; });
  ['dragenter', 'dragover'].forEach(t => el.drop.addEventListener(t, e => { e.preventDefault(); el.drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => el.drop.addEventListener(t, () => el.drop.classList.remove('over')));
  el.drop.addEventListener('drop', e => { e.preventDefault(); acceptFile(e.dataTransfer.files[0]); });
  el.editor.addEventListener('paste', e => {
    const f = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith('image/'));
    if (f) { e.preventDefault(); acceptFile(f); }
  });

  document.addEventListener('keydown', e => {
    if (e.key === '/' && !el.editor.open && document.activeElement !== el.search) {
      e.preventDefault();
      el.search.focus();
    }
    if (e.key === 'Escape') toggleMenu(false);
  });

  const top = $('.top');
  addEventListener('scroll', () => top.classList.toggle('scrolled', scrollY > 4), { passive: true });

  channel?.addEventListener('message', async () => {
    await reload();
    if (el.editor.open) validate();
  });
}

/* ---------------- Boot ---------------- */

(async function init() {
  bind();
  try {
    db = await openDb();
    await reload();
  } catch (err) {
    el.empty.hidden = false;
    toast('הדפדפן חוסם שמירת נתונים מקומית (מצב גלישה פרטית?)', { bad: true, ms: 10000 });
    console.error(err);
  }
  navigator.storage?.persist?.();
})();
