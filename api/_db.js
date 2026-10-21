import { Pool } from '@neondatabase/serverless';

export const pool = () => new Pool({ connectionString: process.env.DATABASE_URL });

export const isUuid = s => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export const ITEM_COLS = `id, name, name_key, sku, sku_key, unit_id, unit_key, url, photo_hash, photo_v,
  (photo is not null) as has_photo, created_at`;

export const toItem = r => ({
  id: r.id, name: r.name, sku: r.sku, unitId: r.unit_id, url: r.url || '',
  nameKey: r.name_key, skuKey: r.sku_key, unitKey: r.unit_key,
  photo: r.has_photo, photoV: r.photo_v, photoHash: r.photo_hash,
  createdAt: new Date(r.created_at).getTime(),
});

export const brief = it => it && { id: it.id, name: it.name, sku: it.sku, unitId: it.unitId };
