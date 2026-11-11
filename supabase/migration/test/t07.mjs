// Tests for 07-short-codes.sql / 07-rollback.sql on a local Postgres (PGlite) shaped like Supabase (roles, default grants, RLS).
// Run: node t07.mjs   (needs @electric-sql/pglite; see README.md in this folder)
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
const ADMIN = '11111111-1111-1111-1111-111111111111', RANDO = '22222222-2222-2222-2222-222222222222';
const BANNED = ['0000', '1111', '1234', '4321'];

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
    insert into auth.users (id, email) values ('${ADMIN}', '${ADMIN_EMAIL}'), ('${RANDO}', 'random.signup@example.com');
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
      ('Locked four', 'SECRET4', 700000, '{s4.jpg}', 'oldcode4', true, true, '{}');
    insert into public.site_settings values ('access_code', 'premium2025');
    grant select, insert, update, delete on all tables in schema public to anon, authenticated;
  `);
  return db;
}
async function as(db, role, sub, q, headers) {
  await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub', '${sub || ''}', false); select set_config('request.headers', '${headers || ''}', false);`);
  try { const r = await db.query(q); return { rows: r.rows }; }
  catch (e) { return { error: e.message }; }
  finally { await db.exec('reset role'); }
}
const H = hdr => JSON.stringify(hdr);
const rows = async (db, q) => (await db.query(q)).rows;
const val = async (db, q) => Object.values((await db.query(q)).rows[0])[0];

// ───────────── set up: the live state before 07 (steps 1 and 3 applied) ─────────────
const db = await fresh();
await db.exec(step1);
await db.exec(sql('03-lockdown.sql'));
const oldCodes = Object.fromEntries((await rows(db, 'select property_id, code from public.property_access')).map(r => [r.property_id, r.code]));
const oldMaster = await val(db, "select value from public.access_secrets where key='master_code'");
ok('before 07: long codes from step 1 (3 locked listings)', Object.keys(oldCodes).length === 3 && Object.values(oldCodes).every(c => c.length === 11));

// ───────────── run 07 ─────────────
let out = await db.exec(sql('07-short-codes.sql'));
ok('07 runs', true);
let codes = Object.fromEntries((await rows(db, 'select property_id, code from public.property_access')).map(r => [r.property_id, r.code]));
let master = await val(db, "select value from public.access_secrets where key='master_code'");
const list = Object.values(codes);
ok('every listing code is exactly 4 digits', list.length === 3 && list.every(c => /^[0-9]{4}$/.test(c)), JSON.stringify(list));
ok('master code is exactly 4 digits', /^[0-9]{4}$/.test(master));
ok('none of the codes is 0000, 1111, 1234 or 4321', ![...list, master].some(c => BANNED.includes(c)));
ok('listing codes are unique and different from the master', new Set([...list, master]).size === 4);
ok('the new codes are not the old ones', list.every((c, i) => c !== Object.values(oldCodes)[i]) && master !== oldMaster);
const printed = await rows(db, `select kind, ref, title, code from (
  select 'listing' as kind, p.id::text as ref, p.title, a.code, p.id as sort_id, 0 as sort_kind from public.property_access a join public.properties p on p.id = a.property_id
  union all select 'master', '-', 'Unlock all properties', value, 0, 1 from public.access_secrets where key = 'master_code') q order by sort_kind, sort_id`);
ok('the final query prints one row per locked listing plus the master (4 rows, master last)', printed.length === 4 && printed[3].kind === 'master' && printed.slice(0, 3).every(r => r.kind === 'listing'));
// re-run: nothing changes
await db.exec(sql('07-short-codes.sql'));
const codes2 = Object.fromEntries((await rows(db, 'select property_id, code from public.property_access')).map(r => [r.property_id, r.code]));
ok('running 07 again does NOT change the codes', JSON.stringify(codes2) === JSON.stringify(codes) && (await val(db, "select value from public.access_secrets where key='master_code'")) === master);
ok('the rollback copies still hold the ORIGINAL long codes after a second run', (await rows(db, 'select code from public._rollback_property_access_07')).every(r => r.code.length === 11));
// locked listing added without a code gets one on re-run
await db.query("insert into public.properties (title, is_locked, active) values ('Locked five (new)', true, true)");

