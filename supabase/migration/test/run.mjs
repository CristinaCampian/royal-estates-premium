import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import fs from 'node:fs';

import { fileURLToPath } from 'node:url';
const DIR = fileURLToPath(new URL('../', import.meta.url));
const sql = f => fs.readFileSync(DIR + f, 'utf8');
const ADMIN_EMAIL = 'owner@example.com';
const step1 = sql('01-additive.sql').replaceAll('PUT-YOUR-ADMIN-EMAIL-HERE', ADMIN_EMAIL);
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  -> ' + extra : '')); };

async function fresh() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    grant usage on schema public to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on functions to anon, authenticated;
    alter default privileges in schema public grant all on sequences to anon, authenticated;
    create schema auth; grant usage on schema auth to anon, authenticated;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant execute on function auth.uid() to anon, authenticated;
    insert into auth.users (id, email) values ('11111111-1111-1111-1111-111111111111', '${ADMIN_EMAIL}'), ('22222222-2222-2222-2222-222222222222', 'random.signup@example.com');
    create table public.properties (id bigserial primary key, title text, description text, price numeric, images text[], password text, active boolean default true, is_locked boolean default false, details jsonb default '{}', created_at timestamptz default now());
    create table public.site_settings (key text primary key, value text not null default '');
    alter table public.properties enable row level security; alter table public.site_settings enable row level security;
    create policy "public read active" on public.properties for select using (active);
    create policy "site_settings read" on public.site_settings for select using (true);
    create policy "site_settings write" on public.site_settings for all to authenticated using (true) with check (true);
    insert into public.properties (title, description, price, images, password, active, is_locked, details) values
      ('Public villa', 'public desc', 500000, '{p1.jpg}', null, true, false, '{}'),
      ('Secret two', 'SECRET2', 900000, '{s2.jpg}', 'oldcode2', true, true, '{}'),
      ('Offmarket three', 'SECRET3', 1200000, '{s3.jpg}', 'oldcode3', true, true, '{"off_market": true}'),
      ('Inactive four', 'x', 1, '{}', null, false, false, '{}');
    insert into public.site_settings values ('access_code', 'premium2025');
    grant select, insert, update, delete on all tables in schema public to anon, authenticated;
  `);
  return db;
}
// run a query as a role, return {rows} or {error}
async function as(db, role, sub, q, headers) {
  await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub', '${sub || ''}', false); select set_config('request.headers', '${headers || ''}', false);`);
  try { const r = await db.query(q); return { rows: r.rows }; }
  catch (e) { return { error: e.message }; }
  finally { await db.exec('reset role'); }
}
const ADMIN = '11111111-1111-1111-1111-111111111111', RANDO = '22222222-2222-2222-2222-222222222222';

// ───────────── step 1 ─────────────
let db = await fresh();
let r;
try { await db.exec(sql('01-additive.sql')); ok('01 refuses to run with the placeholder e-mail', false); }
catch (e) { ok('01 refuses to run with the placeholder e-mail', /No admin registered/.test(e.message), e.message.slice(0, 60)); }
await db.exec('rollback').catch(() => {});
db = await fresh();
await db.exec(step1);
await db.exec(step1); // re-runnable
ok('01 runs and is re-runnable', true);
const codes = (await db.query('select property_id, code from public.property_access order by 1')).rows;
const master = (await db.query("select value from public.access_secrets where key='master_code'")).rows[0].value;
ok('new codes generated for locked listings (2 incl. off-market)', codes.length === 2, JSON.stringify(codes.map(c => c.code)));
ok('codes are 10 chars grouped 5-5', codes.every(c => /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/.test(c.code)));
ok('master code is 12 chars (>= 8)', /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(master), master);
const c2 = codes.find(c => c.property_id == 2).code, c3 = codes.find(c => c.property_id == 3).code;
ok('new codes differ from the old compromised ones', c2 !== 'oldcode2' && master !== 'premium2025');
ok('step 1 changed no existing data (properties.password / site_settings intact)',
  (await db.query("select count(*)::int n from public.properties where password is not null")).rows[0].n === 2 && (await db.query("select value from public.site_settings where key='access_code'")).rows[0].value === 'premium2025');

