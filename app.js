// מקטשולם — ניהול מק״טים. Data lives in Postgres behind /api.
// Duplicates are checked live here with the same rules the API enforces
// (lib/rules.js), and the API re-checks every save inside a locked transaction.

import { clean, nameKey, codeKey, normalizeUrl, findConflicts } from '/lib/rules.js';

const PHOTO_MAX = 900;           // longest edge of stored photos, px
const REFRESH_MS = 30000;

const $ = (sel, root = document) => root.querySelector(sel);
const el = {
  grid: $('#grid'), empty: $('#empty'), noResults: $('#noResults'),
  count: $('#count'), skuCount: $('#skuCount'), search: $('#search'),
  editor: $('#editor'), form: $('#form'), formTitle: $('#formTitle'),
  drop: $('#drop'), photo: $('#photo'), preview: $('#preview'), clearPhoto: $('#clearPhoto'),
  dropBusy: $('.drop-busy'), photoMsg: $('#photoMsg'),
  name: $('#name'), nameField: $('#nameField'), nameMsg: $('#nameMsg'),
  sku: $('#sku'), skuField: $('#skuField'), skuMsg: $('#skuMsg'), genSku: $('#genSku'),
  unit: $('#unitId'), unitField: $('#unitField'), unitMsg: $('#unitMsg'), genUnit: $('#genUnit'),
  url: $('#url'), urlField: $('#urlField'), urlMsg: $('#urlMsg'),
  save: $('#saveBtn'), del: $('#deleteBtn'), clone: $('#cloneBtn'),
  exportBtn: $('#exportBtn'), toasts: $('#toasts'),
};

let items = [];                   // newest first, as returned by the API
let loaded = false;
let editing = null;               // item being edited, or null when adding
let saving = false;
// photo: "keep" | "clear" | { blob, hash, url } (new upload) | { from, hash, url } (reuse another unit's photo)
let draft = { photo: 'keep' };

/* ---------------- API ---------------- */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'שגיאת רשת'), { status: res.status, data });
  return data;
}

async function reload() {
  try {
    const { items: list } = await api('/api/items');
    items = list;
    loaded = true;
    render();
    if (el.editor.open) validate();
  } catch (err) {
    if (!loaded) { render(); toast('לא ניתן לטעון את הפריטים: ' + err.message, { bad: true, ms: 8000 }); }
  }
}

const photoUrl = it => it?.photo ? `/api/photo?id=${it.id}&v=${it.photoV}` : null;
const siblingsOf = it => items.filter(i => i.skuKey === it.skuKey);

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
  let blob = await new Promise(r => c.toBlob(r, 'image/webp', 0.84));
  if (!blob || blob.type !== 'image/webp') blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.86));
  const hash = dhash(bmp) || await sha(blob);
  bmp.close?.();
  return { blob, hash };
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
  let h = 0n, bits = 0;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const bit = g(y * 9 + x) > g(y * 9 + x + 1);
    h = (h << 1n) | (bit ? 1n : 0n);
    bits += bit;
  }
  if (bits < 4 || bits > 60) return null; // near-flat image: too little detail to compare
  return h.toString(16).padStart(16, '0');
}

async function sha(blob) {
  const buf = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return 'x' + [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const blobToBase64 = blob => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1]);
  r.onerror = () => rej(r.error);
  r.readAsDataURL(blob);
});

/* ---------------- Rendering ---------------- */

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COPY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="3"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>';
const LINK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></svg>';

function highlight(text, q) {
  if (!q) return esc(text);
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return esc(text);
  return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
}