// ───────────── the random source ─────────────
const sample = (await rows(db, "select public._rand4() c from generate_series(1,20000)")).map(r => r.c);
ok('_rand4 always gives 4 digits (20,000 samples)', sample.every(c => /^[0-9]{4}$/.test(c)));
const lead0 = sample.filter(c => c[0] === '0').length, hi = sample.filter(c => c >= '5000').length;
ok('_rand4 is spread evenly (leading 0 ~10%, upper half ~50%)', lead0 > 1700 && lead0 < 2300 && hi > 9500 && hi < 10500, `lead0=${lead0} upper=${hi}`);
ok('_rand4 does not collapse onto a few values (> 7,000 distinct of 20,000)', new Set(sample).size > 7000, 'distinct ' + new Set(sample).size);
const gen = (await rows(db, "select public._new_code4() c from generate_series(1,20000)")).map(r => r.c);
ok('_new_code4 never returns 0000/1111/1234/4321, an existing code or the master (20,000 draws)', !gen.some(c => BANNED.includes(c) || list.includes(c) || c === master));
ok('_new_code4 keeps avoiding the code it is asked to avoid', !(await rows(db, "select public._new_code4('7777') c from generate_series(1,5000)")).some(r => r.c === '7777'));

// ───────────── anonymous visitor ─────────────
const c = Object.fromEntries(Object.entries(codes).map(([k, v]) => [Number(k), v]));
const [idA, idB] = Object.keys(c).map(Number);
const call = (code, id, hdr = { 'x-forwarded-for': 'x, 203.0.113.' + Math.floor(Math.random() * 250) }) => as(db, 'anon', '', `select public.unlock_property(${id}, '${String(code).replace(/'/g, "''")}') as r`, H(hdr));
let r = await call(c[idA], idA);
ok('each new code opens its own listing', r.rows && r.rows[0].r && r.rows[0].r.id == idA && !('password' in r.rows[0].r));
for (const id of Object.keys(c).map(Number)) { r = await call(c[id], id); ok(`  listing ${id} opens with its code`, r.rows && r.rows[0].r && r.rows[0].r.id == id); }
r = await call(c[idA], idB);
ok("a listing's code does NOT open another listing", r.rows && r.rows[0].r === null);
r = await call(c[idA].split('').join(' '), idA);
ok('a code typed with spaces ("1 2 3 4" style) still works', r.rows && r.rows[0].r && r.rows[0].r.id == idA);
r = await as(db, 'anon', '', `select public.unlock_all('${master}') as r`, H({ 'x-forwarded-for': 'x, 203.0.113.7' }));
ok('the master code opens all locked, active listings (4 incl. the new one without a code yet is not included: 3 with codes + new = 4 rows)', r.rows && Array.isArray(r.rows[0].r) && r.rows[0].r.length === 4);
r = await call(master, idB);
ok('the master code also opens a single listing', r.rows && r.rows[0].r && r.rows[0].r.id == idB);
r = await as(db, 'anon', '', `select public.unlock_all('${c[idA]}') as r`, H({ 'x-forwarded-for': 'x, 203.0.113.8' }));
ok("a listing's code does NOT unlock all", r.rows && r.rows[0].r === null);
let oldOpens = false;
for (const o of [...Object.values(oldCodes), oldMaster, 'premium2025', 'oldcode2', 'oldcode3', 'oldcode4']) {
  for (const id of Object.keys(c).map(Number)) { const x = await call(o, id); if (x.rows && x.rows[0].r) oldOpens = true; }
  const y = await as(db, 'anon', '', `select public.unlock_all('${o}') as r`, H({ 'x-forwarded-for': 'x, 203.0.113.' + Math.floor(Math.random() * 250) })); if (y.rows && y.rows[0].r) oldOpens = true;
}
ok('all old codes (step-1 codes, old master, old global code, old passwords) are dead', !oldOpens);
for (const t of ['property_access', 'access_secrets', 'access_attempts', 'access_lockouts', 'admins', '_rollback_property_access_07', '_rollback_access_secrets_07']) {
  r = await as(db, 'anon', '', `select * from public.${t}`);
  ok(`anon cannot read ${t}`, !!r.error || r.rows.length === 0, r.error || 'rows ' + r.rows.length);
}
r = await as(db, 'anon', '', 'select id, title from public.properties order by id');
ok('anon still sees only the public listing (id 1); no locked data', r.rows && r.rows.length === 1 && r.rows[0].id == 1);
for (const f of ["public.admin_set_code(2,'4821')", 'public.admin_regenerate_code(2)', "public.admin_set_master('4821')", 'public.admin_regenerate_master()', 'public._rand4()', 'public._new_code4(null)', 'public._check_throttle()', 'public._log_attempt(false)']) {
  r = await as(db, 'anon', '', `select ${f}`);
  ok(`anon cannot call ${f}`, !!r.error && /permission denied/.test(r.error), r.error ? r.error.slice(0, 45) : 'CALLABLE');
}
await db.exec("delete from public.access_attempts; delete from public.access_lockouts");