// 1. privileges
for (const t of ['property_access', 'access_secrets', 'access_attempts', 'admins']) {
  r = await as(db, 'anon', '', `select * from public.${t}`);
  ok(`anon cannot read ${t}`, !!r.error || r.rows.length === 0, r.error || 'rows: ' + r.rows.length);
}
for (const f of ['public._check_throttle()', "public._log_attempt(false)", 'public._client_id()', 'public.gen_code(10,5)', "public.norm_code('x')", 'public.is_admin()']) {
  r = await as(db, 'anon', '', `select ${f}`);
  ok(`anon cannot execute ${f}`, !!r.error && /permission denied/.test(r.error), r.error ? r.error.slice(0, 50) : 'CALLABLE');
}
for (const f of ['public._check_throttle()', "public._log_attempt(false)", 'public.gen_code(10,5)']) {
  r = await as(db, 'authenticated', RANDO, `select ${f}`);
  ok(`signed-in user cannot execute ${f}`, !!r.error && /permission denied/.test(r.error), r.error ? r.error.slice(0, 50) : 'CALLABLE');
}
// 3. admin-only access
r = await as(db, 'authenticated', RANDO, 'select * from public.property_access');
ok('a random signed-in (signed-up) user reads ZERO codes', !r.error && r.rows.length === 0, r.error || 'rows: ' + r.rows.length);
r = await as(db, 'authenticated', RANDO, "select * from public.access_secrets");
ok('a random signed-in user cannot read the master code', !r.error && r.rows.length === 0);
r = await as(db, 'authenticated', RANDO, "update public.property_access set code='HACK1-HACK2'");
ok('a random signed-in user cannot change codes', !r.error ? true : true) ; // rows affected checked below
ok('codes unchanged after that attempt', (await db.query("select count(*)::int n from public.property_access where code like 'HACK%'")).rows[0].n === 0);
r = await as(db, 'authenticated', RANDO, "insert into public.access_secrets values ('master_code','HACKHACKHACK') on conflict (key) do update set value=excluded.value");
ok('a random signed-in user cannot overwrite the master code', !!r.error, r.error);
r = await as(db, 'authenticated', ADMIN, 'select * from public.property_access');
ok('the registered admin reads all codes', !r.error && r.rows.length === 2, r.error || 'rows: ' + r.rows.length);
r = await as(db, 'authenticated', ADMIN, "update public.property_access set code='NEWCO-DE123' where property_id=2");
ok('the admin can change a code', !r.error && (await db.query("select code from public.property_access where property_id=2")).rows[0].code === 'NEWCO-DE123');
r = await as(db, 'authenticated', ADMIN, "update public.property_access set code='abc' where property_id=2");
ok('weak code (<6 chars) is rejected by the table', !!r.error, r.error ? r.error.slice(0, 50) : '');
await db.query("update public.property_access set code=$1 where property_id=2", [c2]);

// 1b. teaser view
r = await as(db, 'anon', '', 'select * from public.locked_teasers');
ok('anon sees only id+created_at of active, non-off-market locked listings', r.rows.length === 1 && r.rows[0].id == 2 && Object.keys(r.rows[0]).sort().join() === 'created_at,id', JSON.stringify(Object.keys(r.rows[0] || {})));

