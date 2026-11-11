-- ════════════════════════════════════════════════════════════════════════════
-- STEP 1 of 3 — ADDITIVE ONLY.  Royal Estates Premium (project mejkdoabupmfwcldysgd)
-- Adds new private tables, functions and a view. Changes NOTHING that exists today:
-- the current site, the admin and the old codes keep working exactly as before.
-- BEFORE RUNNING: replace  PUT-YOUR-ADMIN-EMAIL-HERE  below with the e-mail you sign in to /admin with.
-- Rollback: 01-rollback.sql.   Read README.md first (checklist + backup).   Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

-- 0. sanity: the listing id type must be a whole number
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'properties' and column_name = 'id'
                   and data_type in ('bigint', 'integer', 'smallint')) then
    raise exception 'properties.id is not an integer column: send me the result of  select data_type from information_schema.columns where table_name = ''properties'' and column_name = ''id'';';
  end if;
end $$;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ── who is an admin (ONLY these accounts can read the codes; being "signed in" is not enough) ──
create table if not exists public.admins (user_id uuid primary key references auth.users(id) on delete cascade);
alter table public.admins enable row level security;            -- no policy: nobody reads it directly
revoke all on public.admins from anon, authenticated;
insert into public.admins (user_id)
  select id from auth.users where lower(email) = lower('PUT-YOUR-ADMIN-EMAIL-HERE')
  on conflict do nothing;
do $$
begin
  if not exists (select 1 from public.admins) then
    raise exception 'No admin registered: edit PUT-YOUR-ADMIN-EMAIL-HERE (Authentication → Users shows your e-mail), then run again.';
  end if;
end $$;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.admins where user_id = auth.uid())
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;     -- policies call it as the signed-in user

-- ── helpers ─────────────────────────────────────────────────────────────────
-- Codes compare without caring about capitals, spaces, dashes, dots or underscores (same as the site today).
create or replace function public.norm_code(t text) returns text
language sql immutable set search_path = pg_temp as $$ select lower(regexp_replace(coalesce(t, ''), '[\s\-_.]', '', 'g')) $$;
revoke all on function public.norm_code(text) from public, anon;
grant execute on function public.norm_code(text) to authenticated;   -- used by the CHECK constraints when the admin saves a code

-- Random code from an alphabet without look-alikes (no I, O, 0, 1). n characters, a dash every `grp`.
-- gen_code(10,5) -> e.g. 7KQ4M-ZT9XD   (50 bits)     gen_code(12,4) -> e.g. 4HDM-X7TQ-2WNP (60 bits)
create or replace function public.gen_code(n int default 10, grp int default 5) returns text
language plpgsql volatile set search_path = public, extensions, pg_temp as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   -- 32 symbols, so (byte & 31) is uniform
  b bytea := gen_random_bytes(n);
  out text := '';
  i int;
begin
  for i in 0 .. n - 1 loop
    out := out || substr(alphabet, (get_byte(b, i) & 31) + 1, 1);
    if grp > 0 and (i + 1) % grp = 0 and i + 1 < n then out := out || '-'; end if;
  end loop;
  return out;
end $$;
revoke all on function public.gen_code(int, int) from public, anon, authenticated;   -- only used inside this script

-- ── private tables ──────────────────────────────────────────────────────────
-- Supabase gives new tables to anon/authenticated by default, so revoke explicitly; RLS is the second lock.
create table if not exists public.property_access (
  property_id bigint primary key references public.properties(id) on delete cascade,
  code        text not null,                         -- shown to you in the admin, so it is kept as generated
  updated_at  timestamptz not null default now(),
  constraint code_not_trivial check (length(public.norm_code(code)) >= 6)
);
create table if not exists public.access_secrets (    -- key 'master_code' = "Unlock all properties"
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now(),
  constraint master_min_length check (key <> 'master_code' or length(public.norm_code(value)) >= 8)
);
create table if not exists public.access_attempts (   -- brute-force throttle (kept 1 day: it stores visitor IP addresses)
  id bigserial primary key,
  at timestamptz not null default now(),
  client text,
  ok boolean not null
);
create index if not exists access_attempts_client_at on public.access_attempts (client, at);

alter table public.property_access enable row level security;
alter table public.access_secrets  enable row level security;
alter table public.access_attempts enable row level security;
revoke all on public.property_access, public.access_secrets, public.access_attempts from anon;
revoke all on public.access_attempts from authenticated;           -- only the unlock functions touch it
drop policy if exists "admin all" on public.property_access;
create policy "admin all" on public.property_access for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admin all" on public.access_secrets;
create policy "admin all" on public.access_secrets  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ── NEW random codes (the old ones were publicly readable: treat them as compromised) ──
insert into public.property_access (property_id, code)
  select p.id, public.gen_code(10, 5) from public.properties p
  where p.is_locked
  on conflict (property_id) do nothing;
