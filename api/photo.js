import { pool, isUuid } from './_db.js';

// Photos are addressed as /api/photo?id=…&v=…; v changes whenever the photo
// does, so each URL can be cached forever.
export default async function handler(req, res) {
  if (!isUuid(req.query.id)) return res.status(400).end();
  const db = pool();
  try {
    const { rows } = await db.query('select photo, photo_type from items where id = $1 and photo is not null', [req.query.id]);
    if (!rows[0]) return res.status(404).end();
    res.setHeader('Content-Type', rows[0].photo_type);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.send(rows[0].photo);
  } catch (err) {
    console.error(err);
    return res.status(500).end();
  } finally {
    await db.end();
  }
}
