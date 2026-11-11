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
const fails = async s => { try { await db.exec(s); return false; } catch (e) { return true; } };
const asAnon = async (s) => { await db.exec('set role anon'); try { return { rows: (await db.query(s)).rows }; } catch (e) { return { err: String(e.message || e) }; } finally { await db.exec('reset role'); } };
const priv = async (role, rel, p) => (await q(`select has_table_privilege('${role}','${rel}','${p}') v`))[0].v;

// a database shaped like the live one: Supabase's default grants (anon/authenticated get everything), RLS on, the live policy
await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create table public.properties (id bigint primary key, created_at timestamptz default now(), title text, type text, location text,
    price text, active boolean default true, is_locked boolean default false, details jsonb, images text[], description text);
  grant all on public.properties to anon, authenticated;
  alter table public.properties enable row level security;
  create policy "public listings" on public.properties for select to anon, authenticated
    using (active and not is_locked and coalesce((details->>'off_market')::boolean,false)=false);
  insert into public.properties (id,title,type,location,price,is_locked,details,images,description,active) values
   (1,'Secret Villa','villa','Casal Novo','2000000',true,'{}','{a.jpg}','secret text',true),
   (2,'Public flat','apartment','Lisbon','500000',false,'{}','{b.jpg}','public text',true),
   (3,'Off market quinta','quinta','Somewhere','9000000',true,'{"off_market":true}','{c.jpg}','x',true),
   (4,'Inactive locked','villa','X','1',true,'{}','{d.jpg}','x',false);
  create view public.locked_teasers as select id, created_at from public.properties
    where active and is_locked and coalesce((details ->> 'off_market')::boolean,false)=false;
  revoke all on public.locked_teasers from public, anon, authenticated;
  grant select on public.locked_teasers to anon, authenticated;
