-- ════════════════════════════════════════════════════════════════════════════
-- STEP 7 — 4-digit access codes (per listing + master), and a stricter throttle.   NOT run yet: review, then run.
-- Needs 01-additive.sql. Safe to re-run (codes that are already 4 digits are left alone). Rollback: 07-rollback.sql
--
--  1. Every listing code and the master code become random 4-digit codes from a cryptographically secure source
--     (pgcrypto gen_random_bytes, bias-free), unique across all listings, master different from every listing code.
--     0000, 1111, 1234 and 4321 are never used. The OLD codes are saved (privately) in _rollback_*_07 so 07-rollback can restore them.
--  2. The database itself enforces it: exactly 4 digits, not one of the four banned ones, unique, master <> any listing code.
--     The admin page uses four admin-only functions (set / regenerate, for a listing and for the master) that return clear errors.
--  3. Throttle (per visitor address, as before): the 5th wrong code locks that address out for 15 minutes.
--     One or two typos are never affected; failures are not reset by a success (otherwise a known code could be used to reset the counter).
--  4. The new codes are printed ONCE by the last query. Copy them privately; they are not written anywhere else.
-- ════════════════════════════════════════════════════════════════════════════
begin;

do $$
begin
  if to_regprocedure('public.is_admin()') is null or to_regclass('public.property_access') is null
     or to_regclass('public.access_secrets') is null or to_regprocedure('public.unlock_property(bigint,text)') is null then
    raise exception 'Run 01-additive.sql first.';
  end if;
  if not exists (select 1 from public.admins) then raise exception 'No admin registered (step 1).'; end if;
end $$;

-- ── 1. private copies of the current codes, for 07-rollback (kept if this script is run again) ──
create table if not exists public._rollback_property_access_07 as select * from public.property_access;
create table if not exists public._rollback_access_secrets_07  as select * from public.access_secrets where key = 'master_code';
alter table public._rollback_property_access_07 enable row level security;
alter table public._rollback_access_secrets_07  enable row level security;
revoke all on public._rollback_property_access_07, public._rollback_access_secrets_07 from public, anon, authenticated;

-- ── 2. secure random 4-digit codes ──
-- 4 random bytes = 0 .. 4294967295; values >= 4294960000 (= 429496 x 10000) are discarded so every 4-digit value is equally likely.
create or replace function public._rand4() returns text
language plpgsql volatile set search_path = public, extensions, pg_temp as $$
declare n bigint;
begin
  loop
    n := (select (get_byte(b, 0)::bigint << 24) + (get_byte(b, 1) << 16) + (get_byte(b, 2) << 8) + get_byte(b, 3) from (select gen_random_bytes(4) as b) s);
    exit when n < 4294960000;
  end loop;
  return lpad((n % 10000)::text, 4, '0');
end $$;

-- a free code: not banned, not another listing's code, not the master, and (when regenerating) not the same as before
create or replace function public._new_code4(p_avoid text default null) returns text
language plpgsql volatile set search_path = public, extensions, pg_temp as $$
declare c text; i int := 0;
begin
  loop
    i := i + 1;
    if i > 500 then raise exception 'no_free_codes'; end if;
    c := public._rand4();
    continue when c in ('0000', '1111', '1234', '4321') or c is not distinct from p_avoid;
    continue when exists (select 1 from public.property_access where code = c)
               or exists (select 1 from public.access_secrets where key = 'master_code' and value = c);
    return c;
  end loop;
end $$;
revoke all on function public._rand4(), public._new_code4(text) from public, anon, authenticated;

-- ── 3. regenerate the existing codes (only the ones that are not 4 digits yet) ──
alter table public.property_access drop constraint if exists code_not_trivial;
alter table public.access_secrets  drop constraint if exists master_min_length;
do $$
declare r record;
begin
  for r in select p.id from public.properties p where p.is_locked and not exists (select 1 from public.property_access a where a.property_id = p.id) order by p.id loop
    insert into public.property_access (property_id, code) values (r.id, public._new_code4());      -- locked listings that had no code get one
  end loop;
  for r in select property_id from public.property_access where code !~ '^[0-9]{4}$' order by property_id loop
    update public.property_access set code = public._new_code4(), updated_at = now() where property_id = r.property_id;
  end loop;
  if not exists (select 1 from public.access_secrets where key = 'master_code') then
    insert into public.access_secrets (key, value) values ('master_code', public._new_code4());
  else
    update public.access_secrets set value = public._new_code4(), updated_at = now() where key = 'master_code' and value !~ '^[0-9]{4}$';
  end if;
end $$;

-- ── 4. the database enforces the rules ──
alter table public.property_access drop constraint if exists code_is_4_digits;
alter table public.property_access add constraint code_is_4_digits
  check (code ~ '^[0-9]{4}$' and code not in ('0000', '1111', '1234', '4321'));
create unique index if not exists property_access_code_uq on public.property_access (code);
alter table public.access_secrets  drop constraint if exists master_is_4_digits;
alter table public.access_secrets add constraint master_is_4_digits
  check (key <> 'master_code' or (value ~ '^[0-9]{4}$' and value not in ('0000', '1111', '1234', '4321')));