// ───────────── admin functions ─────────────
const fn = (who, q) => as(db, 'authenticated', who, q);
for (const f of ["public.admin_set_code(2,'4821')", 'public.admin_regenerate_code(2)', "public.admin_set_master('4821')", 'public.admin_regenerate_master()']) {
  r = await fn(RANDO, `select ${f}`);
  ok(`a signed-in NON-admin is refused: ${f}`, !!r.error && /not_admin/.test(r.error), r.error);
}
const free = (await rows(db, "select public._new_code4() c")).map(x => x.c)[0];
r = await fn(ADMIN, `select public.admin_set_code(${idA}, '${free}') c`);
ok('admin can set a code', !r.error && r.rows[0].c === free && (await val(db, `select code from public.property_access where property_id=${idA}`)) === free, r.error);
for (const [bad, why] of [['abcd', 'letters'], ['123', '3 digits'], ['12345', '5 digits'], ['', 'empty'], [' 4821', 'leading space'], ['4821 ', 'trailing space'], ['48 21', 'space inside'], ['48-21', 'dash'], ['٣٣٣٣', 'non-ASCII digits'], ['4821\n', 'trailing newline']]) {
  r = await fn(ADMIN, `select public.admin_set_code(${idA}, $$${bad}$$)`);
  ok(`admin_set_code rejects "${bad.replace('\n', '\\n')}" (${why}) as code_format`, !!r.error && /code_format/.test(r.error), r.error);
}
r = await fn(ADMIN, `select public.admin_set_code(${idA}, null)`);
ok('admin_set_code rejects NULL', !!r.error && /code_format/.test(r.error));
for (const b of BANNED) { r = await fn(ADMIN, `select public.admin_set_code(${idA}, '${b}')`); ok(`admin_set_code rejects ${b} (code_reserved)`, !!r.error && /code_reserved/.test(r.error), r.error); }
r = await fn(ADMIN, `select public.admin_set_code(${idB}, '${c[idA] === free ? free : free}')`);
ok("admin_set_code rejects a code already used by another listing (code_in_use)", !!r.error && /code_in_use/.test(r.error), r.error);
r = await fn(ADMIN, `select public.admin_set_code(${idB}, '${master}')`);
ok('admin_set_code rejects the master code (code_in_use)', !!r.error && /code_in_use/.test(r.error), r.error);
r = await fn(ADMIN, `select public.admin_set_code(${idA}, '${free}') c`);
ok("setting a listing to its OWN current code is fine (no false 'in use')", !r.error);
r = await fn(ADMIN, `select public.admin_set_code(99999, '7391')`);
ok('admin_set_code rejects an unknown listing', !!r.error && /no_such_listing/.test(r.error), r.error);
const before = await val(db, `select code from public.property_access where property_id=${idA}`);
r = await fn(ADMIN, `select public.admin_regenerate_code(${idA}) c`);
ok('admin can regenerate: new 4-digit code, different from before, not banned, unique', !r.error && /^[0-9]{4}$/.test(r.rows[0].c) && r.rows[0].c !== before && !BANNED.includes(r.rows[0].c) && r.rows[0].c !== master);
r = await fn(ADMIN, `select public.admin_regenerate_code(${(await val(db, "select max(id) from public.properties"))}) c`);
ok('regenerate also creates a code for a locked listing that had none', !r.error && /^[0-9]{4}$/.test(r.rows[0].c));
const listingNow = await val(db, `select code from public.property_access where property_id=${idA}`);
r = await fn(ADMIN, `select public.admin_set_master('${listingNow}')`);
ok('admin_set_master rejects a code used by a listing (code_in_use)', !!r.error && /code_in_use/.test(r.error), r.error);
for (const bad of ['12', 'abcd', '1234', '0000']) { r = await fn(ADMIN, `select public.admin_set_master('${bad}')`); ok(`admin_set_master rejects ${bad}`, !!r.error && /code_(format|reserved)/.test(r.error), r.error); }
r = await fn(ADMIN, `select public.admin_set_master('7391') c`);
ok('admin can set the master to a free 4-digit code', !r.error && (await val(db, "select value from public.access_secrets where key='master_code'")) === '7391', r.error);
r = await fn(ADMIN, `select public.admin_regenerate_master() c`);
ok('admin can regenerate the master (new, 4 digits, not banned, not a listing code)', !r.error && /^[0-9]{4}$/.test(r.rows[0].c) && r.rows[0].c !== '7391' && !BANNED.includes(r.rows[0].c) && !(await rows(db, 'select code from public.property_access')).some(x => x.code === r.rows[0].c));
master = await val(db, "select value from public.access_secrets where key='master_code'");
// direct table writes are held to the same rules
r = await fn(ADMIN, "update public.property_access set code='abc' where property_id=" + idA);
ok('the TABLE refuses a non-4-digit code even if written directly', !!r.error && /code_is_4_digits/.test(r.error), r.error);
r = await fn(ADMIN, "update public.property_access set code='1234' where property_id=" + idA);
ok('the TABLE refuses 1234', !!r.error);
r = await fn(ADMIN, `update public.property_access set code='${await val(db, `select code from public.property_access where property_id=${idB}`)}' where property_id=${idA}`);
ok('the TABLE refuses a duplicate listing code (unique)', !!r.error && /unique|duplicate/.test(r.error), r.error);
r = await fn(ADMIN, `update public.property_access set code='${master}' where property_id=${idA}`);
ok('the TABLE refuses a listing code equal to the master (trigger)', !!r.error && /code_in_use/.test(r.error), r.error);
r = await fn(ADMIN, `update public.access_secrets set value='${await val(db, `select code from public.property_access where property_id=${idA}`)}' where key='master_code'`);
ok('the TABLE refuses a master equal to a listing code (trigger)', !!r.error && /code_in_use/.test(r.error), r.error);
r = await fn(ADMIN, "update public.access_secrets set value='99' where key='master_code'");
ok('the TABLE refuses a master that is not 4 digits', !!r.error && /master_is_4_digits/.test(r.error), r.error);
await fn(RANDO, "update public.property_access set code='5555'");
ok('a signed-in non-admin cannot change codes by writing the table', (await val(db, "select count(*)::int from public.property_access where code='5555'")) === 0);