function render() {
  const q = clean(el.search.value);
  const nq = nameKey(q), cq = codeKey(q);
  const shown = !q ? items : items.filter(it =>
    (nq && it.nameKey.includes(nq)) || (cq && (it.skuKey.includes(cq) || it.unitKey.includes(cq))));
  const perSku = new Map();
  for (const it of items) perSku.set(it.skuKey, (perSku.get(it.skuKey) || 0) + 1);

  el.count.textContent = items.length.toLocaleString('he-IL');
  el.skuCount.textContent = perSku.size.toLocaleString('he-IL');
  el.empty.hidden = !loaded || items.length > 0;
  el.noResults.hidden = !(items.length > 0 && shown.length === 0);

  if (!loaded) {
    el.grid.innerHTML = Array.from({ length: 4 }, () => '<div class="card skeleton"><div class="ph"></div><div class="meta"><i></i><i></i></div></div>').join('');
    return;
  }

  el.grid.innerHTML = shown.map((it, i) => {
    const url = photoUrl(it);
    const units = perSku.get(it.skuKey);
    const ph = url
      ? `<img src="${url}" alt="" loading="lazy" decoding="async">`
      : `<span class="initial" aria-hidden="true">${esc([...it.name][0] || '')}</span>`;
    return `<article class="card" data-id="${it.id}" tabindex="0" style="animation-delay:${Math.min(i, 12) * 25}ms" aria-label="${esc(it.name)}, מק״ט ${esc(it.sku)}, ID ${esc(it.unitId)}">
      <div class="ph">${ph}${units > 1 ? `<span class="units" title="יחידות במק״ט הזה">${units} יח׳</span>` : ''}</div>
      <div class="meta">
        <h3>${highlight(it.name, q)}</h3>
        <div class="codes">
          <button type="button" class="sku" data-copy="${esc(it.sku)}" title="העתקת מק״ט"><span class="t">${highlight(it.sku, q)}</span>${COPY_ICON}</button>
          ${it.url ? `<a class="link-btn" href="${esc(it.url)}" target="_blank" rel="noopener noreferrer" title="${esc(it.url)}" aria-label="פתיחת קישור">${LINK_ICON}</a>` : ''}
        </div>
        <div class="unit"><span class="lbl">ID</span><button type="button" class="unit-id" data-copy="${esc(it.unitId)}" title="העתקת ID">${highlight(it.unitId, q)}</button></div>
      </div>
    </article>`;
  }).join('');
}

/* ---------------- Editor ---------------- */

function openEditor(item = null, prefill = null) {
  editing = item;
  el.form.reset();
  el.formTitle.textContent = item ? 'עריכת פריט' : prefill ? 'יחידה נוספת' : 'פריט חדש';
  el.del.hidden = el.clone.hidden = !item;
  disarmDelete();
  const src = item || prefill;
  el.name.value = src?.name || '';
  el.sku.value = src?.sku || '';
  el.url.value = src?.url || '';
  el.unit.value = item?.unitId || '';
  if (item) setDraftPhoto('keep');
  else if (prefill?.photo) setDraftPhoto({ from: prefill.id, hash: prefill.photoHash, url: photoUrl(prefill) });
  else setDraftPhoto('clear');
  if (prefill) el.unit.value = nextUnitId(prefill.sku);
  el.editor.showModal();
  validate();
  if (!item) (prefill ? el.unit : el.name).focus();
}

function closeEditor() { el.editor.close(); }

el.editor.addEventListener('close', () => {
  if (el.editor.open) return; // the close event is async; another item may already be open
  setDraftPhoto('clear');
  editing = null;
});

function setDraftPhoto(photo) {
  if (draft.photo?.blob) URL.revokeObjectURL(draft.photo.url);
  draft = { photo };
  const url = photo === 'keep' ? photoUrl(editing) : photo === 'clear' ? null : photo.url;
  el.preview.hidden = !url;
  if (url) el.preview.src = url; else el.preview.removeAttribute('src');
  el.drop.classList.toggle('has-photo', !!url);
  el.clearPhoto.hidden = !url;
}

const draftHash = () => draft.photo === 'keep' ? editing?.photoHash : draft.photo === 'clear' ? null : draft.photo.hash;

async function acceptFile(file) {
  if (!file) return;
  el.dropBusy.hidden = false;
  try {
    const { blob, hash } = await processImage(file);
    setDraftPhoto({ blob, hash, url: URL.createObjectURL(blob) });
    validate();
  } catch (err) {
    toast(err.message, { bad: true });
  } finally {
    el.dropBusy.hidden = true;
  }
}

