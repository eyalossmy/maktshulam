import { pool, isUuid, ITEM_COLS, toItem, brief } from './_db.js';
import { clean, nameKey, codeKey, normalizeUrl, isPhotoHash, findConflicts } from '../lib/rules.js';

const PHOTO_TYPES = new Set(['image/webp', 'image/jpeg', 'image/png']);
const PHOTO_MAX_BYTES = 1.5 * 1024 * 1024;

const fail = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const db = pool();
  try {
    if (req.method === 'GET') {
      const { rows } = await db.query(`select ${ITEM_COLS} from items order by created_at desc`);
      return res.json({ items: rows.map(toItem) });
    }
    if (req.method === 'DELETE') {
      if (!isUuid(req.query.id)) return fail(res, 400, 'מזהה פריט לא תקין');
      const { rowCount } = await db.query('delete from items where id = $1', [req.query.id]);
      return rowCount ? res.json({ ok: true }) : fail(res, 404, 'הפריט לא נמצא');
    }
    if (req.method === 'POST' || req.method === 'PUT') return await save(db, req, res);
    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return fail(res, 405, 'Method not allowed');
  } catch (err) {
    console.error(err);
    if (err.code === '23505') return fail(res, 409, 'ה־ID כבר קיים', { conflicts: {} });
    return fail(res, 500, 'שגיאת שרת');
  } finally {
    await db.end();
  }
}

async function save(db, req, res) {
  const editId = req.method === 'PUT' ? req.query.id : null;
  if (req.method === 'PUT' && !isUuid(editId)) return fail(res, 400, 'מזהה פריט לא תקין');

  const b = req.body || {};
  const name = clean(b.name), sku = clean(b.sku).toUpperCase(), unitId = clean(b.unitId).toUpperCase();
  const nk = nameKey(name), sk = codeKey(sku), uk = codeKey(unitId);
  if (!nk || name.length > 80) return fail(res, 400, 'שם לא תקין', { field: 'name' });
  if (!sk || sku.length > 40) return fail(res, 400, 'מק״ט לא תקין', { field: 'sku' });
  if (!uk || unitId.length > 40) return fail(res, 400, 'ID לא תקין', { field: 'unitId' });
  const url = normalizeUrl(b.url);
  if (url === null || url.length > 500) return fail(res, 400, 'קישור לא תקין', { field: 'url' });

  // photo: "keep" (default on edit) | "clear" | { data, type, hash } | { from: itemId }
  let photo = req.method === 'POST' ? 'clear' : 'keep';
  if (b.photo === null) photo = 'clear';
  else if (b.photo?.from) {
    if (!isUuid(b.photo.from)) return fail(res, 400, 'תמונה לא תקינה');
    photo = { from: b.photo.from };
  } else if (b.photo?.data) {
    const data = Buffer.from(String(b.photo.data), 'base64');
    if (!PHOTO_TYPES.has(b.photo.type) || !isPhotoHash(b.photo.hash) || !data.length || data.length > PHOTO_MAX_BYTES) {
      return fail(res, 400, 'תמונה לא תקינה', { field: 'photo' });
    }
    photo = { data, type: b.photo.type, hash: b.photo.hash };
  }

  const client = await db.connect();
  try {
    await client.query('begin');
    // One writer at a time, so two people can't slip the same ID in together.
    await client.query('select pg_advisory_xact_lock(7311)');

    const all = (await client.query(`select ${ITEM_COLS} from items`)).rows.map(toItem);
    const self = editId ? all.find(i => i.id === editId) : null;
    if (editId && !self) { await client.query('rollback'); return fail(res, 404, 'הפריט לא נמצא'); }

    if (photo.from) {
      const src = (await client.query('select photo, photo_type, photo_hash from items where id = $1 and photo is not null', [photo.from])).rows[0];
      photo = src ? { data: src.photo, type: src.photo_type, hash: src.photo_hash } : 'clear';
    }
    const photoHash = photo === 'keep' ? self?.photoHash : photo === 'clear' ? null : photo.hash;

    const c = findConflicts(all, { name, sku, unitId, photoHash }, self);
    if (c.blocked) {
      await client.query('rollback');
      return fail(res, 409, 'כפילות נחסמה', {
        conflicts: { unit: brief(c.unit), name: brief(c.name), sku: brief(c.sku), photo: brief(c.photo) },
      });
    }

    // "EVO DRONE" joining existing "EVO-DRONE" keeps the existing spelling
    const base = [name, nk, c.siblings[0]?.sku || sku, sk, unitId, uk, url || null];
    let row;
    if (!editId) {
      const p = photo === 'clear' ? [null, null, null] : [photo.data, photo.type, photo.hash];
      row = (await client.query(
        `insert into items (name, name_key, sku, sku_key, unit_id, unit_key, url, photo, photo_type, photo_hash, photo_v)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, case when $8::bytea is null then 0 else 1 end)
         returning ${ITEM_COLS}`, [...base, ...p])).rows[0];
    } else {
      const setPhoto = photo === 'keep' ? '' : `, photo = $9, photo_type = $10, photo_hash = $11, photo_v = photo_v + 1`;
      const p = photo === 'keep' ? [] : photo === 'clear' ? [null, null, null] : [photo.data, photo.type, photo.hash];
      row = (await client.query(
        `update items set name = $1, name_key = $2, sku = $3, sku_key = $4, unit_id = $5, unit_key = $6, url = $7,
           updated_at = now()${setPhoto}
         where id = $8 returning ${ITEM_COLS}`, [...base, editId, ...p])).rows[0];
      // The name belongs to the מק״ט: renaming one unit renames all of its units.
      if (self.skuKey === sk && self.nameKey !== nk) {
        await client.query('update items set name = $1, name_key = $2, updated_at = now() where sku_key = $3 and id <> $4', [name, nk, sk, editId]);
      }
    }
    await client.query('commit');
    return res.status(editId ? 200 : 201).json({ item: toItem(row) });
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