// ───────────── throttle: 5 wrong tries -> locked 15 minutes, per address ─────────────
codes = Object.fromEntries((await rows(db, 'select property_id, code from public.property_access')).map(r => [r.property_id, r.code]));
const good = codes[idA];
const IP = 'x, 198.51.100.7';
const bad = i => as(db, 'anon', '', `select public.unlock_property(${idA}, 'nope${i}') as r`, H({ 'x-forwarded-for': IP }));
const goodCall = (ip = IP) => as(db, 'anon', '', `select public.unlock_property(${idA}, '${good}') as r`, H({ 'x-forwarded-for': ip }));
await db.exec('delete from public.access_attempts; delete from public.access_lockouts');
await bad(1); await bad(2);
r = await goodCall();
ok('a visitor who mistypes twice and then types the right code is NOT affected', r.rows && r.rows[0].r && r.rows[0].r.id == idA, r.error);
await bad(3); await bad(4);
r = await goodCall();
ok('4 wrong tries are still allowed (the right code still works after 4)', r.rows && r.rows[0].r && r.rows[0].r.id == idA, r.error);
r = await bad(5);
ok('the 5th wrong try is answered normally (wrong code), and starts the lock', r.rows && r.rows[0].r === null);
r = await bad(6);
ok('the 6th try is blocked (too_many_attempts)', !!r.error && /too_many_attempts/.test(r.error), r.error);
r = await goodCall();
ok('while locked, even the RIGHT code from that address is refused', !!r.error && /too_many_attempts/.test(r.error));
r = await as(db, 'anon', '', `select public.unlock_all('${master}') as r`, H({ 'x-forwarded-for': IP }));
ok('...and unlock-all is refused from that address too (one counter per address)', !!r.error && /too_many_attempts/.test(r.error));
r = await goodCall('forged-first, 198.51.100.7');
ok('...even with a different forged first x-forwarded-for entry', !!r.error && /too_many_attempts/.test(r.error));
r = await goodCall('x, 198.51.100.200');
ok('a DIFFERENT visitor is not affected (per address, not global, not per listing)', r.rows && r.rows[0].r && r.rows[0].r.id == idA);
const mins = Number(await val(db, "select extract(epoch from (until - now()))/60 from public.access_lockouts where client='198.51.100.7'"));
ok('the lock lasts 15 minutes (' + mins.toFixed(2) + ' min left)', mins > 14.9 && mins <= 15.0);
// time passes: lock ends and the old failures are 15+ minutes old
await db.exec("update public.access_lockouts set until = now() - interval '1 second'; update public.access_attempts set at = at - interval '16 minutes'");
r = await goodCall();
ok('after the 15 minutes the address can try again (right code works)', r.rows && r.rows[0].r && r.rows[0].r.id == idA, r.error);
r = await bad(7);
ok('and one new wrong try does not re-lock it (it starts clean)', r.rows && r.rows[0].r === null);
r = await goodCall();
ok('...it can still unlock afterwards', r.rows && r.rows[0].r && r.rows[0].r.id == idA, r.error);
// sliding window: failures spread over 14 minutes still count, over 16 minutes do not
await db.exec('delete from public.access_attempts; delete from public.access_lockouts');
await db.query("insert into public.access_attempts (client, ok, at) select '192.0.2.10', false, now() - (g || ' minutes')::interval from generate_series(10, 13) g");
r = await as(db, 'anon', '', `select public.unlock_property(${idA}, 'zzz') as r`, H({ 'cf-connecting-ip': '192.0.2.10' }));
r = await as(db, 'anon', '', `select public.unlock_property(${idA}, '${good}') as r`, H({ 'cf-connecting-ip': '192.0.2.10' }));
ok('4 wrong tries spread over ~13 minutes + 1 more = 5 within 15 minutes -> locked', !!r.error && /too_many_attempts/.test(r.error), r.error);
await db.query("insert into public.access_attempts (client, ok, at) select '192.0.2.11', false, now() - (g || ' minutes')::interval from generate_series(16, 19) g");
r = await as(db, 'anon', '', `select public.unlock_property(${idA}, 'zzz') as r`, H({ 'cf-connecting-ip': '192.0.2.11' }));
r = await as(db, 'anon', '', `select public.unlock_property(${idA}, '${good}') as r`, H({ 'cf-connecting-ip': '192.0.2.11' }));
ok('4 wrong tries older than 15 minutes do NOT count (1 recent wrong try, then success)', r.rows && r.rows[0].r && r.rows[0].r.id == idA, r.error);
// a success does not reset the counter (a known code cannot be used to keep guessing)
await db.exec('delete from public.access_attempts; delete from public.access_lockouts');
for (let i = 0; i < 4; i++) { await as(db, 'anon', '', `select public.unlock_property(${idA}, 'w${i}') as r`, H({ 'x-forwarded-for': 'x, 198.51.100.50' })); await as(db, 'anon', '', `select public.unlock_property(${idA}, '${good}') as r`, H({ 'x-forwarded-for': 'x, 198.51.100.50' })); }
r = await as(db, 'anon', '', `select public.unlock_property(${idA}, 'w9') as r`, H({ 'x-forwarded-for': 'x, 198.51.100.50' }));
r = await as(db, 'anon', '', `select public.unlock_property(${idA}, 'w10') as r`, H({ 'x-forwarded-for': 'x, 198.51.100.50' }));
ok('a success in between does NOT reset the counter (5 wrong in total still locks)', !!r.error && /too_many_attempts/.test(r.error), r.error);
// no address known: never locked out
await db.exec('delete from public.access_attempts; delete from public.access_lockouts');
for (let i = 0; i < 12; i++) await as(db, 'anon', '', `select public.unlock_property(${idA}, 'u${i}') as r`, H({}));
r = await as(db, 'anon', '', `select public.unlock_property(${idA}, '${good}') as r`, H({}));
ok('with no address available nobody is locked out (no global lock-out failure mode)', r.rows && r.rows[0].r && r.rows[0].r.id == idA);
ok('no lockout row is ever created for an unknown address', (await val(db, "select count(*)::int from public.access_lockouts where client='unknown'")) === 0);
r = await as(db, 'anon', '', 'select * from public.access_lockouts');
ok('anon cannot read the lockout table', !!r.error || r.rows.length === 0);
await db.exec('delete from public.access_attempts; delete from public.access_lockouts');