function itemLine(prefix, it, { jump = true } = {}) {
  const url = photoUrl(it);
  const thumb = url ? `<img class="thumb" src="${url}" alt="">` : '';
  const btn = jump ? ` <button type="button" class="link" data-jump="${it.id}">פתיחה</button>` : '';
  return `${thumb}<span>${prefix} <b>${esc(it.name)}</b> · <span class="code">${esc(it.sku)}</span> · <span class="code">${esc(it.unitId)}</span>${btn}</span>`;
}

function setField(field, msgEl, state, html = '') {
  field.classList.remove('ok', 'bad', 'warn', 'info');
  if (state) field.classList.add(state);
  msgEl.className = 'msg' + (state ? ' ' + state : '');
  msgEl.innerHTML = html;
}

// Returns true when the form can be saved.
function validate() {
  const name = clean(el.name.value), sku = clean(el.sku.value), unitId = clean(el.unit.value);
  const c = findConflicts(items, { name, sku, unitId, photoHash: draftHash() }, editing);
  const sib = c.siblings;
  const renaming = editing && codeKey(sku) === editing.skuKey && nameKey(name) && nameKey(name) !== editing.nameKey;

  // Name
  if (!name) setField(el.nameField, el.nameMsg, null);
  else if (c.name) setField(el.nameField, el.nameMsg, 'bad', itemLine('השם כבר שייך למק״ט אחר:', c.name));
  else if (renaming && sib.length) setField(el.nameField, el.nameMsg, 'info', `השם יעודכן גם ב־${sib.length} היחידות האחרות של מק״ט זה`);
  else if (c.similar) setField(el.nameField, el.nameMsg, 'warn', itemLine('שם דומה מאוד קיים:', c.similar));
  else setField(el.nameField, el.nameMsg, 'ok');

  // מק״ט
  if (!sku) setField(el.skuField, el.skuMsg, null);
  else if (!codeKey(sku)) setField(el.skuField, el.skuMsg, 'bad', 'מק״ט חייב לכלול אותיות או ספרות');
  else if (c.sku) setField(el.skuField, el.skuMsg, 'bad',
    `<span>המק״ט רשום בשם <b>${esc(c.sku.name)}</b></span> <button type="button" class="link" data-use-name="${c.sku.id}">שימוש בשם הזה</button>`);
  else if (sib.length) {
    const ref = sib[0];
    const fill = !editing && (!name || (draft.photo === 'clear' && ref.photo))
      ? ` <button type="button" class="link" data-fill="${ref.id}">מילוי פרטים</button>` : '';
    setField(el.skuField, el.skuMsg, 'info', `<span>מק״ט קיים · ${sib.length === 1 ? 'יחידה אחת' : sib.length + ' יחידות'}</span>${fill}`);
  }
  else setField(el.skuField, el.skuMsg, 'ok', 'מק״ט חדש');

  // ID
  if (!unitId) setField(el.unitField, el.unitMsg, null);
  else if (!codeKey(unitId)) setField(el.unitField, el.unitMsg, 'bad', 'ID חייב לכלול אותיות או ספרות');
  else if (c.unit) setField(el.unitField, el.unitMsg, 'bad', itemLine('ה־ID כבר קיים:', c.unit));
  else setField(el.unitField, el.unitMsg, 'ok', 'ID פנוי');

  // Link
  const url = normalizeUrl(el.url.value);
  if (!clean(el.url.value)) setField(el.urlField, el.urlMsg, null);
  else if (url === null) setField(el.urlField, el.urlMsg, 'bad', 'קישור לא תקין');
  else setField(el.urlField, el.urlMsg, 'ok');

  // Photo
  el.drop.classList.toggle('bad', !!c.photo);
  el.photoMsg.className = 'msg' + (c.photo ? ' bad' : '');
  el.photoMsg.innerHTML = c.photo ? itemLine('התמונה כבר שייכת למק״ט אחר:', c.photo) : '';

  const ok = !!nameKey(name) && !!codeKey(sku) && !!codeKey(unitId) && url !== null && !c.blocked;
  el.save.disabled = !ok || saving;
  return ok;
}