-- master <> every listing code (the unique index covers listing vs listing)
create or replace function public._codes_distinct() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform pg_advisory_xact_lock(70707);
  if tg_table_name = 'property_access' then
    if exists (select 1 from public.access_secrets where key = 'master_code' and value = new.code) then
      raise exception 'code_in_use' using errcode = '23505';
    end if;
  elsif new.key = 'master_code' and exists (select 1 from public.property_access where code = new.value) then
    raise exception 'code_in_use' using errcode = '23505';
  end if;
  return new;
end $$;
revoke all on function public._codes_distinct() from public, anon, authenticated;
drop trigger if exists property_access_distinct on public.property_access;
create trigger property_access_distinct before insert or update of code on public.property_access
  for each row execute function public._codes_distinct();
drop trigger if exists access_secrets_distinct on public.access_secrets;
create trigger access_secrets_distinct before insert or update of key, value on public.access_secrets
  for each row execute function public._codes_distinct();

-- ── 5. admin-only functions used by the Access codes page (callable by signed-in users, but they refuse anyone who is not an admin) ──
create or replace function public.admin_set_code(p_id bigint, p_code text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  if p_code is null or p_code !~ '^[0-9]{4}$' then raise exception 'code_format' using errcode = '22023'; end if;
  if p_code in ('0000', '1111', '1234', '4321') then raise exception 'code_reserved' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(70707);
  if not exists (select 1 from public.properties where id = p_id) then raise exception 'no_such_listing' using errcode = '22023'; end if;
  if exists (select 1 from public.property_access where code = p_code and property_id <> p_id)
     or exists (select 1 from public.access_secrets where key = 'master_code' and value = p_code) then
    raise exception 'code_in_use' using errcode = '23505';
  end if;
  insert into public.property_access (property_id, code) values (p_id, p_code)
    on conflict (property_id) do update set code = excluded.code, updated_at = now();
  return p_code;
end $$;

create or replace function public.admin_regenerate_code(p_id bigint) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare c text;
begin
  if not public.is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(70707);
  if not exists (select 1 from public.properties where id = p_id) then raise exception 'no_such_listing' using errcode = '22023'; end if;
  c := public._new_code4((select code from public.property_access where property_id = p_id));
  insert into public.property_access (property_id, code) values (p_id, c)
    on conflict (property_id) do update set code = excluded.code, updated_at = now();
  return c;
end $$;

create or replace function public.admin_set_master(p_code text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  if p_code is null or p_code !~ '^[0-9]{4}$' then raise exception 'code_format' using errcode = '22023'; end if;
  if p_code in ('0000', '1111', '1234', '4321') then raise exception 'code_reserved' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(70707);
  if exists (select 1 from public.property_access where code = p_code) then raise exception 'code_in_use' using errcode = '23505'; end if;
  insert into public.access_secrets (key, value) values ('master_code', p_code)
    on conflict (key) do update set value = excluded.value, updated_at = now();
  return p_code;
end $$;

create or replace function public.admin_regenerate_master() returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare c text;
begin
  if not public.is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(70707);
  c := public._new_code4((select value from public.access_secrets where key = 'master_code'));
  insert into public.access_secrets (key, value) values ('master_code', c)
    on conflict (key) do update set value = excluded.value, updated_at = now();
  return c;
end $$;
revoke all on function public.admin_set_code(bigint, text), public.admin_regenerate_code(bigint),
                       public.admin_set_master(text), public.admin_regenerate_master() from public, anon, authenticated;
grant execute on function public.admin_set_code(bigint, text), public.admin_regenerate_code(bigint),
                          public.admin_set_master(text), public.admin_regenerate_master() to authenticated;

-- ── 6. throttle: 5 wrong codes from one address -> that address is locked out for 15 minutes ──
-- The lock starts at the 5th wrong try and lasts exactly 15 minutes; the failures that caused it are then 15 minutes old, so the
-- address starts clean. Still per visitor address (never per listing, never global). No address known -> nobody is locked out.
create table if not exists public.access_lockouts (client text primary key, until timestamptz not null);
alter table public.access_lockouts enable row level security;
revoke all on public.access_lockouts from public, anon, authenticated;

create or replace function public._check_throttle() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare who text := public._client_id();
begin
  if who <> 'unknown' and exists (select 1 from public.access_lockouts where client = who and until > now()) then
    raise exception 'too_many_attempts' using errcode = 'P0001';
  end if;
end $$;

create or replace function public._log_attempt(good boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare who text := public._client_id();
begin
  insert into public.access_attempts (client, ok) values (who, good);
  if not good then
    perform pg_sleep(0.3);                                   -- slows guessing down further
    if who <> 'unknown'
       and (select count(*) from public.access_attempts where client = who and not ok and at > now() - interval '15 minutes') >= 5 then
      insert into public.access_lockouts (client, until) values (who, now() + interval '15 minutes')
        on conflict (client) do update set until = excluded.until;
    end if;
  end if;
  delete from public.access_attempts where at < now() - interval '1 day';
  delete from public.access_lockouts where until < now() - interval '1 day';
end $$;
revoke all on function public._check_throttle(), public._log_attempt(boolean) from public, anon, authenticated;

-- ── 7. the new codes, printed once (copy them privately; this is the only place they appear) ──
select kind, ref, title, code from (
  select 'listing' as kind, p.id::text as ref, p.title, a.code, p.id as sort_id, 0 as sort_kind
    from public.property_access a join public.properties p on p.id = a.property_id
  union all
  select 'master', '-', 'Unlock all properties', value, 0, 1 from public.access_secrets where key = 'master_code'
) q order by sort_kind, sort_id;
commit;