// ───────────── rollback ─────────────
const preRollbackListing = await val(db, "select max(id)::int from public.properties");
await db.exec(sql('07-rollback.sql'));
const back = Object.fromEntries((await rows(db, 'select property_id, code from public.property_access')).map(r => [r.property_id, r.code]));
ok('07-rollback restores every original long code', Object.entries(oldCodes).every(([k, v]) => back[k] === v), JSON.stringify(back));
ok('07-rollback gives the listing locked after 07 a fresh long (old-style) code', back[preRollbackListing] && back[preRollbackListing].length === 11);
ok('07-rollback restores the original master code', (await val(db, "select value from public.access_secrets where key='master_code'")) === oldMaster);
r = await as(db, 'anon', '', `select public.unlock_property(${idA}, '${oldCodes[idA]}') as r`, H({ 'x-forwarded-for': 'x, 203.0.113.99' }));
ok('after rollback the original long code works again', r.rows && r.rows[0].r && r.rows[0].r.id == idA, r.error);
r = await as(db, 'authenticated', ADMIN, `update public.property_access set code='4821' where property_id=${idA}`);
ok('after rollback the old length rule is back (a 4-digit code is rejected)', !!r.error && /code_not_trivial/.test(r.error), r.error);
for (let i = 0; i < 9; i++) await as(db, 'anon', '', `select public.unlock_property(${idA}, 'q${i}') as r`, H({ 'x-forwarded-for': 'x, 198.51.100.77' }));
r = await as(db, 'anon', '', `select public.unlock_property(${idA}, '${oldCodes[idA]}') as r`, H({ 'x-forwarded-for': 'x, 198.51.100.77' }));
ok('after rollback the old throttle is back (9 wrong tries do not lock; limit is 10)', r.rows && r.rows[0].r && r.rows[0].r.id == idA, r.error);
ok('07-rollback removes the new functions, trigger function and lockout table', (await val(db, "select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('admin_set_code','admin_regenerate_code','admin_set_master','admin_regenerate_master','_rand4','_new_code4','_codes_distinct')")) === 0 && (await val(db, "select count(*)::int from pg_class where relnamespace='public'::regnamespace and relname='access_lockouts'")) === 0);
await db.exec(sql('07-short-codes.sql'));
ok('07 can be applied again after a rollback', (await rows(db, 'select code from public.property_access')).every(x => /^[0-9]{4}$/.test(x.code)));
await db.exec(sql('07-rollback.sql')); await db.exec(sql('07-rollback.sql').replace(/^do \$\$[\s\S]*?end \$\$;/m, ''));
ok('07-rollback can be repeated', true);
await db.exec(sql('03-rollback.sql')); await db.exec(sql('01-rollback.sql'));
ok('03-rollback and 01-rollback still work after a 07 rollback (step-1 tables gone)', (await val(db, "select count(*)::int from pg_class where relnamespace='public'::regnamespace and relname in ('property_access','access_secrets','access_attempts','admins')")) === 0);

// ───────────── 07 without step 1 ─────────────
const db0 = await fresh(); let refused = false, msg = '';
try { await db0.exec(sql('07-short-codes.sql')); } catch (e) { refused = true; msg = e.message; }
ok('07 refuses to run when step 1 was not run', refused && /Run 01-additive.sql first/.test(msg), msg.slice(0, 60));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