function shake(field) {
  field.classList.remove('shake');
  void field.offsetWidth;
  field.classList.add('shake');
}

function focusFirstProblem() {
  for (const [field, input] of [[el.nameField, el.name], [el.skuField, el.sku], [el.unitField, el.unit], [el.urlField, el.url]]) {
    if (!clean(input.value) && input !== el.url || field.classList.contains('bad')) { shake(field); input.focus(); return; }
  }
  if (el.drop.classList.contains('bad')) shake(el.drop);
}

async function save(e) {
  e.preventDefault();
  if (saving) return;
  if (!validate()) return focusFirstProblem();

  const body = {
    name: el.name.value, sku: el.sku.value, unitId: el.unit.value, url: el.url.value,
  };
  const p = draft.photo;
  if (p === 'clear') body.photo = null;
  else if (p?.from) body.photo = { from: p.from };
  else if (p?.blob) body.photo = { data: await blobToBase64(p.blob), type: p.blob.type, hash: p.hash };

  saving = true;
  el.save.disabled = true;
  el.save.textContent = 'שומר…';
  const wasEditing = !!editing;
  try {
    const { item } = await api(editing ? `/api/items?id=${editing.id}` : '/api/items', {
      method: editing ? 'PUT' : 'POST', body: JSON.stringify(body),
    });
    closeEditor();
    await reload();
    flashCard(item.id);
    toast(wasEditing ? 'הפריט עודכן' : 'הפריט נוסף');
  } catch (err) {
    if (err.status === 409) {
      // Someone else saved a conflicting item in the meantime; refresh and show it.
      await reload();
      toast('נחסם: ' + describeConflicts(err.data?.conflicts), { bad: true });
    } else {
      toast('השמירה נכשלה: ' + err.message, { bad: true });
    }
  } finally {
    saving = false;
    el.save.textContent = 'שמירה';
    if (el.editor.open) validate();
  }
}

function describeConflicts(c = {}) {
  if (c.unit) return `ה־ID ${c.unit.unitId} כבר קיים`;
  if (c.name) return `השם כבר שייך למק״ט ${c.name.sku}`;
  if (c.sku) return `המק״ט רשום בשם ${c.sku.name}`;
  if (c.photo) return `התמונה כבר שייכת למק״ט ${c.photo.sku}`;
  return 'פריט כפול';
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
  try {
    await api(`/api/items?id=${item.id}`, { method: 'DELETE' });
    toast(`${item.name} · ${item.unitId} נמחק`);
  } catch (err) {
    toast('המחיקה נכשלה: ' + err.message, { bad: true });
  }
  await reload();
}

/* ---------------- Code generators ---------------- */

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

// Units of מק״ט "EVO-DRONE" get IDs EVO-DRONE-001, EVO-DRONE-002, …
function nextUnitId(sku) {
  const base = clean(sku).toUpperCase().replace(/\s+/g, '-') || 'ID';
  const taken = new Set(items.map(i => i.unitKey));
  let n = 1;
  while (taken.has(codeKey(`${base}-${String(n).padStart(3, '0')}`))) n++;
  return `${base}-${String(n).padStart(3, '0')}`;
}

/* ---------------- Export ---------------- */

function exportCsv() {
  if (!items.length) return toast('אין פריטים לייצוא');
  const cell = v => /[",\n\r]/.test(v = String(v ?? '')) ? `"${v.replace(/"/g, '""')}"` : v;
  const rows = [['שם', 'מק״ט', 'ID', 'קישור', 'תמונה', 'נוסף בתאריך']];
  for (const it of [...items].sort((a, b) => a.sku.localeCompare(b.sku) || a.unitId.localeCompare(b.unitId))) {
    rows.push([it.name, it.sku, it.unitId, it.url, it.photo ? new URL(photoUrl(it), location.origin).href : '',
      new Date(it.createdAt).toLocaleDateString('he-IL')]);
  }
  // BOM so Excel opens the Hebrew correctly
  const csv = '﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `maktshulam-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`יוצאו ${items.length} פריטים לקובץ אקסל`);
}

/* ---------------- Toasts & misc ---------------- */

function toast(text, { bad = false, ms = 4200 } = {}) {
  const t = document.createElement('div');
  t.className = 'toast' + (bad ? ' bad' : '');
  t.setAttribute('role', bad ? 'alert' : 'status');
  t.innerHTML = `<span>${esc(text)}</span>`;
  el.toasts.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 200); }, ms);
}