`);
await db.exec(up);
await db.exec(up);
ok('step 6 runs, and can be run twice', true);

// ── 3. the view: exactly five columns, exactly the right rows
const cols = (await q(`select column_name from information_schema.columns where table_schema='public' and table_name='locked_teasers' order by ordinal_position`)).map(r => r.column_name).join(',');
ok('view exposes exactly: id, created_at, type, teaser_area, teaser_image (' + cols + ')', cols === 'id,created_at,type,teaser_area,teaser_image');
for (const c of ['title', 'location', 'price', 'description', 'images', 'password', 'code', 'details', 'is_locked', 'active']) {
  const r = await asAnon(`select ${c} from public.locked_teasers`);
  ok(`anon cannot select "${c}" from the view`, !!r.err);
}
let r = await asAnon(`select * from public.locked_teasers order by id`);
ok('anon sees only the locked, active, not-off-market listing (id 1)', r.rows && r.rows.length === 1 && String(r.rows[0].id) === '1');
r = await asAnon(`select id from public.locked_teasers where id in (3,4)`);
ok('off-market (3) and inactive (4) listings cannot be fetched even by asking for them by id', r.rows && r.rows.length === 0);
r = await asAnon(`select id from public.locked_teasers where id = 1 or true`);
ok('a filter like "or true" cannot widen the result (still 1 row)', r.rows && r.rows.length === 1);
r = await asAnon(`select id from public.locked_teasers where is_locked = false`);
ok('filters on hidden columns (is_locked, details, active) are rejected', !!r.err);

// ── 3. grants
ok('anon: SELECT on the view', await priv('anon', 'public.locked_teasers', 'SELECT'));
ok('anon: no INSERT/UPDATE/DELETE/TRUNCATE on the view', !(await priv('anon', 'public.locked_teasers', 'INSERT')) && !(await priv('anon', 'public.locked_teasers', 'UPDATE')) && !(await priv('anon', 'public.locked_teasers', 'DELETE')) && !(await priv('anon', 'public.locked_teasers', 'TRUNCATE')));
ok('anon keeps SELECT on properties (the site reads public listings there; RLS limits the rows)', await priv('anon', 'public.properties', 'SELECT'));
ok('anon has NO insert/update/delete/truncate/references/trigger on properties', !(await priv('anon', 'public.properties', 'INSERT')) && !(await priv('anon', 'public.properties', 'UPDATE')) && !(await priv('anon', 'public.properties', 'DELETE')) && !(await priv('anon', 'public.properties', 'TRUNCATE')) && !(await priv('anon', 'public.properties', 'REFERENCES')) && !(await priv('anon', 'public.properties', 'TRIGGER')));
r = await asAnon(`truncate public.properties`); ok('anon cannot TRUNCATE properties', !!r.err);
r = await asAnon(`insert into public.properties (id,title) values (99,'x')`); ok('anon cannot INSERT into properties', !!r.err);
r = await asAnon(`select id, title, teaser_image from public.properties order by id`);
ok('anon reading properties directly still sees only the public listing (id 2), never locked rows', r.rows && r.rows.length === 1 && String(r.rows[0].id) === '2');
ok('authenticated is unchanged (admin writes go through RLS)', await priv('authenticated', 'public.properties', 'UPDATE'));

// ── 2. teaser_on
await db.exec(`update public.properties set teaser_area='Silver Coast', teaser_image='teaser/abc-123.webp' where id=1`);
r = await asAnon(`select * from public.locked_teasers`);
ok('area label and teaser image appear once set', r.rows[0].teaser_area === 'Silver Coast' && r.rows[0].teaser_image === 'teaser/abc-123.webp' && r.rows[0].type === 'villa');
await db.exec(`update public.properties set teaser_on=false where id=1`);
r = await asAnon(`select * from public.locked_teasers`);
ok('teaser_on=false: type, area and image are ALL null (the card is only a lock; the row itself stays so the card can still be unlocked)', r.rows.length === 1 && r.rows[0].type === null && r.rows[0].teaser_area === null && r.rows[0].teaser_image === null);
ok('teaser_on defaults to ON for listings that existed before', (await q(`select teaser_on from public.properties where id=2`))[0].teaser_on === true);
await db.exec(`update public.properties set teaser_on=true where id=1`);

// ── 4. teaser_image constraint
const bad_paths = ['a.jpg', 'teaser/../a.webp', 'teaser/x.jpg', 'teaser/x.webp.jpg', 'teaser/sub/x.webp', '/teaser/x.webp', 'teaser//x.webp', 'Teaser/x.webp',
  'teaser/x.WEBP', 'teaser/x.webp\n', 'teaser/x.webp ', 'teaser/x y.webp', 'teaser/%2e%2e/x.webp', '..teaser/x.webp', 'teaser/.webp', 'http://evil.example/teaser/x.webp',
  'property/teaser/x.webp', 'teaser/..%2fx.webp', 'teaser\\x.webp', '_backup/teaser/x.webp', ''];
let allRejected = true, which = [];
for (const pth of bad_paths) {
  const lit = "E'" + pth.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/\n/g, '\\n') + "'";
  if (!(await fails(`update public.properties set teaser_image=${lit} where id=1`))) { allRejected = false; which.push(JSON.stringify(pth)); }
}
ok(`constraint rejects all ${bad_paths.length} bad paths (outside teaser/, not .webp, ../ tricks, sub-folders, encoded dots, newline, URL)` + (which.length ? ' — ACCEPTED: ' + which.join(' ') : ''), allRejected);
ok('constraint accepts the exact kind of path the admin makes', !(await fails(`update public.properties set teaser_image='teaser/t-mwclt6u9-zyerea.webp' where id=1`)));
ok('constraint accepts NULL', !(await fails(`update public.properties set teaser_image=null where id=1`)));
ok('guard: area label over 60 characters is rejected', await fails(`update public.properties set teaser_area='${'x'.repeat(61)}' where id=1`));

// the current site's query still works
r = await asAnon(`select id,created_at from public.locked_teasers`);
ok('the current site (selects id,created_at only) still works', r.rows && r.rows.length === 1);

// ── rollback
await db.exec(down); await db.exec(down);
r = await asAnon(`select * from public.locked_teasers`);
ok('rollback: view is back to id, created_at; re-runnable', r.rows && Object.keys(r.rows[0]).join(',') === 'id,created_at');
ok('rollback: anon privileges on properties are back to the Supabase defaults', await priv('anon', 'public.properties', 'INSERT'));
await db.exec(up);
ok('step 6 can be applied again after a rollback', Object.keys((await asAnon(`select * from public.locked_teasers`)).rows[0]).includes('teaser_area'));
console.log(`--- ${n - bad} of ${n} passed`);
process.exit(bad ? 1 : 0);