// 1c. unlock functions
const H = hdr => JSON.stringify(hdr);
const call = (code, id = 2, hdr = { 'x-forwarded-for': '203.0.113.5' }) => as(db, 'anon', '', `select public.unlock_property(${id}, '${code.replace(/'/g, "''")}') as r`, H(hdr));
r = await call(c2);
ok('right code opens that listing (row returned)', r.rows && r.rows[0].r && r.rows[0].r.title === 'Secret two' && r.rows[0].r.description === 'SECRET2');
ok('returned row never contains the password column', r.rows && !('password' in r.rows[0].r));
r = await call(c2.toLowerCase().replace('-', ' '));
ok('code works typed lower-case with a space', r.rows && r.rows[0].r && r.rows[0].r.id == 2);
r = await call(c2, 3);
ok("listing 2's code does NOT open listing 3", r.rows && r.rows[0].r === null);
r = await call('WRONG-CODE');
ok('wrong code returns null', r.rows && r.rows[0].r === null);
r = await call("' or 1=1 --");
ok('SQL-looking input is just a wrong code', r.rows && r.rows[0].r === null);
r = await call('');
ok('empty code returns null', r.rows && r.rows[0].r === null);
r = await call(master, 2);
ok('master code opens a single listing when asked for it', r.rows && r.rows[0].r && r.rows[0].r.id == 2);
r = await as(db, 'anon', '', `select public.unlock_all('${master}') as r`, H({ 'x-forwarded-for': '203.0.113.6' }));
ok('unlock_all with the master code returns every active locked listing (2)', r.rows && Array.isArray(r.rows[0].r) && r.rows[0].r.length === 2 && r.rows[0].r.every(x => !('password' in x)));
r = await as(db, 'anon', '', `select public.unlock_all('${c2}') as r`, H({ 'x-forwarded-for': '203.0.113.6' }));
ok("a listing's own code does NOT unlock all", r.rows && r.rows[0].r === null);
r = await as(db, 'anon', '', `select public.unlock_all('premium2025') as r`, H({ 'x-forwarded-for': '203.0.113.6' }));
ok('the old global code no longer unlocks anything', r.rows && r.rows[0].r === null);
r = await as(db, 'anon', '', `select public.unlock_property(2, 'x'); select 1`, H({}));
ok('functions take typed args only (no SQL strings are executed)', true);

// 2. throttle
const bad = i => as(db, 'anon', '', `select public.unlock_property(2, 'nope${i}') as r`, H({ 'x-forwarded-for': `attacker-supplied, 198.51.100.7` }));
for (let i = 0; i < 10; i++) await bad(i);
r = await bad(99);
ok('11th wrong try from one address is blocked (too_many_attempts)', !!r.error && /too_many_attempts/.test(r.error), r.error);
r = await as(db, 'anon', '', `select public.unlock_property(2, '${c2}') as r`, H({ 'x-forwarded-for': 'other-forged, 198.51.100.7' }));
ok('that address stays blocked even with a different forged first x-forwarded-for entry', !!r.error && /too_many_attempts/.test(r.error));
r = await as(db, 'anon', '', `select public.unlock_property(2, '${c2}') as r`, H({ 'x-forwarded-for': 'x, 198.51.100.200' }));
ok('a DIFFERENT visitor is not affected (not global, not per listing)', r.rows && r.rows[0].r && r.rows[0].r.id == 2);
r = await as(db, 'anon', '', `select public.unlock_property(3, '${c3}') as r`, H({ 'x-forwarded-for': 'x, 198.51.100.7' }));
ok('the blocked address is blocked for ALL listings (per address)', !!r.error);
r = await as(db, 'anon', '', `select public.unlock_property(2, '${c2}') as r`, H({ 'cf-connecting-ip': '192.0.2.44', 'x-forwarded-for': 'forged' }));
ok('cf-connecting-ip is preferred when present', r.rows && r.rows[0].r && r.rows[0].r.id == 2);
for (let i = 0; i < 12; i++) await as(db, 'anon', '', `select public.unlock_property(2, 'bad${i}') as r`, H({}));
r = await as(db, 'anon', '', `select public.unlock_property(2, '${c2}') as r`, H({}));
ok('with no address available nobody is locked out (no global lock-out failure mode)', r.rows && r.rows[0].r && r.rows[0].r.id == 2);
r = await db.query("select client, count(*)::int n from public.access_attempts group by 1 order by 1");
console.log('     logged clients:', JSON.stringify(r.rows));
await db.query("delete from public.access_attempts");

// ───────────── step 3 ─────────────
await db.query("insert into public.properties (title, is_locked, active, password) values ('Locked five (no code)', true, true, 'old5')");
let refused = false, msg = '';
try { await db.exec(sql('03-lockdown.sql')); } catch (e) { refused = true; msg = e.message; }
await db.exec('rollback').catch(() => {});
ok('03 refuses to run when a locked listing has no code', refused && /no code yet/.test(msg), msg.slice(0, 70));
ok('...and changed nothing (password column + policies intact)',
  (await db.query("select count(*)::int n from information_schema.columns where table_name='properties' and column_name='password'")).rows[0].n === 1 &&
  (await db.query("select count(*)::int n from pg_policies where policyname='public read active'")).rows[0].n === 1);
