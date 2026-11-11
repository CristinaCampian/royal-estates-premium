-- ════════════════════════════════════════════════════════════════════════════
-- STEP 1 of 3 — ADDITIVE ONLY.  Royal Estates Premium (project mejkdoabupmfwcldysgd)
-- Adds new private tables, functions and a view. Changes NOTHING that exists today:
-- the current site, the admin and the old codes keep working exactly as before.
-- Rollback: 01-rollback.sql.   Read README.md first (checklist + backup).
-- Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto with schema extensions;

-- ── helpers ─────────────────────────────────────────────────────────────────
-- Codes compare without caring about capitals, spaces, dashes, dots or underscores (same as the site today).
create or replace function public.norm_code(t text) returns text
language sql immutable as $$ select lower(regexp_replace(coalesce(t, ''), '[\s\-_.]', '', 'g')) $$;

-- Random code from an alphabet without look-alikes (no I, O, 0, 1). n characters, a dash every `grp`.
-- gen_code(10,5) -> e.g. 7KQ4M-ZT9XD   (50 bits)     gen_code(12,4) -> e.g. 4HDM-X7TQ-2WNP (60 bits)
create or replace function public.gen_code(n int default 10, grp int default 5) returns text
language plpgsql volatile set search_path = public, extensions as $$
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

-- ── private tables (RLS on, no policy for anon = anonymous visitors can read nothing) ──
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
create table if not exists public.access_attempts (   -- brute-force throttle
  id bigserial primary key,
  at timestamptz not null default now(),
  client text,
  ok boolean not null
);
create index if not exists access_attempts_client_at on public.access_attempts (client, at);

alter table public.property_access enable row level security;
alter table public.access_secrets  enable row level security;
alter table public.access_attempts enable row level security;
drop policy if exists "admin all" on public.property_access;
create policy "admin all" on public.property_access for all to authenticated using (true) with check (true);
drop policy if exists "admin all" on public.access_secrets;
create policy "admin all" on public.access_secrets  for all to authenticated using (true) with check (true);
-- access_attempts: no policy at all (only the functions below, running as owner, touch it)

-- ── NEW random codes (the old ones were publicly readable: treat them as compromised) ──
-- one new code for every locked listing that has none yet (active or not) …
insert into public.property_access (property_id, code)
  select p.id, public.gen_code(10, 5) from public.properties p
  where p.is_locked
  on conflict (property_id) do nothing;
-- … and a new master code (12 characters)
insert into public.access_secrets (key, value) values ('master_code', public.gen_code(12, 4))
  on conflict (key) do nothing;

-- ── what a locked CARD may show to anyone: only that a private listing exists ──
create or replace view public.locked_teasers as
  select id, created_at
  from public.properties
  where active and is_locked and coalesce((details->>'off_market')::boolean, false) = false;   -- off-market listings are not even hinted at
grant select on public.locked_teasers to anon, authenticated;

-- ── throttle: 10 wrong codes in 10 minutes from one address -> blocked for the rest of the window ──
create or replace function public._client_id() returns text
language sql stable set search_path = public as $$
  select coalesce(nullif(split_part(coalesce(current_setting('request.headers', true), '{}')::jsonb ->> 'x-forwarded-for', ',', 1), ''), 'unknown')
$$;
create or replace function public._check_throttle() returns void
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.access_attempts where client = public._client_id() and not ok and at > now() - interval '10 minutes') >= 10 then
    raise exception 'too_many_attempts' using errcode = 'P0001';
  end if;
end $$;
create or replace function public._log_attempt(good boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.access_attempts (client, ok) values (public._client_id(), good);
  if not good then perform pg_sleep(0.4); end if;     -- slows guessing down further
  delete from public.access_attempts where at < now() - interval '1 day';
end $$;

-- ── unlock functions (security definer: they may read the private tables, callers may not) ──
-- one listing: its own code, or the master code -> that listing's full row (jsonb), else null
create or replace function public.unlock_property(p_id bigint, p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
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
language plpgsql security definer set search_path = public as $$
declare c text := public.norm_code(p_code); good boolean;
begin
  perform public._check_throttle();
  select (c <> '') and exists (select 1 from public.access_secrets where key = 'master_code' and public.norm_code(value) = c) into good;
  perform public._log_attempt(good);
  if not good then return null; end if;
  return (select coalesce(jsonb_agg(to_jsonb(p) - 'password'), '[]'::jsonb) from public.properties p where p.active and p.is_locked);
end $$;

revoke all on function public.unlock_property(bigint, text), public.unlock_all(text) from public;
grant execute on function public.unlock_property(bigint, text), public.unlock_all(text) to anon, authenticated;
revoke all on function public._check_throttle(), public._log_attempt(boolean), public._client_id() from public;

-- ── show the new codes (only you see this result, in the SQL editor). The admin shows them too after step 2. ──
select p.id, p.title, a.code from public.property_access a join public.properties p on p.id = a.property_id order by p.id;
select value as master_code from public.access_secrets where key = 'master_code';