insert into public.access_secrets (key, value) values ('master_code', public.gen_code(12, 4))
  on conflict (key) do nothing;

-- ── what a locked CARD may show to anyone: only that a private listing exists ──
create or replace view public.locked_teasers as
  select id, created_at
  from public.properties
  where active and is_locked and coalesce((details->>'off_market')::boolean, false) = false;   -- off-market listings are not even hinted at
revoke all on public.locked_teasers from anon, authenticated;
grant select on public.locked_teasers to anon, authenticated;

-- ── throttle: PER VISITOR ADDRESS. 10 wrong codes in 10 minutes -> that address is blocked until the window passes ──
-- Never per listing and never global: otherwise one person guessing wrong codes could lock everybody else out.
-- Address = Cloudflare's header if present, else the LAST x-forwarded-for entry (the one the platform appended;
-- the first entry can be typed by the visitor, so it is not trusted). If no address can be found, nobody is locked out
-- (failed tries are still slowed down and logged).
create or replace function public._client_id() returns text
language plpgsql stable set search_path = public, pg_temp as $$
declare h jsonb; ip text;
begin
  begin h := coalesce(current_setting('request.headers', true), '{}')::jsonb; exception when others then h := '{}'::jsonb; end;
  ip := nullif(trim(h ->> 'cf-connecting-ip'), '');
  if ip is null then
    ip := nullif(trim(regexp_replace(coalesce(h ->> 'x-forwarded-for', ''), '^.*,', '')), '');
  end if;
  return coalesce(ip, 'unknown');
end $$;

create or replace function public._check_throttle() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare who text := public._client_id();
begin
  if who <> 'unknown'
     and (select count(*) from public.access_attempts where client = who and not ok and at > now() - interval '10 minutes') >= 10 then
    raise exception 'too_many_attempts' using errcode = 'P0001';
  end if;
end $$;

create or replace function public._log_attempt(good boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.access_attempts (client, ok) values (public._client_id(), good);
  if not good then perform pg_sleep(0.3); end if;     -- slows guessing down further
  delete from public.access_attempts where at < now() - interval '1 day';
end $$;
revoke all on function public._client_id(), public._check_throttle(), public._log_attempt(boolean) from public, anon, authenticated;

-- ── unlock functions (security definer: they may read the private tables, callers may not) ──
-- No dynamic SQL anywhere: the only inputs are a number and a text that is only ever compared.
-- one listing: its own code, or the master code -> that listing's full row (jsonb), else null
create or replace function public.unlock_property(p_id bigint, p_code text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare c text := public.norm_code(p_code); good boolean; r jsonb;
begin
  perform public._check_throttle();
  select (c <> '') and (
           exists (select 1 from public.property_access where property_id = p_id and public.norm_code(code) = c)
        or exists (select 1 from public.access_secrets   where key = 'master_code' and public.norm_code(value) = c)) into good;
  perform public._log_attempt(good);
  if not good then return null; end if;
  select to_jsonb(p) - 'password' into r from public.properties p where p.id = p_id and p.active;
  return r;
end $$;

-- everything: master code only -> every active locked listing (array of rows), else null
create or replace function public.unlock_all(p_code text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare c text := public.norm_code(p_code); good boolean;
begin
  perform public._check_throttle();
  select (c <> '') and exists (select 1 from public.access_secrets where key = 'master_code' and public.norm_code(value) = c) into good;
  perform public._log_attempt(good);
  if not good then return null; end if;
  return (select coalesce(jsonb_agg(to_jsonb(p) - 'password'), '[]'::jsonb) from public.properties p where p.active and p.is_locked);
end $$;

-- Supabase also grants new functions to anon/authenticated by default, so revoke from them explicitly, then grant back.
revoke all on function public.unlock_property(bigint, text), public.unlock_all(text) from public, anon, authenticated;
grant execute on function public.unlock_property(bigint, text), public.unlock_all(text) to anon, authenticated;

-- ── show the new codes (only you see this result, in the SQL editor). The admin shows them too after step 2. ──
select p.id, p.title, a.code from public.property_access a join public.properties p on p.id = a.property_id order by p.id;
select value as master_code from public.access_secrets where key = 'master_code';
