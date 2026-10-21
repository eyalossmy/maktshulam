// Duplicate rules shared by the browser (live checks) and the API (final say).
//
// Catalog model: an מק״ט is a product type with one name; each unit of it has
// its own ID. So:
//   - ID is unique across everything.
//   - A name belongs to exactly one מק״ט, and an מק״ט has exactly one name.
//   - The same photo may be reused by units of one מק״ט, never across מק״טים.

export const PHOTO_HAMMING_MAX = 4;
export const NAME_SIMILAR_MAX = 1;

const stripMarks = s => s.normalize('NFKD').replace(/[֑-ׇ̀-ͯ]/g, '');

export const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();

// "כוס  זכוכית" / "כוס-זכוכית" / "כּוֹס זכוכית" all map to the same key
export function nameKey(name) {
  return stripMarks(clean(name)).toLowerCase()
    .replace(/[״"'`׳\-_.,:;/\\()[\]{}|+*!?]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// "mk-100 24" / "MK10024" / "Mk.10024" all map to the same key (used for מק״ט and ID)
export function codeKey(code) {
  return stripMarks(clean(code)).toUpperCase().replace(/[\s\-_./\\|]/g, '');
}

export function normalizeUrl(raw) {
  const s = clean(raw);
  if (!s) return '';
  try {
    const u = new URL(/^[a-z][a-z\d+.-]*:/i.test(s) ? s : 'https://' + s);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return null;
    return u.href;
  } catch { return null; }
}

export function levenshtein(a, b, cap) {
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

// Photo fingerprints are either a 16-char perceptual hash (compared loosely)
// or "x" + SHA-256 for low-detail images (compared exactly).
export function samePhoto(a, b) {
  if (!a || !b) return false;
  if (a.length === 16 && b.length === 16) return popcount(BigInt('0x' + a) ^ BigInt('0x' + b)) <= PHOTO_HAMMING_MAX;
  return a === b;
}

export const isPhotoHash = h => typeof h === 'string' && /^([0-9a-f]{16}|x[0-9a-f]{64})$/.test(h);

/**
 * list:    items with { id, nameKey, skuKey, unitKey, photoHash }
 * draft:   { name, sku, unitId, photoHash }
 * self:    the item being edited (or null). Editing the name of an existing מק״ט
 *          renames all of its units, so its siblings are not a conflict.
 * Returns blocking conflicts (unit, name, sku, photo) and hints (similar, siblings).
 */
export function findConflicts(list, draft, self = null) {
  const nk = nameKey(draft.name), sk = codeKey(draft.sku), uk = codeKey(draft.unitId);
  const renaming = !!self && sk === self.skuKey;
  const out = { unit: null, name: null, sku: null, photo: null, similar: null, siblings: [] };
  for (const it of list) {
    if (self && it.id === self.id) continue;
    const sameSku = sk && it.skuKey === sk;
    if (sameSku) out.siblings.push(it);
    if (uk && it.unitKey === uk) out.unit ??= it;
    if (nk && it.nameKey === nk && !sameSku) out.name ??= it;
    if (sameSku && nk && it.nameKey !== nk && !renaming) out.sku ??= it;
    if (nk.length >= 4 && !sameSku && it.nameKey !== nk && !out.similar
      && levenshtein(nk, it.nameKey, NAME_SIMILAR_MAX) <= NAME_SIMILAR_MAX) out.similar = it;
    if (draft.photoHash && !sameSku && samePhoto(draft.photoHash, it.photoHash)) out.photo ??= it;
  }
  out.blocked = !!(out.unit || out.name || out.sku || out.photo);
  return out;
}
