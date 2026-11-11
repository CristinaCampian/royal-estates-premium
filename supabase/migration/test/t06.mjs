import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const dir = fileURLToPath(new URL('../', import.meta.url));   // supabase/migration/
const up = fs.readFileSync(dir + '06-locked-teasers.sql', 'utf8');
const down = fs.readFileSync(dir + '06-rollback.sql', 'utf8');
const db = new PGlite();
let n = 0, bad = 0;
const ok = (name, c) => { n++; if (c) console.log('PASS  ' + name); else { bad++; console.log('FAIL  ' + name); } };
const q = async s => (await db.query(s)).rows;

await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create table public.properties (id bigint primary key, created_at timestamptz default now(), title text, type text, location text,
    price text, active boolean default true, is_locked boolean default false, details jsonb, images text[]);
  insert into public.properties (id,title,type,location,price,is_locked,details,images) values
   (1,'Secret Villa','villa','Casal Novo','2000000',true,'{}','{a.jpg}'),
   (2,'Public flat','apartment','Lisbon','500000',false,'{}','{b.jpg}'),
   (3,'Off market quinta','quinta','Somewhere','9000000',true,'{"off_market":true}','{c.jpg}'),
   (4,'Inactive','villa','X','1',true,'{}','{d.jpg}');
  create view public.locked_teasers as select id, created_at from public.properties
    where active and is_locked and coalesce((details ->> 'off_market')::boolean,false)=false;
  grant select on public.locked_teasers to anon, authenticated;
  update public.properties set active=false where id=4;
`);
await db.exec(up);
await db.exec(up); // re-runnable
ok('step 6 runs and can be run twice', true);

let r = await q(`select * from public.locked_teasers order by id`);
ok('same rows as before: only the active, locked, not-off-market listing (id 1)', r.length === 1 && String(r[0].id) === '1');
ok('view keeps id, created_at first, then type, teaser_area, teaser_image', Object.keys(r[0]).join(',') === 'id,created_at,type,teaser_area,teaser_image');
ok('type is exposed (villa), area and image are null until set', r[0].type === 'villa' && r[0].teaser_area === null && r[0].teaser_image === null);

await db.exec(`update public.properties set teaser_area='Silver Coast', teaser_image='teaser/abc-123.webp' where id=1`);
r = await q(`select * from public.locked_teasers`);
ok('area label and teaser image appear once set', r[0].teaser_area === 'Silver Coast' && r[0].teaser_image === 'teaser/abc-123.webp');
ok('title, location, price and photos are NOT in the view', !('title' in r[0]) && !('location' in r[0]) && !('price' in r[0]) && !('images' in r[0]));

await db.exec(`update public.properties set teaser_on=false where id=1`);
r = await q(`select * from public.locked_teasers`);
ok('teaser_on=false hides type, area and image (the card is back to a bare lock)', r.length === 1 && r[0].type === null && r[0].teaser_area === null && r[0].teaser_image === null);
await db.exec(`update public.properties set teaser_on=true where id=1`);

const fails = async s => { try { await db.exec(s); return false; } catch (e) { return true; } };
ok('guard: image outside teaser/ is rejected (cannot point at a real photo)', await fails(`update public.properties set teaser_image='a.jpg' where id=1`));
ok('guard: path tricks are rejected', await fails(`update public.properties set teaser_image='teaser/../a.webp' where id=1`) && await fails(`update public.properties set teaser_image='teaser/x.jpg' where id=1`));
ok('guard: area label over 60 characters is rejected', await fails(`update public.properties set teaser_area='${'x'.repeat(61)}' where id=1`));

// anonymous access: only the view columns, nothing else
await db.exec(`grant select on public.locked_teasers to anon; set role anon;`);
let anonOk = true; try { await db.query(`select id,type,teaser_area,teaser_image from public.locked_teasers`); } catch (e) { anonOk = false; }
let anonProps = true; try { await db.query(`select title from public.properties`); } catch (e) { anonProps = false; }
await db.exec(`reset role;`);
ok('anon can read the view', anonOk);
ok('anon cannot read properties directly in this test DB (no grant)', anonProps === false);

// existing site queries still work (old column list)
r = await q(`select id,created_at from public.locked_teasers`);
ok('the current site (selects id,created_at only) still works', r.length === 1);

// rollback
await db.exec(down); await db.exec(down);
r = await q(`select * from public.locked_teasers`);
ok('rollback restores the 2-column view and is re-runnable', Object.keys(r[0]).join(',') === 'id,created_at');
await db.exec(up);
r = await q(`select * from public.locked_teasers`);
ok('step 6 can be applied again after a rollback', Object.keys(r[0]).includes('teaser_area'));
console.log(`--- ${n - bad} of ${n} passed`);
process.exit(bad ? 1 : 0);
