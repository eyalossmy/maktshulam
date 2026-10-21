// Creates the schema. Run once per database:
//   node --env-file=.env.local scripts/migrate.mjs
import { Pool } from '@neondatabase/serverless';

const db = new Pool({ connectionString: process.env.DATABASE_URL });
await db.query(`
  create table if not exists items (
    id          uuid primary key default gen_random_uuid(),
    name        text not null,
    name_key    text not null,
    sku         text not null,
    sku_key     text not null,
    unit_id     text not null,
    unit_key    text not null unique,
    url         text,
    photo       bytea,
    photo_type  text,
    photo_hash  text,
    photo_v     int not null default 0,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
  );
  create index if not exists items_sku_key on items (sku_key);
  create index if not exists items_name_key on items (name_key);
`);
await db.end();
console.log('schema ready');