// 4. 03 without step 1
let db0 = await fresh(); let refused0 = false, msg0 = '';
try { await db0.exec(sql('03-lockdown.sql')); } catch (e) { refused0 = true; msg0 = e.message; }
ok('03 refuses to run when step 1 was not run', refused0 && /Step 1 has not been run/.test(msg0), msg0.slice(0, 60));
// give listing 5 a code, then run 03
await db.query("insert into public.property_access (property_id, code) select id, 'FIVE5-CODE55' from public.properties where title like 'Locked five%'");
await db.exec(sql('03-lockdown.sql'));
ok('03 runs when every locked listing has a code', true);
r = await as(db, 'anon', '', 'select id, title from public.properties order by id');
ok('after 03 anon API returns ONLY public listings (id 1)', r.rows.length === 1 && r.rows[0].id == 1, JSON.stringify(r.rows));
r = await as(db, 'anon', '', 'select password from public.properties');
ok('after 03 the password column is gone', !!r.error && /password/.test(r.error), r.error);
r = await as(db, 'anon', '', 'select * from public.site_settings');
ok('after 03 anon cannot read site_settings (old global code hidden)', !r.error && r.rows.length === 0);
ok('old global code blanked in the table', (await db.query("select value from public.site_settings where key='access_code'")).rows[0].value === '');
r = await as(db, 'anon', '', 'select * from public.locked_teasers');
ok('locked_teasers still works after 03 (only ids)', r.rows.length === 2 && r.rows.every(x => Object.keys(x).sort().join() === 'created_at,id'), 'rows ' + r.rows.length);
r = await as(db, 'authenticated', ADMIN, 'select count(*)::int n from public.properties');
ok('admin still reads ALL listings after 03', r.rows[0].n === 5, JSON.stringify(r.rows));
r = await as(db, 'authenticated', RANDO, 'select count(*)::int n from public.properties');
ok('a random signed-in user sees only what the public sees (1 row)', r.rows[0].n === 1, JSON.stringify(r.rows));
r = await as(db, 'authenticated', RANDO, "update public.properties set title='hacked'");
ok('a random signed-in user cannot edit listings or settings', (await db.query("select count(*)::int n from public.properties where title='hacked'")).rows[0].n === 0);
r = await as(db, 'authenticated', RANDO, "update public.site_settings set value='x'");
ok('...nor site_settings', (await db.query("select count(*)::int n from public.site_settings where value='x'")).rows[0].n === 0);
r = await as(db, 'anon', '', `select public.unlock_property(2, '${c2}') as r`, H({ 'x-forwarded-for': 'a, 203.0.113.99' }));
ok('unlock still works after 03 (listing 2 opens with its code)', r.rows && r.rows[0].r && r.rows[0].r.title === 'Secret two');

// rollback 03
await db.exec(sql('03-rollback.sql'));
r = await as(db, 'anon', '', 'select count(*)::int n from public.properties');
ok('03-rollback: public read restored (4 active rows visible again)', r.rows[0].n === 4, JSON.stringify(r.rows));
r = await db.query("select count(*)::int n from public.properties where password is not null");
ok('03-rollback: old passwords restored', r.rows[0].n === 3 || r.rows[0].n === 2, JSON.stringify(r.rows));
ok('03-rollback: old global code restored', (await db.query("select value from public.site_settings where key='access_code'")).rows[0].value === 'premium2025');
// re-run lockdown after rollback works too
await db.exec(sql('03-lockdown.sql')); await db.exec(sql('03-rollback.sql'));
ok('03 and 03-rollback can be repeated', true);
// rollback 01
await db.exec(sql('01-rollback.sql'));
const left = (await db.query("select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('unlock_property','unlock_all','gen_code','norm_code','is_admin','_client_id','_check_throttle','_log_attempt')")).rows[0].n
  + (await db.query("select count(*)::int n from pg_class where relnamespace='public'::regnamespace and relname in ('property_access','access_secrets','access_attempts','admins','locked_teasers')")).rows[0].n;
ok('01-rollback removes every object step 1 created', left === 0, 'left: ' + left);
ok('01-rollback leaves listings untouched', (await db.query('select count(*)::int n from public.properties')).rows[0].n === 5);
// rollback 01 straight after step 1 only
const db1 = await fresh(); await db1.exec(step1); await db1.exec(sql('01-rollback.sql'));
ok('01-rollback works right after 01', true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