function flashCard(id) {
  const card = el.grid.querySelector(`[data-id="${id}"]`);
  if (!card) return;
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  card.classList.add('flash');
  setTimeout(() => card.classList.remove('flash'), 1400);
}

/* ---------------- Events ---------------- */

function bind() {
  $('#addBtn').addEventListener('click', () => openEditor());
  document.addEventListener('click', e => {
    if (e.target.closest('[data-action="add"]')) openEditor();
  });
  el.exportBtn.addEventListener('click', exportCsv);
  el.search.addEventListener('input', render);

  el.grid.addEventListener('click', async e => {
    if (e.target.closest('.link-btn')) return;
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      try { await navigator.clipboard.writeText(copy.dataset.copy); } catch { return; }
      copy.classList.add('copied');
      setTimeout(() => copy.classList.remove('copied'), 1100);
      return;
    }
    const card = e.target.closest('.card[data-id]');
    if (card) openEditor(items.find(i => i.id === card.dataset.id));
  });
  el.grid.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.matches('.card[data-id]')) openEditor(items.find(i => i.id === e.target.dataset.id));
  });

  el.form.addEventListener('submit', save);
  el.form.addEventListener('click', e => {
    if (e.target.closest('[data-close]')) return closeEditor();
    const t = e.target.closest('[data-jump],[data-use-name],[data-fill]');
    if (!t) return;
    const ref = items.find(i => i.id === (t.dataset.jump || t.dataset.useName || t.dataset.fill));
    if (!ref) return;
    if (t.dataset.jump) { closeEditor(); openEditor(ref); return; }
    el.name.value = ref.name;
    if (t.dataset.fill) {
      el.sku.value = ref.sku;
      if (!clean(el.url.value)) el.url.value = ref.url;
      if (draft.photo === 'clear' && ref.photo) setDraftPhoto({ from: ref.id, hash: ref.photoHash, url: photoUrl(ref) });
      if (!clean(el.unit.value)) el.unit.value = nextUnitId(ref.sku);
    }
    validate();
  });
  el.editor.addEventListener('click', e => { if (e.target === el.editor) closeEditor(); });

  for (const input of [el.name, el.sku, el.unit, el.url]) input.addEventListener('input', validate);
  el.url.addEventListener('blur', () => { const u = normalizeUrl(el.url.value); if (u) el.url.value = u; });
  el.genSku.addEventListener('click', () => { el.sku.value = nextSku(); validate(); el.sku.focus(); });
  el.genUnit.addEventListener('click', () => { el.unit.value = nextUnitId(el.sku.value); validate(); el.unit.focus(); });
  el.del.addEventListener('click', onDelete);
  el.clone.addEventListener('click', () => {
    const src = editing;
    closeEditor();
    openEditor(null, src);
  });

  el.drop.addEventListener('click', e => {
    if (e.target === el.clearPhoto) return;
    el.photo.click();
  });
  el.drop.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.photo.click(); }
  });
  el.clearPhoto.addEventListener('click', e => {
    e.stopPropagation();
    setDraftPhoto('clear');
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
  });

  const top = $('.top');
  addEventListener('scroll', () => top.classList.toggle('scrolled', scrollY > 4), { passive: true });

  // Pick up changes made by others
  document.addEventListener('visibilitychange', () => { if (!document.hidden) reload(); });
  setInterval(() => { if (!document.hidden && !saving) reload(); }, REFRESH_MS);
}

bind();
render();
reload();
